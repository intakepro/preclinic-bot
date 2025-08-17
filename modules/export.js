/**
 * Module: modules/export.js
 * Version: v2025-08-17-02
 * 說明：匯出總結（佔位版）
 */
const { MessagingResponse } = require('twilio').twiml;

function reply({ twiml, res, text, flags }) {
  if (twiml) { twiml.message(text); return { replied: true, ...flags }; }
  const t = new MessagingResponse(); t.message(text);
  res.type('text/xml').send(t.toString());
  return { replied: true, ...flags };
}

async function handleExport({ req, res, msg, twiml }) {
  const body = (msg ?? req.body?.Body ?? '').toString().trim();
  if (!/^z$/i.test(body)) {
    return reply({
      twiml, res,
      text: '👉 Step 7：匯出總結（製作中）\n請按 z 完成流程。',
      flags: { wait: true }
    });
  }
  return reply({ twiml, res, text: '✅ 已匯出（佔位）。', flags: { done: true } });
}

module.exports = { handleExport };