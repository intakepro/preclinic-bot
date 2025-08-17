/**
 * Module: modules/auth.js
 * Version: v2025-08-17-02
 * 說明：病人問診權限檢查（佔位版）— 等待時回 wait:true，完成回 done:true
 */
const { MessagingResponse } = require('twilio').twiml;

function reply({ twiml, res, text, flags }) {
  if (twiml) { twiml.message(text); return { replied: true, ...flags }; }
  const t = new MessagingResponse(); t.message(text);
  res.type('text/xml').send(t.toString());
  return { replied: true, ...flags };
}

async function handleAuth({ req, res, msg, twiml }) {
  const body = (msg ?? req.body?.Body ?? '').toString().trim();
  // 這個佔位：提示「按 z 繼續」
  if (!/^z$/i.test(body)) {
    return reply({
      twiml, res,
      text: '👉 Step 2：病人問診權限檢查（製作中）\n請按 z 跳去下一步。',
      flags: { wait: true }          // 等待使用者
    });
  }
  return reply({ twiml, res, text: '✅ 已通過（佔位）。', flags: { done: true } });
}

module.exports = { handleAuth };