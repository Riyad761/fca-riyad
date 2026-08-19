<div align="center">

<img src="./banner.jpg" alt="fca-riyad banner" width="100%" />

# 💬 fca-riyad

### 🚀 The Ultimate Unofficial Facebook Messenger Bot API for Node.js
**NEXCA Engine · Signal Protocol · sessionGuard · 90+ API Methods**

<br>

<div align="center">
  <h1>
    <kbd> 🔒 E2EE SUPPORTED 🔒 </kbd>
  </h1>
  <h3>
    <b>Real End-to-End Encryption (Signal Protocol)</b><br>
    <i>Chat with absolute privacy, exactly like the official Messenger App!</i>
  </h3>
</div>

<br>

[![npm](https://img.shields.io/npm/v/fca-riyad?color=ff4785&label=npm&style=for-the-badge)](https://www.npmjs.com/package/fca-riyad)
[![license](https://img.shields.io/badge/license-MIT-9b59b6?style=for-the-badge)](./LICENSE-MIT)
[![node](https://img.shields.io/badge/node-%3E%3D18-2ecc71?style=for-the-badge)](https://nodejs.org)
[![E2EE](https://img.shields.io/badge/🔒_E2EE-SUPPORTED-00FF00?style=for-the-badge)](https://signal.org)

**[✨ Features](#-features)** · **[📦 Installation](#-installation)** · **[🚀 Quick Start](#-quick-start)** · **[🔐 E2EE](#-e2ee--encrypted-conversations)** · **[🛡️ sessionGuard](#-sessionguard)** · **[📡 sendBroadcast](#-sendbroadcast)** · **[📖 API Reference](#-api-reference)**

</div>

---

## 🔥 Why Developers are Switching to fca-riyad?

> 🚨 **STOP using outdated, broken FCA libraries!** 
> `fca-riyad` is engineered for the modern era. We solved the bugs others couldn't and added features everyone wanted.

| | |
|---|---|
| 🔒 | **<samp>E2EE SUPPORTED</samp>** — Full Signal Protocol integration! Your bot can now send & receive encrypted messages flawlessly. |
| ⚡ | **NEXCA Engine** — Ultra-stable MQTT, jitter, and autoReconnect. Zero downtime. |
| 🛡️ | **sessionGuard** — Say goodbye to silent logouts and corrupted appstates! It auto-saves and protects your sessions. |
| 📢 | **sendBroadcast** — Massive, rate-limited multi-thread broadcasting built-in. |
| 🛠️ | **Fixed Core Bugs** — "Connection refused: No subscription existed" and MQTT race conditions? **FIXED.** |
| ⚙️ | **RIYAD BOT Framework Native** — Drop-in ready, optional `threadID`, zero TypeScript bloat. |
| 🎯 | **90+ API Methods** — If Messenger can do it, `fca-riyad` can do it. Period. |

---

## ✨ Mind-Blowing Features

- 🔒 **True E2EE** — Signal Protocol encrypted threads (`connectE2EE`, `listenE2EE`, `e2ee.*`).
- 📡 **Full Messenger API** — messages, reactions, attachments, stickers, polls, pins, and more.
- 🚀 **NEXCA MQTT** — Rock-solid connection with `isActiveClient` guard.
- 🛡️ **sessionGuard** — appstate auto-save, corruption guard, and `.bak` backup.
- 📢 **sendBroadcast** — parallel/sequential multi-thread sending with smart rate limiting.
- 🤖 **MessengerBot** — Discord.js/Telegraf style `.command`, `.hears`, `.launch`.
- 🎯 **createFcaClient** — Clean namespaced facade (`client.messages`, `client.threads` etc.).
- 🤝 **RIYAD BOT Framework native** — Built-in, drop-in ready.

---

## 📦 Installation

```bash
npm install fca-riyad
```

> 🟢 **Node.js >= 18 required.**

---

## 🚀 Quick Start

### Classic (RIYAD BOT Framework)

```javascript
const login = require("fca-riyad");

login({ appState: require("./account.json") }, { listenEvents: true }, (err, api) => {
  if (err) throw err;

  api.sessionGuard("./account.json", {
    interval: 3 * 60 * 1000,
    debounce: 30 * 1000
  });

  api.listenMqtt((err, event) => {
    if (err) throw err;
    if (event.type === "message") api.sendMessage(event.body, event.threadID);
  });
});
```

### 🔐 With E2EE (Regular + Encrypted Threads)
*Unlock the power of true privacy!*

```javascript
login({ appState: require("./account.json") }, { listenEvents: true }, async (err, api) => {
  if (err) throw err;

  api.sessionGuard("./account.json");
  
  // 🚀 Initialize Signal Protocol E2EE
  await api.connectE2EE();

  api.listenE2EE((err, event) => {
    if (err) throw err;
    if (event.type === "message") {
      if (event.isE2EE) {
        api.e2ee.sendMessage(event.threadID, "Got your encrypted message! 🔒");
      } else {
        api.sendMessage("Got it!", event.threadID);
      }
    }
  });
});
```

### RIYAD BOT Framework login.js

```javascript
const login = require("fca-riyad");

login({ appState }, options, async (err, api) => {
  if (err) return;

  api.sessionGuard(path.join(process.cwd(), "account.txt"), {
    interval: 3 * 60 * 1000,
    debounce: 30 * 1000
  });

  try { await api.connectE2EE(); } catch (e) {}

  api.listenMqtt(callback);
});
```

---

## 🔒 E2EE — Encrypted Conversations

> Uses Facebook's real Signal Protocol infrastructure — **same as the official Messenger app.**

### Setup

```javascript
await api.connectE2EE();
// Auto-creates .nexca/e2ee_device.json

console.log(api.e2ee.isConnected()); // true
```

### Listen (Regular + E2EE Combined)

```javascript
api.listenE2EE((err, event) => {
  if (event.type === "message") {
    if (event.isE2EE) {
      api.e2ee.sendMessage(event.threadID, "Encrypted reply! 🔐");
    } else {
      api.sendMessage("Normal reply!", event.threadID);
    }
  }
});
```

### E2EE Methods

```javascript
await api.e2ee.sendMessage(threadID, "Hello!");
await api.e2ee.sendMessage(threadID, { body: "Photo!", attachment: fs.createReadStream("photo.jpg") });
await api.e2ee.sendReaction(threadID, messageID, "❤️");
await api.e2ee.sendTyping(threadID, true);
await api.e2ee.unsendMessage(messageID, threadID);
await api.e2ee.editMessage(threadID, messageID, "Updated!");
api.e2ee.isConnected();
await api.e2ee.disconnect();
```

---

## 🛡️ sessionGuard

> Protects your appstate from corruption and silent logouts. Never lose your session again!

```javascript
api.sessionGuard("./account.json");

// Custom timing
api.sessionGuard("./account.json", {
  interval: 3 * 60 * 1000,
  debounce: 30 * 1000
});
```

**What it does:**
- 🔄 Auto-saves appstate every N minutes
- 💾 Saves after every successful sendMessage (debounced)
- 🛡️ Corruption guard — never overwrites a larger appstate with a smaller one
- 📦 Auto-backup — writes `.bak` before every overwrite

```javascript
api.saveSession();           // force save now
api.restoreSessionBackup();  // restore from .bak
api.stopSessionGuard();      // stop the timer
```

---

## 📡 sendBroadcast

> Rate-limited multi-thread broadcast. Send to thousands without getting flagged.

```javascript
const result = await api.sendBroadcast(
  "Hello everyone!",
  ["THREAD_1", "THREAD_2", "THREAD_3"],
  {
    delay: 2000,
    parallel: 2,
    onEach: (err, info, id) => {
      console.log(err ? "Failed: " + id : "Sent: " + id);
    }
  }
);
console.log(result.sent.length + "/" + result.total + " delivered");
```

---

## 🤖 MessengerBot

> Discord.js/Telegraf style high-level bot class.

```javascript
const { createMessengerBot } = require("fca-riyad");

const bot = await createMessengerBot(
  { appState: require("./account.json") },
  { commandPrefix: "/", stopOnSignals: true }
);

bot.command("ping", async ctx => await ctx.replyAsync("pong 🏓"));
bot.hears(/hello/i, async ctx => await ctx.replyAsync("Hi! 👋"));
bot.on("messageCreate", event => console.log(event.body));

await bot.launch({ stopOnSignals: true });
```

---

## 🎯 createFcaClient

> Namespaced facade grouping all API methods by domain.

```javascript
const { createFcaClient } = require("fca-riyad");
const client = createFcaClient(api);

await client.messages.send("Hello!", threadID);
await client.messages.react("❤️", messageID, threadID);
await client.threads.getInfo(threadID);
await client.users.getInfo(userID);
await client.account.refreshDtsg();
```

---

## 📖 API Reference

<details>
<summary><b>💬 Sending Messages</b></summary>

```javascript
api.sendMessage("Hello!", threadID);
api.sendMessage({ body: "Photo!", attachment: fs.createReadStream("photo.jpg") }, threadID);
api.sendMessage({ body: "Hey @John", mentions: [{ id: "uid", tag: "@John", fromIndex: 4 }] }, threadID);
api.sendMessage({ sticker: "369239263222822" }, threadID);
api.sendMessage({ location: { latitude: 23.8, longitude: 90.4, current: true } }, threadID);
api.sendBroadcast("msg", ["tid1", "tid2"], { delay: 2000 });
api.sendGif("https://media.giphy.com/xyz.gif", threadID);
api.sendLocation(23.8, 90.4, threadID);
api.sendImage("./photo.jpg", threadID, "caption");
api.sendVideo("./video.mp4", threadID);
api.sendAudio("./voice.ogg", threadID);
api.sendFile("./doc.pdf", threadID);
api.shareLink("https://github.com", threadID, "Check this!");
api.shareContact("Meet my friend!", userID, threadID);
```
</details>

<details>
<summary><b>✏️ Message Actions</b></summary>

```javascript
api.editMessage("Updated text", messageID);
api.unsendMessage(messageID);
api.deleteMessage([messageID]);
api.setMessageReaction("😍", messageID, threadID);  // threadID optional
api.setMessageReaction("", messageID);               // remove reaction
api.getMessage(threadID, messageID);
api.forwardAttachment(attachmentID, [userID]);
api.uploadAttachment([fs.createReadStream("photo.jpg")]);
```
</details>

<details>
<summary><b>👁️ Read Receipts & Typing</b></summary>

```javascript
api.markAsRead(threadID);
api.markAsReadAll();
api.markAsDelivered(threadID, messageID);
api.markAsSeen();
api.sendTypingIndicator(threadID, true);
```
</details>

<details>
<summary><b>🧵 Thread Management</b></summary>

```javascript
api.getThreadInfo(threadID);
api.getThreadList(10, null, ["INBOX"]);
api.getThreadHistory(threadID, 20);
api.createGroup("Hey!", ["uid1", "uid2"]);
api.deleteThread(threadID);
api.muteThread(threadID, 3600);
api.changeArchivedStatus(threadID, true);
api.handleMessageRequest(threadID, true);
api.searchForThread("query");
```
</details>

<details>
<summary><b>🎨 Thread Customization</b></summary>

```javascript
api.setTitle("New Name", threadID);
api.changeThreadColor("#0084FF", threadID);
api.changeThreadEmoji("🔥", threadID);
api.changeNickname("The Boss", threadID, userID);
api.changeGroupImage(fs.createReadStream("group.jpg"), threadID);
api.changeAdminStatus(threadID, userID, true);
api.addUserToGroup(userID, threadID);
api.removeUserFromGroup(userID, threadID);
api.createPoll("Question?", threadID, { "Yes": false, "No": false });
api.pinMessage(messageID, threadID);
api.unpinMessage(messageID, threadID);
```
</details>

<details>
<summary><b>👤 User Info</b></summary>

```javascript
api.getUserInfo(userID);
api.getUserID("John Doe", callback);
api.getUID("https://facebook.com/zuck");
api.getFriendsList();
api.getAvatarUser(userID);
api.getProfileInfo(userID);
api.getPublicData(userID);
api.sendFriendRequest(userID);
api.handleFriendRequest(userID, true);
api.changeBlockedStatus(userID, true);
api.followUser(userID);
api.unfollowUser(userID);
api.unfriend(userID);
```
</details>

<details>
<summary><b>📢 Social</b></summary>

```javascript
api.reactToPost(postID, "love");
api.reactToComment(commentID, "haha");
api.postComment(postID, "Great post!");
api.sharePost(postID, "Check this!");
```
</details>

<details>
<summary><b>⚙️ Account & Config</b></summary>

```javascript
api.getCurrentUserID();
api.getAppState();
api.setOptions({ listenTyping: true });
api.logout();
api.refreshFb_dtsg();
api.addExternalModule("myFunc", (defaultFuncs, api, ctx) => {
  return function(text, threadID) {
    return api.sendMessage("[BOT] " + text, threadID);
  };
});
```
</details>

<details>
<summary><b>🌐 HTTP Utilities</b></summary>

```javascript
api.httpGet(url, params, callback);
api.httpPost(url, form, callback);
api.httpPostFormData(url, form, callback);
api.uploadImageToImgbb(imageUrl);
```
</details>

---

## 📋 Login Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `selfListen` | boolean | false | Receive your own sent messages |
| `listenEvents` | boolean | true | Receive thread/group events |
| `listenTyping` | boolean | false | Receive typing indicator events |
| `updatePresence` | boolean | false | Receive online/offline presence events |
| `autoMarkDelivery` | boolean | false | Auto-mark incoming messages as delivered |
| `autoMarkRead` | boolean | false | Auto-mark threads as read |
| `autoReconnect` | boolean | true | Auto-reconnect MQTT on disconnect |
| `online` | boolean | false | Appear as online to others |
| `emitReady` | boolean | false | Emit ready event when MQTT connected |
| `proxy` | string | — | HTTP proxy URL |
| `userAgent` | string | Safari UA | Override HTTP User-Agent |

---

## 📄 License

MIT License

**fca-riyad** by [Riyad](https://github.com/Riyad761)
NEXCA Engine by [Deku](https://github.com/dekuzxc) — MIT License

> 🚫 Unauthorized copying or redistribution without credit is strictly prohibited.

---

<div align="center">

Made with ❤️ & 🔒 by **Riyad**

</div>
