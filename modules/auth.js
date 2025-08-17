/**
 * Module: auth.js
 * Version: v1.0.0
 * 說明：病人問診權限檢查模組（佔位版）
 */

const { MessagingResponse } = require('twilio').twiml;

async function handleAuth({ req, res, from, msg }) {
  const twiml = new MessagingResponse();
  twiml.message('📌 這是病人問診權限檢查模組（製作中）。\n請稍候⋯⋯');
  res.type('text/xml').send(twiml.toString());

  return { replied: true, done: true };
}

module.exports = { handleAuth };