"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const Module = require("module");
const path = require("path");

function createFakeMqtt({ respond = true } = {}) {
  const client = new EventEmitter();
  client.published = [];
  client.publish = (topic, payload, options, callback) => {
    client.published.push({ topic, payload: JSON.parse(payload), options });
    callback?.(null);

    if (respond) {
      const request = client.published[client.published.length - 1].payload;
      process.nextTick(() => {
        client.emit("message", "/ls_resp", Buffer.from(JSON.stringify({
          request_id: request.request_id,
          payload: JSON.stringify({ step: [null, [null, [null, [null, { messageID: "ok", body: "ok" }]]]] }),
        })));
      });
    }
  };
  return client;
}

function loadFactory(relativePath, ctx) {
  const factory = require(path.join(__dirname, "..", relativePath));
  return factory({}, {}, ctx);
}

async function run() {
  const originalLoad = Module._load;
  Module._load = function loadWithoutLogger(request, parent, isMain) {
    if (request.includes("func/logAdapter")) {
      return { error() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const mqtt = createFakeMqtt();
  const ctx = { mqttClient: mqtt, wsReqNumber: 0, wsTaskNumber: 0, globalOptions: {} };
  const setTheme = loadFactory("src/api/messaging/setTheme.js", ctx);
  const setThreadTheme = loadFactory("src/api/messaging/setThreadTheme.js", ctx);
  const changeThreadColor = loadFactory("src/api/messaging/changeThreadColor.js", ctx);
  const changeNickname = loadFactory("src/api/messaging/changeNickname.js", ctx);

  const themeResult = await setTheme("thread-1", "theme-1");
  assert.deepStrictEqual(themeResult, { success: true, requests: 4 });
  assert.strictEqual(mqtt.published.length, 4);

  let callbackResult;
  await setThreadTheme("thread-1", "theme-2", (error, result) => {
    assert.ifError(error);
    callbackResult = result;
  });
  assert.deepStrictEqual(callbackResult, { success: true, requests: 4 });

  await changeThreadColor("theme-3", "thread-1");
  await changeNickname("Riyad", "thread-1", "user-1");
  Module._load = originalLoad;
  console.log("FCA Riyad compatibility checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});