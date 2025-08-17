/**
 * Module: profile.js
 * Version: v1.0.0
 * 說明：讀取病人資料模組（佔位版）
 */

const { MessagingResponse } = require('twilio').twiml;

async function handleProfile({ req, res, from, msg }) {
  const twiml = new MessagingResponse();
  twiml.message('📌 這是讀取病人資料模組（製作中）。\n請稍候⋯⋯');
  res.type('text/xml').send(twiml.toString());

  return { replied: true, done: true };
}

module.exports = { handleProfile };