"use strict";

const DEFAULT_TIMEOUT_MS = 15000;

function ensureCounters(ctx) {
  if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;
  if (typeof ctx.wsTaskNumber !== "number") ctx.wsTaskNumber = 0;
}

function nextRequestID(ctx) {
  ensureCounters(ctx);
  return ++ctx.wsReqNumber;
}

function nextTaskID(ctx) {
  ensureCounters(ctx);
  return ++ctx.wsTaskNumber;
}

function publish(client, topic, payload) {
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      typeof payload === "string" ? payload : JSON.stringify(payload),
      { qos: 1, retain: false },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function waitForResponse(client, requestID, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`MQTT request ${requestID} timed out`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      client.removeListener("message", onMessage);
    }

    function finish(error, response) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(response);
    }

    function onMessage(topic, message) {
      if (topic !== "/ls_resp") return;

      let response;
      try {
        response = JSON.parse(message.toString());
        if (typeof response.payload === "string") {
          response.payload = JSON.parse(response.payload);
        }
      } catch {
        return;
      }

      if (response.request_id !== requestID) return;

      const payload = response.payload;
      if (payload && (payload.error || payload.errors)) {
        finish(new Error(payload.error || "MQTT request failed"));
        return;
      }
      finish(null, payload);
    }

    client.on("message", onMessage);
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ensureCounters,
  nextRequestID,
  nextTaskID,
  publish,
  waitForResponse,
};