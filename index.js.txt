// index.js
const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const db = require('./firebase');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 當 Twilio 傳訊息過來時執行這個
app.post('/whatsapp', async (req, res) => {
  const msg = req.body.Body;
  const from = req.body.From;

  console.log(`收到來自 ${from} 的訊息：${msg}`);

  // 儲存到 Firebase
  await db.collection('patients').doc(from).set({
    lastMessage: msg,
    updatedAt: new Date()
  }, { merge: true });

  // 回覆病人
  const twiml = new MessagingResponse();
  twiml.message('✅ 已收到訊息，請繼續描述症狀，或輸入「完成」結束問診。');

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器已啟動，http://localhost:${PORT}`);
});
