"use strict";

const { generateOfflineThreadingID } = require("../../utils/format");
const {
  nextRequestID,
  nextTaskID,
  publish,
  waitForResponse,
} = require("../../utils/mqttRequest");

module.exports = (defaultFuncs, api, ctx) => {
  return function changeThreadColor(color, threadID, callback) {
    const execute = async () => {
      if (!ctx.mqttClient) {
        throw new Error("Not connected to MQTT");
      }
      if (!threadID || !color) {
        throw new Error("threadID and color are required");
      }

      const requestID = nextRequestID(ctx);
      const content = {
        app_id: "2220391788200892",
        payload: JSON.stringify({
          data_trace_id: null,
          epoch_id: Number.parseInt(generateOfflineThreadingID(), 10),
          tasks: [
            {
              failure_count: null,
              label: "43",
              payload: JSON.stringify({
                thread_key: threadID,
                theme_fbid: color,
                source: null,
                sync_group: 1,
                payload: null,
              }),
              queue_name: "thread_theme",
              task_id: nextTaskID(ctx),
            },
          ],
          version_id: "8798795233522156",
        }),
        request_id: requestID,
        type: 3,
      };

      const responsePromise = waitForResponse(ctx.mqttClient, requestID);
      await publish(ctx.mqttClient, "/ls_req", content);
      const response = await responsePromise;

      try {
        const messageID = response.step[1][2][2][1][2];
        const body = response.step[1][2][2][1][4];
        return { body, messageID };
      } catch {
        return { success: true };
      }
    };

    const result = execute();
    if (typeof callback !== "function") return result;

    result.then(
      (value) => callback(null, value),
      (error) => callback(error),
    );
    return result;
  };
};
