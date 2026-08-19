"use strict";

/**
 * Small, isolated ports from Maria FCA.
 *
 * This module deliberately does not touch MQTT, session creation, E2E, or
 * reconnect state. Each method uses the existing defaultFuncs transport and
 * follows the callback + Promise convention used by fca-unofficial.
 */
var utils = require("../utils");
var log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
  function callbackPromise(callback, resolveValue) {
    var resolveFunc;
    var rejectFunc;
    var promise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    var cb = typeof callback === "function"
      ? function (err, value) {
          if (err) return callback(err);
          callback(null, value);
        }
      : function (err, value) {
          if (err) return rejectFunc(err);
          resolveFunc(resolveValue ? resolveValue(value) : value);
        };
    return { promise: promise, callback: cb };
  }

  function graphForm(name, variables, docId) {
    return {
      av: ctx.userID,
      fb_dtsg: ctx.fb_dtsg || ctx.fb_dtsg_ag,
      jazoest: ctx.ttstamp || utils.getJazoest(ctx.fb_dtsg || ctx.fb_dtsg_ag),
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: name,
      variables: JSON.stringify(variables),
      server_timestamps: true,
      doc_id: String(docId)
    };
  }

  function postGraph(name, variables, docId, headers) {
    return defaultFuncs
      .post("https://www.facebook.com/api/graphql/", ctx.jar, graphForm(name, variables, docId), null, null, headers)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs));
  }

  function run(name, request, callback, transform) {
    var cp = callbackPromise(callback);
    request()
      .then(function (data) {
        if (data && (data.error || data.errors)) throw data;
        return cp.callback(null, transform ? transform(data) : data);
      })
      .catch(function (err) {
        log.error(name, err);
        return cp.callback(err);
      });
    return cp.promise;
  }

  function invalid(callback, message) {
    var error = new Error(message);
    if (typeof callback === "function") {
      callback(error);
      return new Promise(function () {});
    }
    return Promise.reject(error);
  }

  function searchStickers(query, callback) {
    query = query == null ? "" : String(query);
    return run("searchStickers", function () {
      return postGraph("StickersFlyoutTagSelectorQuery", {
        stickerWidth: 64,
        stickerHeight: 64,
        stickerInterface: "messages",
        query: query
      }, "4642836929159953");
    }, callback, function (res) {
      var edges = res && res.data && res.data.sticker_search &&
        res.data.sticker_search.sticker_results &&
        res.data.sticker_search.sticker_results.edges || [];
      return edges.map(function (edge) {
        var node = edge.node || {};
        return {
          id: node.id,
          image: node.image,
          package: node.pack ? { name: node.pack.name, id: node.pack.id } : {},
          label: node.label
        };
      });
    });
  }

  function searchFriends(searchQuery, callback) {
    if (typeof searchQuery !== "string" || !searchQuery.trim()) {
      return invalid(callback, "searchQuery must be a non-empty string");
    }
    return run("searchFriends", function () {
      return postGraph("ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery", {
        count: 20,
        cursor: null,
        scale: 1,
        search: searchQuery.trim(),
        id: "YXBwX2NvbGxlY3Rpb246cGZiaWQwMkJSM3NDeXRjNkJIeVVXem9OeUxNcjNoYnVDclRFZkdCcVlEaXZuSlZYOUNLR2pXVmRyYTQ4U29FalJTVzduMm03NlhDa0xEQXAybVVUenF6RXZraGc3ZHkyaGw="
      }, "31767020089578751");
    }, callback, function (res) {
      var edges = res && res.data && res.data.node && res.data.node.pageItems &&
        res.data.node.pageItems.edges || [];
      return edges.map(function (edge) {
        var friend = edge.node || {};
        var user = friend.node || friend;
        return {
          userID: user.id || friend.id,
          name: friend.title && friend.title.text || user.name || friend.name,
          profilePicture: friend.image && friend.image.uri || null,
          profileUrl: friend.url || user.url,
          subtitle: friend.subtitle_text && friend.subtitle_text.text || "",
          cursor: edge.cursor,
          friendshipStatus: user.friendship_status || "UNKNOWN",
          gender: user.gender || null,
          shortName: user.short_name || null
        };
      }).filter(function (friend) { return friend.userID && friend.name; });
    });
  }

  function changeName(input, format, callback) {
    if (typeof format === "function") {
      callback = format;
      format = "complete";
    }
    if (!input || typeof input !== "object") {
      return invalid(callback, "name must be an object");
    }
    var first = String(input.first_name || "");
    var middle = String(input.middle_name || "");
    var last = String(input.last_name || "");
    if (!first || !last) return invalid(callback, "first_name and last_name are required");
    var fullName = format === "reversed"
      ? first + " " + (middle ? middle + " " : "") + last
      : last + " " + (middle ? middle + " " : "") + first;
    return run("changeName", function () {
      return defaultFuncs.post("https://accountscenter.facebook.com/api/graphql/", ctx.jar,
        {
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: "useFXIMUpdateNameMutation",
          variables: JSON.stringify({
            client_mutation_id: utils.getGUID(),
            family_device_id: "device_id_fetch_datr",
            identity_ids: [ctx.userID],
            full_name: fullName,
            first_name: first,
            middle_name: middle,
            last_name: last,
            interface: "FB_WEB"
          }),
          server_timestamps: true,
          doc_id: "5763510853763960"
        }, null, null, {
          Origin: "https://accountscenter.facebook.com",
          Referer: "https://accountscenter.facebook.com/profiles/" + ctx.userID + "/name"
        }).then(utils.parseAndCheckLogin(ctx, defaultFuncs));
    }, callback, function () { return undefined; });
  }

  function changeUsername(username, callback) {
    if (typeof username !== "string" || !username.trim()) {
      return invalid(callback, "username must be a non-empty string");
    }
    return run("changeUsername", function () {
      return defaultFuncs.post("https://accountscenter.facebook.com/api/graphql/", ctx.jar,
        {
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: "useFXIMUpdateUsernameMutation",
          variables: JSON.stringify({
            client_mutation_id: utils.getGUID(),
            family_device_id: "device_id_fetch_datr",
            identity_ids: [ctx.userID],
            username: username.trim(),
            interface: "FB_WEB"
          }),
          server_timestamps: true,
          doc_id: "5737739449613305"
        }, null, null, {
          Origin: "https://accountscenter.facebook.com",
          Referer: "https://accountscenter.facebook.com/profiles/" + ctx.userID + "/username"
        }).then(utils.parseAndCheckLogin(ctx, defaultFuncs));
    }, callback, function () { return undefined; });
  }

  function changeCover(image, callback) {
    if (!utils.isReadableStream(image)) {
      return invalid(callback, "image must be a readable stream");
    }
    return run("changeCover", function () {
      return defaultFuncs.postFormData(
        "https://www.facebook.com/profile/picture/upload/",
        ctx.jar,
        { profile_id: ctx.userID, photo_source: 57, av: ctx.userID, file: image }
      ).then(utils.parseAndCheckLogin(ctx, defaultFuncs)).then(function (upload) {
        if (!upload || upload.error || upload.errors || !upload.payload || !upload.payload.fbid) {
          throw upload || new Error("Cover image upload failed");
        }
        return defaultFuncs.post(
          "https://www.facebook.com/api/graphql/",
          ctx.jar,
          {
            doc_id: "8247793861913071",
            server_timestamps: true,
            fb_api_req_friendly_name: "ProfileCometCoverPhotoUpdateMutation",
            variables: JSON.stringify({
              input: {
                cover_photo_id: upload.payload.fbid,
                focus: { x: 0.5, y: 1 },
                target_user_id: ctx.userID,
                actor_id: ctx.userID,
                client_mutation_id: utils.getGUID()
              },
              scale: 1,
              contextualProfileContext: null
            })
          }
        ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));
      });
    }, callback, function (res) {
      var user = res && res.data && res.data.user_update_cover_photo &&
        res.data.user_update_cover_photo.user;
      return user && user.cover_photo && user.cover_photo.photo &&
        user.cover_photo.photo.url || null;
    });
  }

  function setActiveStatus(active, callback) {
    active = !!active;
    return run("setActiveStatus", function () {
      return postGraph("WemPrivateSharingMutation", { enable: !active }, "9144138075685633");
    }, callback, function (res) {
      var result = res && res.data && res.data.toggle_wem_private_sharing_control_enabled;
      if (!result) throw new Error("Unable to update active status");
      return result;
    });
  }

  function setProfileLock(enable, callback) {
    enable = !!enable;
    return run("setProfileLock", function () {
      return postGraph("WemPrivateSharingMutation", { enable: !enable }, "9144138075685633");
    }, callback, function (res) {
      var result = res && res.data && res.data.toggle_wem_private_sharing_control_enabled;
      if (!result) throw new Error("Unable to update profile lock");
      return result;
    });
  }

  function sendFriendRequest(userID, callback) {
    if (!userID) return invalid(callback, "userID is required");
    return run("sendFriendRequest", function () {
      return postGraph("FriendingCometFriendRequestSendMutation", {
        input: {
          friend_requestee_id: String(userID),
          actor_id: String(ctx.userID),
          client_mutation_id: utils.getGUID()
        }
      }, "2975982599230964");
    }, callback, function () { return undefined; });
  }

  function suggestFriend(count, cursor, callback) {
    if (typeof count === "function") {
      callback = count;
      count = 10;
      cursor = null;
    } else if (typeof cursor === "function") {
      callback = cursor;
      cursor = null;
    }
    count = Number.isFinite(Number(count)) ? Math.max(1, Math.min(50, Number(count))) : 10;
    return run("suggestFriend", function () {
      return postGraph("FriendingCometPYMKPaginationQuery", {
        count: count,
        cursor: cursor || null,
        location: "FRIENDS_HOME_MAIN",
        scale: 3
      }, "9917809191634193");
    }, callback, function (res) {
      var list = res && res.data && res.data.viewer && res.data.viewer.people_you_may_know;
      if (!list) throw new Error("Invalid friend suggestion response");
      return {
        suggestions: (list.edges || []).map(function (edge) {
          var node = edge.node || {};
          return {
            id: node.id,
            name: node.name,
            url: node.url,
            friendshipStatus: node.friendship_status,
            profilePicture: node.profile_picture && node.profile_picture.uri || null,
            mutualFriends: node.social_context && node.social_context.text || "",
            topMutualFriends: node.social_context_top_mutual_friends || []
          };
        }),
        hasNextPage: !!(list.page_info && list.page_info.has_next_page),
        endCursor: list.page_info && list.page_info.end_cursor || null
      };
    });
  }

  return {
    searchStickers: searchStickers,
    searchFriends: searchFriends,
    changeName: changeName,
    changeUsername: changeUsername,
    changeCover: changeCover,
    setActiveStatus: setActiveStatus,
    setProfileLock: setProfileLock,
    sendFriendRequest: sendFriendRequest,
    suggestFriend: suggestFriend
  };
};