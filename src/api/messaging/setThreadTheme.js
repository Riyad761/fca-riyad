"use strict";

const setThemeFactory = require("./setTheme");

module.exports = function setThreadThemeFactory(defaultFuncs, api, ctx) {
  const setTheme = setThemeFactory(defaultFuncs, api, ctx);
  return function setThreadTheme(threadID, themeFBID, callback) {
    return setTheme(threadID, themeFBID, callback);
  };
};