"use strict";

const { generateOfflineThreadingID } = require("../../utils/format");
const log = require("../../../func/logAdapter");

module.exports = function (defaultFuncs, api, ctx) {
  return function changeNickname(nickname, threadID, participantID, callback) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        ctx.mqttClient?.removeListener("message", onResponse);
        if (error) {
          callback?.(error);
          reject(error);
          return;
        }
        callback?.(null, data);
        resolve(data);
      };

      const onResponse = (topic, message) => {
        if (topic !== "/ls_resp") return;
        let jsonMsg;
        try {
          jsonMsg = JSON.parse(message.toString());
          jsonMsg.payload = JSON.parse(jsonMsg.payload);
        } catch {
          return;
        }
        if (jsonMsg.request_id !== reqID) return;
        if (jsonMsg.payload?.error || jsonMsg.payload?.errors) {
          finish(new Error(jsonMsg.payload.error || "MQTT request failed"));
          return;
        }
        finish(null, { success: true, response: jsonMsg.payload });
      };

      if (!ctx.mqttClient) {
        finish(new Error("Not connected to MQTT"));
        return;
      }
      if (!threadID || !participantID) {
        finish(new Error("Missing required parameters"));
        return;
      }
      if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;
      if (typeof ctx.wsTaskNumber !== "number") ctx.wsTaskNumber = 0;
      const reqID = ++ctx.wsReqNumber;
      const taskID = ++ctx.wsTaskNumber;
      const payload = {
        epoch_id: generateOfflineThreadingID(),
        tasks: [
          {
            failure_count: null,
            label: "44",
            payload: JSON.stringify({
              thread_key: threadID,
              contact_id: participantID,
              nickname: nickname || "",
              sync_group: 1
            }),
            queue_name: "thread_participant_nickname",
            task_id: taskID
          }
        ],
        version_id: "8798795233522156"
      };
      const request = {
        app_id: "2220391788200892",
        payload: JSON.stringify(payload),
        request_id: reqID,
        type: 3
      };

      ctx.mqttClient.on("message", onResponse);
      timeout = setTimeout(() => {
        finish(new Error(`MQTT request ${reqID} timed out`));
      }, 15000);
      ctx.mqttClient.publish("/ls_req", JSON.stringify(request), { qos: 1, retain: false }, (err) => {
        if (err) {
          log.error("changeNicknameMqtt", err);
          finish(err);
        }
      });
    });
  };
};
