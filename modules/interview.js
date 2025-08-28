// modules/interview.js
// Version: v1.0.0
// 功能：作為問診模組的入口，目前只執行 location.js 模組

const { handleLocation } = require('./interview/location');

async function handleInterview({ from, msg, session, db }) {
  // 呼叫 location.js 模組，並傳入必要參數
  return await handleLocation({ from, msg, session, db });
}

module.exports = { handleInterview };