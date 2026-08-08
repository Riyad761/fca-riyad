"use strict";

/**
 * Native E2EE Bridge — backed by the precompiled `messagix` native binary
 * (ported from ST-FCA), instead of the buggy hand-written Signal/Noise
 * implementation in ./vendor/fb-e2ee.cjs.
 *
 * This version is wired to match EXACTLY what riyad-bot's
 * src/api/socket/listenE2EE.js and scripts/utils/messenger.js expect:
 *   - isConnected() method (listenE2EE checks this)
 *   - onMessage(callback) — callback(err, event)
 *   - emitted events use type: "message" / "message_reaction" (NOT custom
 *     type strings) so botEngine.processMessage() routes them exactly like
 *     normal MQTT messages — this is what makes replies/reactions/commands
 *     work automatically with zero changes needed on the riyad-bot side.
 *   - incoming attachments are downloaded + decrypted immediately (native
 *     binary requires mediaKey/directPath, there's no plain CDN URL for
 *     E2EE media) and served over a local loopback HTTP URL, because
 *     riyad-bot's commands generally expect attachment.url to be a normal
 *     fetchable URL.
 *   - outgoing sendMessage() now supports attachments (image/video/audio/
 *     document/sticker), not just plain text.
 *
 * Requires new dependencies in package.json: "koffi", "yumi-json-bigint".
 * Native binary + ESM wrapper live in ./native/ — do not separate
 * native/lib/index.mjs from native/build/ (index.mjs resolves the binary
 * at "../build/<platform-lib>" relative to itself).
 */

const path = require("path");
const fs = require("fs");
const urlMod = require("url");
const crypto = require("crypto");
const logger = require("../../../utils/nexca-logger");

let _dynamicImport = null;
function getDynamicImport() {
    if (!_dynamicImport) _dynamicImport = new Function("specifier", "return import(specifier);");
    return _dynamicImport;
}

const _NATIVE_LIB_URL = urlMod.pathToFileURL(
    path.join(__dirname, "native", "lib", "index.mjs")
).href;

async function loadNativeClient() {
    let mod;
    try {
        mod = await getDynamicImport()(_NATIVE_LIB_URL);
    } catch (err) {
        throw new Error(
            "Cannot load native E2EE bundle (" + _NATIVE_LIB_URL + "): " +
            (err && err.message ? err.message : String(err)) +
            "\nMake sure `koffi` and `yumi-json-bigint` are installed (npm install), and that " +
            "native/build/messagix.so (or .dll on Windows) is present next to native/lib/index.mjs."
        );
    }
    if (!mod || !mod.Client) {
        throw new Error("Native E2EE bundle loaded but no Client export was found.");
    }
    return mod.Client;
}

function cookiesFromJar(ctx) {
    const out = {};
    let jar = [];
    try {
        // tough-cookie's CookieJar#getCookies() is async/callback-based and
        // does NOT return an array synchronously — calling .forEach() on it
        // throws "jar.forEach is not a function" and aborts the whole E2EE
        // connect attempt every time. getCookiesSync() is the correct
        // synchronous accessor (same one src/utils/cookies.js already uses),
        // so prefer it and only fall back to getCookies() if it's missing.
        if (ctx && ctx.jar && typeof ctx.jar.getCookiesSync === "function") {
            jar = ctx.jar.getCookiesSync("https://www.facebook.com");
        } else if (ctx && ctx.jar && typeof ctx.jar.getCookies === "function") {
            jar = ctx.jar.getCookies("https://www.facebook.com");
        }
    } catch (_) {}
    if (Array.isArray(jar)) {
        jar.forEach((c) => { if (c && c.key) out[c.key] = c.value; });
    }
    if (!out.c_user && out.i_user) out.c_user = out.i_user;
    return out;
}

// ── local media cache dir + loopback URL, so decrypted E2EE media (which
// has no plain CDN URL) can still be handed to riyad-bot commands as a
// normal fetchable attachment.url ─────────────────────────────────────────
const MEDIA_CACHE_DIR = path.join(process.cwd(), "cache_e2ee");
function ensureMediaCacheDir() {
    try { fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true }); } catch (_) {}
}
function loopbackBase() {
    const port = process.env.PORT || 3000;
    return `http://127.0.0.1:${port}/e2ee-media`;
}
function extFromMime(mimeType) {
    if (!mimeType) return "bin";
    const map = {
        "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
        "video/mp4": "mp4", "video/3gpp": "3gp",
        "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
        "application/pdf": "pdf"
    };
    return map[mimeType] || (mimeType.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
}
function attachmentKind(mimeType) {
    if (!mimeType) return "file";
    if (mimeType.startsWith("image/")) return "photo";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "file";
}

async function downloadAndExposeAttachment(client, rawAtt) {
    try {
        const result = await client.downloadE2EEMedia({
            directPath: rawAtt.directPath,
            mediaKey: rawAtt.mediaKey,
            mediaSha256: rawAtt.mediaSha256,
            mediaEncSha256: rawAtt.mediaEncSha256,
            mediaType: rawAtt.type || rawAtt.mediaType,
            mimeType: rawAtt.mimeType,
            fileSize: rawAtt.fileSize
        });
        ensureMediaCacheDir();
        const ext = extFromMime(result.mimeType || rawAtt.mimeType);
        const filename = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
        const filePath = path.join(MEDIA_CACHE_DIR, filename);
        fs.writeFileSync(filePath, result.data);
        return {
            type: attachmentKind(result.mimeType || rawAtt.mimeType),
            mimeType: result.mimeType || rawAtt.mimeType,
            url: `${loopbackBase()}/${filename}`,
            filePath,
            filename,
            fileSize: result.fileSize || (result.data ? result.data.length : undefined),
            isE2EE: true
        };
    } catch (err) {
        logger.error("E2EE", "Failed to download/decrypt attachment:", err && err.message ? err.message : err);
        return {
            type: attachmentKind(rawAtt.mimeType),
            mimeType: rawAtt.mimeType,
            url: null,
            error: "download_failed",
            isE2EE: true
        };
    }
}

class NativeE2EEBridge {
    constructor(ctx, api, defaultFuncs) {
        this.ctx = ctx;
        this.api = api;
        this.defaultFuncs = defaultFuncs || null;
        this.client = null;
        this.connected = false;
        this._messageCallback = null;
        this._connectPromise = null;
        // messageID -> senderJid, so sendReaction() can react correctly
        // even when the caller only has a plain messageID (the generic
        // riyad-bot reaction API doesn't know about Signal-protocol JIDs).
        this._senderJidCache = new Map();
    }

    isConnected() {
        return !!(this.connected && this.client);
    }

    onMessage(callback) {
        this._messageCallback = callback;
    }

    async connect(deviceStorePath, userId) {
        if (this.connected && this.client) return { userId: this.ctx.userID };
        if (this._connectPromise) return this._connectPromise;

        this._connectPromise = this._doConnect(deviceStorePath, userId).catch((err) => {
            this._connectPromise = null;
            throw err;
        });
        return this._connectPromise;
    }

    async _doConnect(deviceStorePath, userId) {
        const Client = await loadNativeClient();

        const cookies = cookiesFromJar(this.ctx);
        if (!cookies.c_user || !cookies.xs) {
            throw new Error("Cannot start native E2EE: c_user/xs cookies missing from appState.");
        }

        const opts = {
            enableE2EE: true,
            e2eeMemoryOnly: false,
            autoReconnect: true,
            logLevel: "none"
        };
        if (deviceStorePath) opts.devicePath = deviceStorePath;

        this.client = new Client(cookies, opts);
        this._attachEvents();

        logger.info("E2EE", "Connecting via native engine (messagix)...");
        const result = await this.client.connect();
        this.connected = true;
        logger.info("E2EE", "Native E2EE bridge connected.");
        this._connectPromise = null;
        return { userId: (result && result.user && result.user.id) || userId || this.ctx.userID };
    }

    async _mapIncomingMessage(ev) {
        const text = ev && ev.text ? String(ev.text) : "";
        const senderJidRaw = ev.senderId != null ? String(ev.senderId) : "";
        const senderID = senderJidRaw.match(/^(\d+)/)?.[1] || senderJidRaw;
        const threadID = ev && ev.chatJid ? String(ev.chatJid) : (ev && ev.threadId != null ? String(ev.threadId) : "");
        const messageID = ev.id != null ? String(ev.id) : String(ev.id || Date.now());

        if (senderID) this._senderJidCache.set(messageID, ev.senderJid || senderJidRaw);

        let messageReply = null;
        if (ev.replyTo) {
            const rtId = ev.replyTo.messageId != null ? String(ev.replyTo.messageId) : (ev.replyTo.id != null ? String(ev.replyTo.id) : undefined);
            const rtSenderRaw = ev.replyTo.senderId != null && typeof ev.replyTo.senderId !== "object" ? String(ev.replyTo.senderId) : "";
            const rtSenderID = rtSenderRaw.match(/^(\d+)/)?.[1] || rtSenderRaw;
            messageReply = {
                messageID: rtId,
                senderID: rtSenderID,
                body: ev.replyTo.text != null ? String(ev.replyTo.text) : "",
                attachments: [],
                isE2EE: true
            };
        }

        let attachments = [];
        if (Array.isArray(ev.attachments) && ev.attachments.length && this.client) {
            attachments = await Promise.all(
                ev.attachments.map((a) => downloadAndExposeAttachment(this.client, a))
            );
        }

        return {
            type: "message",
            senderID,
            body: text,
            threadID,
            messageID,
            messageReply,
            attachments,
            mentions: {},
            timestamp: ev.timestampMs != null ? Number(ev.timestampMs) : Date.now(),
            isGroup: /@group\.facebook\.com$/i.test(ev.chatJid || ""),
            isE2EE: true,
            e2ee: { chatJid: ev.chatJid, senderJid: ev.senderJid || senderJidRaw, replyTo: ev.replyTo || null }
        };
    }

    _mapIncomingReaction(ev) {
        const messageID = ev.messageId != null ? String(ev.messageId) : (ev.id != null ? String(ev.id) : "");
        const senderJidRaw = ev.senderId != null ? String(ev.senderId) : "";
        const userID = senderJidRaw.match(/^(\d+)/)?.[1] || senderJidRaw;
        const threadID = ev.chatJid != null ? String(ev.chatJid) : (ev.threadId != null ? String(ev.threadId) : "");
        return {
            type: "message_reaction",
            messageID,
            threadID,
            userID,
            senderID: userID,
            reaction: ev.reaction || ev.emoji || "",
            timestamp: ev.timestampMs != null ? Number(ev.timestampMs) : Date.now(),
            isE2EE: true
        };
    }

    _attachEvents() {
        if (!this.client) return;

        this.client.on("e2eeMessage", async (ev) => {
            try {
                const mapped = await this._mapIncomingMessage(ev);
                if (typeof this._messageCallback === "function") {
                    this._messageCallback(null, mapped);
                }
            } catch (e) {
                logger.error("E2EE", "Failed to map incoming message:", e && e.message ? e.message : e);
            }
        });

        this.client.on("e2eeReaction", (ev) => {
            try {
                const mapped = this._mapIncomingReaction(ev);
                if (typeof this._messageCallback === "function") {
                    this._messageCallback(null, mapped);
                }
            } catch (e) {
                logger.error("E2EE", "Failed to map incoming reaction:", e && e.message ? e.message : e);
            }
        });

        this.client.on("e2eeConnected", () => {
            logger.info("E2EE", "Native engine reports e2eeConnected.");
        });

        this.client.on("error", (err) => {
            const msg = err && err.message ? err.message : String(err || "");
            if (/close 1006|unexpected EOF|ECONNRESET|ETIMEDOUT/i.test(msg)) {
                logger.warn("E2EE", "Transient native-engine network error (will auto-reconnect):", msg);
                return;
            }
            logger.error("E2EE", "Native engine error:", msg);
        });

        this.client.on("disconnected", (info) => {
            this.connected = false;
            logger.warn("E2EE", "Native E2EE bridge disconnected:", JSON.stringify(info || {}));
        });
    }

    // ── OUTGOING: text AND media ────────────────────────────────────────
    // `msg` can be:
    //   - a plain string (text)
    //   - { body, attachment }               (single stream/buffer, fca-style)
    //   - { body, attachments: [stream,...] } (multiple)
    async sendMessage(threadId, msg, replyToMessageId) {
        if (!this.client) throw new Error("Native E2EE bridge not connected.");

        const replyOpts = replyToMessageId ? {
            replyToId: replyToMessageId,
            replyToSenderJid: this._senderJidCache.get(replyToMessageId) || undefined
        } : {};

        if (typeof msg === "string") {
            return this.client.sendE2EEMessage(threadId, msg, replyOpts);
        }

        const body = (msg && msg.body) || "";
        const rawAttachments = [];
        if (msg && msg.attachment) rawAttachments.push(msg.attachment);
        if (msg && Array.isArray(msg.attachments)) rawAttachments.push(...msg.attachments);

        if (rawAttachments.length === 0) {
            return this.client.sendE2EEMessage(threadId, body, replyOpts);
        }

        const results = [];
        for (const att of rawAttachments) {
            const buffer = await streamOrPathToBuffer(att);
            const mimeType = guessMimeType(att, buffer);
            const opts = { caption: body || undefined, ...replyOpts };

            if (mimeType.startsWith("image/")) {
                results.push(await this.client.sendE2EEImage(threadId, buffer, mimeType, opts));
            } else if (mimeType.startsWith("video/")) {
                results.push(await this.client.sendE2EEVideo(threadId, buffer, mimeType, opts));
            } else if (mimeType.startsWith("audio/")) {
                results.push(await this.client.sendE2EEAudio(threadId, buffer, mimeType, opts));
            } else {
                const filename = (att && att.path && path.basename(att.path)) || "file";
                results.push(await this.client.sendE2EEDocument(threadId, buffer, filename, mimeType, opts));
            }
        }
        return results[0];
    }

    async sendReaction(threadId, messageId, reaction, senderJid) {
        if (!this.client) throw new Error("Native E2EE bridge not connected.");
        const jid = senderJid || this._senderJidCache.get(messageId) || "";
        return this.client.sendE2EEReaction(threadId, messageId, jid, reaction);
    }

    async sendTyping(threadId, isTyping) {
        if (!this.client) return;
        return this.client.sendE2EETyping(threadId, isTyping !== false).catch(() => {});
    }

    async unsendMessage(messageId, threadId) {
        if (!this.client) throw new Error("Native E2EE bridge not connected.");
        return this.client.unsendE2EEMessage(threadId, messageId);
    }

    async editMessage(threadId, messageId, newText) {
        if (!this.client) throw new Error("Native E2EE bridge not connected.");
        return this.client.editE2EEMessage(threadId, messageId, newText);
    }

    async disconnect() {
        if (this.client) {
            try { await this.client.disconnect(); } catch (_) {}
        }
        this.connected = false;
        this.client = null;
        this._connectPromise = null;
    }
}

// ── helpers for outgoing attachments ────────────────────────────────────
function streamOrPathToBuffer(att) {
    return new Promise((resolve, reject) => {
        if (Buffer.isBuffer(att)) return resolve(att);
        if (att && typeof att.path === "string") {
            return fs.readFile(att.path, (err, data) => err ? reject(err) : resolve(data));
        }
        if (att && typeof att.pipe === "function") {
            const chunks = [];
            att.on("data", (c) => chunks.push(c));
            att.on("end", () => resolve(Buffer.concat(chunks)));
            att.on("error", reject);
            return;
        }
        reject(new Error("Unsupported attachment type for E2EE send — expected Buffer, fs.ReadStream, or {path}."));
    });
}

function guessMimeType(att, buffer) {
    const extMap = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
        ".mp4": "video/mp4", ".3gp": "video/3gpp",
        ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac",
        ".pdf": "application/pdf"
    };
    const p = (att && att.path) || "";
    const ext = path.extname(p).toLowerCase();
    if (extMap[ext]) return extMap[ext];

    // Sniff from magic bytes as a fallback
    if (buffer && buffer.length > 4) {
        const b = buffer;
        if (b[0] === 0xFF && b[1] === 0xD8) return "image/jpeg";
        if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
        if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
        if (b.slice(4, 8).toString("ascii") === "ftyp") return "video/mp4";
        if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg"; // ID3
        if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67) return "audio/ogg"; // OggS
    }
    return "application/octet-stream";
}

module.exports = { E2EEBridge: NativeE2EEBridge, NativeE2EEBridge, MEDIA_CACHE_DIR };
