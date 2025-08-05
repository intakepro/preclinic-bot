const express = require('express');
const app = express();
const PORT = 3000;

const userState = {};

app.use(express.urlencoded({ extended: false }));

app.post('https://predoctor.onrender.com/whatsapp', (req, res) => {
  const from = req.body.From;
  const body = req.body.Body.trim();
  let replyMsg = '';

  if (body === '1') {
    replyMsg = '你選擇了選項 A';
  } else if (body === '2') {
    replyMsg = '你選擇了選項 B';
  } else if (body === '3') {
    replyMsg = '你選擇了選項 C';
  } else {
    replyMsg = '請輸入數字 1、2 或 3。';
  }

  const twiml = `
    <Response>
      <Message>${replyMsg}</Message>
    </Response>
  `;

  res.type('text/xml');
  res.send(twiml);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});







