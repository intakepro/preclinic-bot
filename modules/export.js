/**
 * Module: modules/export.js
 * Version: v2025-08-17-01
 * Date: 2025-08-17
 * 說明：
 * - 佔位模組（Step 7：匯出總結模組）
 * - 輸入 z / Z 會回傳 {replied:true, autoNext:true}，通常代表流程完成或進入結尾
 * - 其他輸入則顯示佔位訊息，autoNext:false
 * - 支援 twiml 直寫模式（若傳入 twiml，則不自行 res.send()）
 */

const { MessagingResponse } = require('twilio').twiml;

function reply({ twiml, res, text, autoNext = false }) {
  if (twiml) {
    twiml.message(text);
    return { replied: true, autoNext };
  }
  const tw = new MessagingResponse();
  tw.message(text);
  res.type('text/xml').send(tw.toString());
  return { replied: true, autoNext };
}

async function handleExport({ req, res, from, msg, twiml }) {
  const body = (msg ?? req.body?.Body ?? '').toString().trim();
  if (/^z$/i.test(body)) {
    return reply({ twiml, res, text: '✅ 已按 z，跳去下一步（流程結束）。', autoNext: true });
  }
  const lines = [
    '你好，這是什麼模組？👉 Step 7：匯出總結模組',
    '該模組製作中。',
    '請按 z 跳去下一步。'
  ].join('\n');
  return reply({ twiml, res, text: lines });
}

module.exports = { handleExport };