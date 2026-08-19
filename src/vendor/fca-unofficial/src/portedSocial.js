"use strict";

/**
 * Isolated social API ports. They only use the existing Riyad HTTP transport;
 * MQTT, reconnect, login, cookies, and E2E are intentionally out of scope.
 */
var utils = require("../utils");
var log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
  function promiseCallback(callback) {
    var resolveFunc;
    var rejectFunc;
    var promise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    var cb = typeof callback === "function"
      ? callback
      : function (err, value) {
          if (err) rejectFunc(err);
          else resolveFunc(value);
        };
    return {
      promise: promise,
      done: function (value) { cb(null, value); },
      fail: function (error) { cb(error); }
    };
  }

  function postGraph(name, variables, docId) {
    return defaultFuncs.post(
      "https://www.facebook.com/api/graphql/",
      ctx.jar,
      {
        av: ctx.userID,
        fb_dtsg: ctx.fb_dtsg || ctx.fb_dtsg_ag,
        jazoest: ctx.ttstamp || utils.getJazoest(ctx.fb_dtsg || ctx.fb_dtsg_ag),
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: name,
        variables: JSON.stringify(variables),
        server_timestamps: true,
        doc_id: String(docId)
      }
    ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));
  }

  function run(name, request, callback, transform) {
    var cp = promiseCallback(callback);
    request().then(function (res) {
      if (!res || res.error || res.errors) throw res || new Error(name + " failed");
      cp.done(transform ? transform(res) : res);
    }).catch(function (err) {
      log.error(name, err);
      cp.fail(err);
    });
    return cp.promise;
  }

  function reactionValue(value) {
    var map = { unlike: 0, like: 1, heart: 2, love: 16, haha: 4, wow: 3, sad: 7, angry: 8 };
    if (typeof value === "string") value = map[value.toLowerCase()];
    if (typeof value !== "number" || value < 0 || !Number.isFinite(value)) {
      throw new Error("Invalid reaction type");
    }
    return value;
  }

  function setPostReaction(postID, type, callback) {
    if (typeof type === "function") {
      callback = type;
      type = 0;
    }
    if (!postID) return Promise.reject(new Error("postID is required"));
    var reaction = reactionValue(type);
    return run("setPostReaction", function () {
      return postGraph("CometUFIFeedbackReactMutation", {
        input: {
          actor_id: ctx.userID,
          feedback_id: Buffer.from("feedback:" + postID).toString("base64"),
          feedback_reaction: reaction,
          feedback_source: "OBJECT",
          is_tracking_encrypted: true,
          tracking: [],
          session_id: utils.getGUID(),
          client_mutation_id: utils.getGUID()
        },
        useDefaultActor: false,
        scale: 3
      }, "4769042373179384");
    }, callback, function (res) {
      var data = res.data && res.data.feedback_react;
      return data ? {
        viewer_feedback_reaction_info: data.feedback.viewer_feedback_reaction_info,
        supported_reactions: data.feedback.supported_reactions,
        top_reactions: data.feedback.top_reactions && data.feedback.top_reactions.edges || [],
        reaction_count: data.feedback.reaction_count
      } : res;
    });
  }

  function normalizeMessage(message) {
    if (typeof message === "string") return { body: message };
    if (!message || typeof message !== "object") throw new Error("Post message must be a string or object");
    return message;
  }

  function createPost(message, callback) {
    var msg;
    try { msg = normalizeMessage(message); } catch (error) { return Promise.reject(error); }
    var sessionID = utils.getGUID();
    var input = {
      composer_entry_point: "inline_composer",
      composer_source_surface: msg.groupID ? "group" : "timeline",
      composer_type: msg.groupID ? "group" : "timeline",
      idempotence_token: sessionID + "_FEED",
      source: "WWW",
      attachments: [],
      audience: msg.groupID ? { to_id: msg.groupID } : {
        privacy: { allow: [], base_state: "EVERYONE", deny: [], tag_expansion_state: "UNSPECIFIED" }
      },
      message: { ranges: [], text: msg.body ? String(msg.body) : "" },
      with_tags_ids: [],
      inline_activities: [],
      explicit_place_id: 0,
      text_format_preset_id: 0,
      logging: { composer_session_id: sessionID },
      navigation_data: { attribution_id_v2: "ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,via_cold_start," + Date.now() },
      is_tracking_encrypted: false,
      tracking: [],
      event_share_metadata: { surface: "newsfeed" },
      actor_id: ctx.globalOptions && ctx.globalOptions.pageID || ctx.userID,
      client_mutation_id: utils.getGUID()
    };
    return run("createPost", function () {
      return postGraph("ComposerStoryCreateMutation", {
        input: input,
        displayCommentsFeedbackContext: null,
        displayCommentsContextEnableComment: null,
        displayCommentsContextIsAdPreview: false
      }, "6255089511280268");
    }, callback, function (res) {
      return res.data && res.data.story_create ? res.data.story_create : res;
    });
  }

  function createCommentPost(postID, message, callback) {
    if (typeof message === "function") {
      callback = message;
      message = "";
    }
    if (!postID) return Promise.reject(new Error("postID is required"));
    return run("createCommentPost", function () {
      return postGraph("CometUFICreateCommentMutation", {
        input: {
          actor_id: ctx.userID,
          attachments: [],
          feedback_id: Buffer.from("feedback:" + postID).toString("base64"),
          message: { ranges: [], text: message == null ? "" : String(message) },
          reply_comment_parent_fbid: null,
          reply_target_clicked: false,
          feedback_source: "NEWS_FEED",
          idempotence_token: "client:" + utils.getGUID(),
          session_id: utils.getGUID()
        },
        useDefaultActor: false,
        focusCommentID: null
      }, "6993516810709754");
    }, callback, function (res) {
      return res.data && (res.data.comment_create || res.data.feedback_comment_create) || res;
    });
  }

  function setStoryReaction(storyID, reaction, callback) {
    if (typeof reaction === "function") {
      callback = reaction;
      reaction = "❤️";
    }
    if (!storyID) return Promise.reject(new Error("storyID is required"));
    var value = reactionValue(reaction === "❤️" || reaction === "love" ? "love" : reaction);
    var emoji = { 1: "👍", 2: "❤️", 3: "😆", 4: "😆", 7: "😢", 8: "😡", 16: "❤️" }[value] || String(reaction);
    return run("setStoryReaction", function () {
      return postGraph("useStoriesSendReplyMutation", {
        input: {
          lightweight_reaction_actions: { offsets: [0], reaction: emoji },
          message: emoji,
          story_id: String(storyID),
          story_reply_type: "LIGHT_WEIGHT",
          actor_id: ctx.userID,
          client_mutation_id: utils.getGUID()
        }
      }, "9697491553691692");
    }, callback, function (res) {
      return { success: true, story_id: String(storyID), reaction: emoji, response: res };
    });
  }

  function setStorySeen(storyID, bucketID, callback) {
    if (typeof bucketID === "function") {
      callback = bucketID;
      bucketID = storyID;
    }
    if (!storyID) return Promise.reject(new Error("storyID is required"));
    return run("setStorySeen", function () {
      return postGraph("storiesUpdateSeenStateMutation", {
        input: {
          bucket_id: bucketID || storyID,
          story_id: storyID,
          actor_id: ctx.userID,
          client_mutation_id: utils.getGUID()
        },
        scale: 1
      }, "9567413276713742");
    }, callback, function (res) {
      return { success: true, story_id: storyID, bucket_id: bucketID || storyID, response: res };
    });
  }

  return {
    setPostReaction: setPostReaction,
    createPost: createPost,
    createCommentPost: createCommentPost,
    setStoryReaction: setStoryReaction,
    setStorySeen: setStorySeen
  };
};