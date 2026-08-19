"use strict";

const { generateOfflineThreadingID } = require("../../utils/format");
const {
  nextRequestID,
  nextTaskID,
  publish,
} = require("../../utils/mqttRequest");

const APP_ID = "772021112871879";
const VERSION_ID = "24227364673632991";

function createThemeRequest(ctx, threadID, themeFBID, label, queueName, extraPayload) {
  const taskID = nextTaskID(ctx);
  const requestID = nextRequestID(ctx);
  const taskPayload = {
    thread_key: String(threadID),
    theme_fbid: String(themeFBID),
    sync_group: 1,
    ...(extraPayload || {}),
  };

  return {
    requestID,
    message: {
      app_id: APP_ID,
      payload: JSON.stringify({
        epoch_id: Number.parseInt(generateOfflineThreadingID(), 10),
        tasks: [
          {
            failure_count: null,
            label: String(label),
            payload: JSON.stringify(taskPayload),
            queue_name: Array.isArray(queueName)
              ? JSON.stringify(queueName)
              : queueName,
            task_id: taskID,
          },
        ],
        version_id: VERSION_ID,
      }),
      request_id: requestID,
      type: 3,
    },
  };
}

module.exports = function setThemeFactory(defaultFuncs, api, ctx) {
  return function setTheme(threadID, themeFBID, callback) {
    const execute = async () => {
      if (!ctx.mqttClient) {
        throw new Error("Not connected to MQTT");
      }
      if (!threadID || !themeFBID) {
        throw new Error("threadID and themeFBID are required");
      }

      const requests = [
        createThemeRequest(ctx, threadID, themeFBID, 1013, [
          "ai_generated_theme",
          String(threadID),
        ]),
        createThemeRequest(ctx, threadID, themeFBID, 1037, [
          "msgr_custom_thread_theme",
          String(threadID),
        ]),
        createThemeRequest(ctx, threadID, themeFBID, 1028, [
          "thread_theme_writer",
          String(threadID),
        ]),
        createThemeRequest(
          ctx,
          threadID,
          themeFBID,
          43,
          "thread_theme",
          { source: null, payload: null },
        ),
      ];

      for (const request of requests) {
        await publish(ctx.mqttClient, "/ls_req", request.message);
      }

      return { success: true, requests: requests.length };
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