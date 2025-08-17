/**
 * Module: modules/interview.js
 * Version: v2025-08-17-02
 * 說明：問診系統（佔位版）
 */
const { MessagingResponse } = require('twilio').twiml;

function reply({ twiml, res, text, flags }) {
  if (twiml) { twiml.message(text); return { replied: true, ...flags }; }
  const t = new MessagingResponse(); t.message(text);
  res.type('text/xml').send(t.toString());
  return { replied: true, ...flags };
}

async function handleInterview({ req, res, msg, twiml }) {
  const body = (msg ?? req.body?.Body ?? '').toString().trim();
  if (!/^z$/i.test(body)) {
    return reply({
      twiml, res,
      text: '👉 Step 5：問診系統（製作中）\n請按 z 跳去下一步。',
      flags: { wait: true }
    });
  }
  return reply({ twiml, res, text: '✅ 問診流程（佔位）已完成。', flags: { done: true } });
}

module.exports = { handleInterview };