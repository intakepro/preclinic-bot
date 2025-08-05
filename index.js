// index.js
const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 當 Twilio 傳訊息過來時執行這個
app.post('/whatsapp', (req, res) => {
  const msg = req.body.Body;
  const from = req.body.From;

  console.log(`✅ 收到訊息：「${msg}」來自 ${from}`);

  const twiml = new MessagingResponse();
  twiml.message('✅ 訊息已收到，謝謝！');

  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 機器人已啟動於 http://localhost:${PORT}`);
});
