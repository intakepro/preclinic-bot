// index.js
// Version: v6.2.0-fs
// 說明：Firestore 版流程控制；模組完成(done:true)後，立即進入下一模組並回覆其提示
// 依賴：firebase-admin、twilio、express、body-parser

'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// ===== Firebase 初始化（FIREBASE_SERVICE_ACCOUNT 或預設憑證）=====
(function ensureFirebase() {
  if (admin.apps.length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[index] Firebase initialized via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp();
      console.log('[index] Firebase initialized via default credentials');
    }
  } catch (e) {
    console.error('[index] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

// ===== 模組處理器 =====
const { handleNameInput } = require('./modules/name_input');
const { handleAuth }      = require('./modules/auth');
const { handleProfile }   = require('./modules/profile');
const { handleHistory }   = require('./modules/history');
const { handleInterview } = require('./modules/interview');
const { handleAiSummar }  = require('./modules/ai_summar');
const { handleExport }    = require('./modules/export');

// ===== 步驟表（1..7）=====
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組', handler: handleNameInput },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組', handler: handleAuth },
  { id: 3, key: 'profile',    name: '讀取病人資料模組',     handler: handleProfile },
  { id: 4, key: 'history',    name: '讀取病人病史模組',     handler: handleHistory },
  { id: 5, key: 'interview',  name: '問診系統模組',         handler: handleInterview },
  { id: 6, key: 'ai_summar',  name: 'AI 整理模組',          handler: handleAiSummar },
  { id: 7, key: 'export',     name: '匯出總結模組',          handler: handleExport },
];

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ===== Firestore Session I/O =====
const userKey = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';

async function getStep(from) {
  const key = userKey(from);
  const ref = db.collection('sessions').doc(key);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ step: 0, updatedAt: nowTS() });
    return 0;
  }
  const data = snap.data() || {};
  return Number.isInteger(data.step) ? data.step : 0;
}
async function setStep(from, step) {
  const key = userKey(from);
  await db.collection('sessions').doc(key)
    .set({ step, updatedAt: nowTS() }, { merge: true });
}

// ===== UI =====
const welcomeText = () =>
  '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊\n\n請按 z 開始第 1 步。';
const finishText  = () =>
  '✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你早日康復 ❤️';

// ===== 呼叫某一步的模組 =====
// 模組介面：async handler({ msg, from }) -> { text: string, done: boolean }
async function runStep(stepId, { msg, from }) {
  const def = STEPS.find(s => s.id === stepId);
  if (!def || typeof def.handler !== 'function') {
    return { text: `👉 第 ${stepId} 步（未接線），請按 z 繼續。`, done: false };
  }
  try {
    const result = await def.handler({ msg, from }) || {};
    if (typeof result.text !== 'string') {
      return { text: `👉 第 ${stepId} 步（製作中），請按 z 繼續。`, done: false };
    }
    return { text: result.text, done: !!result.done };
  } catch (err) {
    console.error(`[index] step ${stepId} error:`, err?.stack || err);
    return { text: `⚠️ 第 ${stepId} 步發生錯誤，請稍後再試或輸入 restart 重新開始。`, done: false };
  }
}

// ===== Webhook =====
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').toString();
  const body = (req.body.Body || '').toString().trim();
  const twiml = new MessagingResponse();

  // restart：回到 step 0
  if (/^restart$/i.test(body)) {
    await setStep(from, 0);
  }

  let step = await getStep(from);

  // step 0：需要使用者按 z 才開始
  if (step === 0) {
    if (!/^z$/i.test(body)) {
      twiml.message(welcomeText());
      return res.type('text/xml').send(twiml.toString());
    }
    step = 1;
    await setStep(from, step);
    // 直接呼叫第 1 步，回覆其提示
    const r1 = await runStep(1, { msg: '', from });
    twiml.message(r1.text);
    return res.type('text/xml').send(twiml.toString());
  }

  // 一般流程：把用戶輸入交給當前步驟
  const curr = await runStep(step, { msg: body, from });

  if (!curr.done) {
    // 本步仍在進行，需要更多輸入
    twiml.message(curr.text);
    return res.type('text/xml').send(twiml.toString());
  }

  // 本步已完成 → 前進一步並直接呼叫下一步（不插入「完成第N步」提示）
  const nextStep = step + 1;
  await setStep(from, nextStep);

  const nextDef = STEPS.find(s => s.id === nextStep);
  if (!nextDef) {
    twiml.message(finishText());
    return res.type('text/xml').send(twiml.toString());
  }

  const next = await runStep(nextStep, { msg: '', from });
  twiml.message(next.text);
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v6.2.0-fs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));