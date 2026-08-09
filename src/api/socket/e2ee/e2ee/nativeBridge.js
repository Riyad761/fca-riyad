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

async function cookiesFromJar(ctx) {
    const out = {};
    let jar = [];
    try {
        if (ctx && ctx.jar && typeof ctx.jar.getCookiesSync === "function") {
            jar = ctx.jar.getCookiesSync("https://www.facebook.com");
        } else if (ctx && ctx.jar && typeof ctx.jar.getCookies === "function") {
            jar = await ctx.jar.getCookies("https://www.facebook.com");
        }
    } catch (_) {}
    if (Array.isArray(jar)) {
        jar.forEach((c) => {
            if (c && (c.key || c.name)) out[c.key || c.name] = c.value;
        });
    } else if (jar && typeof jar === "object") {
        for (const [key, value] of Object.entries(jar)) {
            if (value != null && typeof value !== "object") out[key] = String(value);
        }
    }
    if (!out.c_user && out.i_user) out.c_user = out.i_user;
    return out;
}

function normalizeJid(value) {
    return value == null ? "" : String(value);
}

function numericId(value) {
    const jid = normalizeJid(value);
    return jid.match(/^(\d+)/)?.[1] || jid;
}

function readMessageText(ev) {
    const value = ev && (ev.text ?? ev.body ?? ev.message ?? ev.content);
    return value == null ? "" : String(value);
}

function readChatId(ev) {
    const value = ev && (ev.chatJid ?? ev.threadId ?? ev.threadID ?? ev.chatId);
    return value == null ? "" : String(value);
}

function readMessageId(ev) {
    const value = ev && (ev.id ?? ev.messageId ?? ev.messageID);
    return value == null ? String(Date.now()) : String(value);
}

function readSenderJid(ev) {
    return normalizeJid(ev && (ev.senderId ?? ev.senderID ?? ev.from ?? ""));
}

function readAttachmentList(value) {
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
}

function readReplySenderId(replyTo) {
    const value = replyTo && (replyTo.senderId ?? replyTo.senderID ?? replyTo.from);
    return value != null && typeof value !== "object" ? numericId(value) : "";
}

function readReplyText(replyTo) {
    if (!replyTo) return "";
    const value = replyTo.text ?? replyTo.body;
    return value == null ? "" : String(value);
}

function isGroupChat(threadID, ev) {
    return !!(ev && ev.isGroup) || /(@g\.us|\.g\.|@group\.facebook\.com)$/i.test(threadID);
}

function mapReply(ev) {
    if (!ev || !ev.replyTo) return null;
    const value = ev.replyTo.messageId ?? ev.replyTo.messageID ?? ev.replyTo.id;
    return {
        messageID: value != null ? String(value) : undefined,
        senderID: readReplySenderId(ev.replyTo),
        body: readReplyText(ev.replyTo),
        attachments: [],
        isE2EE: true
    };
}

function mapReactionMessageId(ev) {
    const value = ev && (ev.messageId ?? ev.messageID ?? ev.id);
    return value == null ? "" : String(value);
}

function mapReactionChatId(ev) {
    return readChatId(ev);
}

function mapReactionSenderId(ev) {
    return numericId(ev && (ev.senderId ?? ev.senderID ?? ev.from ?? ""));
}

function mapReactionValue(ev) {
    return ev && (ev.reaction ?? ev.emoji ?? "") || "";
}

function normalizeAttachmentMime(att) {
    if (att && typeof att.mimeType === "string" && att.mimeType.includes("/")) {
        return att.mimeType;
    }
    if (att && typeof att.type === "string" && att.type.includes("/")) {
        return att.type;
    }
    return null;
}

function mapIncomingMentions(ev) {
    const source = ev && (ev.mentions ?? ev.mentionMap ?? ev.mentionedUsers);
    const mentions = {};
    if (Array.isArray(source)) {
        for (const mention of source) {
            if (!mention) continue;
            const id = mention.id ?? mention.userId ?? mention.userID;
            if (id != null) {
                mentions[String(id)] = mention.text ?? mention.tag ?? mention.name ?? `@${id}`;
            }
        }
    } else if (source && typeof source === "object") {
        for (const [id, value] of Object.entries(source)) {
            mentions[String(id)] = typeof value === "string"
                ? value
                : (value && (value.text ?? value.tag ?? value.name)) || `@${id}`;
        }
    }
    return mentions;
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
        const textValue = ev && (ev.text ?? ev.body ?? ev.message ?? ev.content);
        const text = textValue != null ? String(textValue) : "";
        const senderJidRaw = String(ev && (ev.senderId ?? ev.senderID ?? ev.from ?? ""));
        const senderJid = senderJidRaw;
        const senderID = senderJidRaw.match(/^(\d+)/)?.[1] || senderJidRaw;
        const chatValue = ev && (ev.chatJid ?? ev.threadId ?? ev.threadID ?? ev.chatId);
        const threadID = chatValue != null ? String(chatValue) : "";
        const messageValue = ev && (ev.id ?? ev.messageId ?? ev.messageID);
        const messageID = messageValue != null ? String(messageValue) : String(Date.now());

        if (senderID) this._senderJidCache.set(messageID, ev.senderJid || senderJid);

        let messageReply = null;
        if (ev.replyTo) {
            const rtIdValue = ev.replyTo.messageId ?? ev.replyTo.messageID ?? ev.replyTo.id;
            const rtId = rtIdValue != null ? String(rtIdValue) : undefined;
            const rtSenderValue = ev.replyTo.senderId ?? ev.replyTo.senderID ?? ev.replyTo.from;
            const rtSenderRaw = rtSenderValue != null && typeof rtSenderValue !== "object"
                ? String(rtSenderValue)
                : "";
            const rtSenderID = rtSenderRaw.match(/^(\d+)/)?.[1] || rtSenderRaw;
            messageReply = {
                messageID: rtId,
                senderID: rtSenderID,
                body: ev.replyTo.text != null
                    ? String(ev.replyTo.text)
                    : (ev.replyTo.body != null ? String(ev.replyTo.body) : ""),
                attachments: [],
                isE2EE: true
            };
        }

        let attachments = [];
        const rawAttachments = Array.isArray(ev && ev.attachments)
            ? ev.attachments
            : (ev && ev.attachment ? [ev.attachment] : []);
        if (rawAttachments.length && this.client) {
            attachments = await Promise.all(
                rawAttachments.map((a) => downloadAndExposeAttachment(this.client, a))
            );
        }

        if (messageReply && this.client) {
            const rawReplyAttachments = Array.isArray(ev.replyTo.attachments)
                ? ev.replyTo.attachments
                : (ev.replyTo.attachment ? [ev.replyTo.attachment] : []);
            if (rawReplyAttachments.length) {
                messageReply.attachments = await Promise.all(
                    rawReplyAttachments.map((a) => downloadAndExposeAttachment(this.client, a))
                );
            }
        }

        return {
            type: messageReply ? "message_reply" : "message",
            senderID,
            body: text,
            threadID,
            messageID,
            messageReply,
            attachments,
            mentions: mapIncomingMentions(ev),
            timestamp: ev.timestampMs != null ? Number(ev.timestampMs) : Date.now(),
            isGroup: !!ev.isGroup || /(@g\.us|\.g\.|@group\.facebook\.com)$/i.test(threadID),
            isE2EE: true,
            e2ee: { chatJid: threadID, senderJid: ev.senderJid || senderJid, replyTo: ev.replyTo || null }
        };
    }

    _mapIncomingReaction(ev) {
        const messageValue = ev.messageId ?? ev.messageID ?? ev.id;
        const messageID = messageValue != null ? String(messageValue) : "";
        const senderValue = ev.senderId ?? ev.senderID ?? ev.from ?? "";
        const senderJidRaw = String(senderValue);
        const userID = senderJidRaw.match(/^(\d+)/)?.[1] || senderJidRaw;
        const chatValue = ev.chatJid ?? ev.threadId ?? ev.threadID ?? ev.chatId;
        const threadID = chatValue != null ? String(chatValue) : "";
        return {
            type: "message_reaction",
            messageID,
            threadID,
            userID,
            senderID: userID,
            reaction: ev.reaction ?? ev.emoji ?? "",
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
        if (msg && Array.isArray(msg.attachment)) rawAttachments.push(...msg.attachment);
        else if (msg && msg.attachment) rawAttachments.push(msg.attachment);
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
    if (att && typeof att.mimeType === "string" && att.mimeType.includes("/")) {
        return att.mimeType;
    }
    if (att && typeof att.type === "string" && att.type.includes("/")) {
        return att.type;
    }
    const p = (att && (att.path || att.filename || att.name)) || "";
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
