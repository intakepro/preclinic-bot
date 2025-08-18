// index.js
// Version: v6.3.0-fs
// 變更要點：
// - 完成第 7 步後設 step = -1（DONE）。只有在收到「我想做預先問診 / z / start / hi / restart」才會重新開始；否則靜默。
// - 首次進入或 DONE 後，"我想做預先問診" 等同開始（z）。
// - 防呆：不會出現第 8 步；超範圍重置；所有步驟文字由各模組輸出。

'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// ===== Firebase 初始化 =====
(function ensureFirebase() {
  if (admin.apps.length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[index] Firebase via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp();
      console.log('[index] Firebase via default credentials');
    }
  } catch (e) {
    console.error('[index] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

// ===== 載入各模組 =====
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

// ===== Session I/O =====
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
  const s = Number((snap.data() || {}).step ?? 0);
  // 允許 -1（DONE），其他夾到 [0..STEPS.length]
  return s === -1 ? -1 : Math.max(0, Math.min(s, STEPS.length));
}
async function setStep(from, step) {
  const key = userKey(from);
  await db.collection('sessions').doc(key)
    .set({ step, updatedAt: nowTS() }, { merge: true });
}

// ===== UI =====
const welcomeText = () =>
  '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊\n\n請回覆「我想做預先問診」或輸入 z 開始第 1 步。';
const finishText  = () =>
  '✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你早日康復 ❤️\n（如需重新開始，請回覆「我想做預先問診」或輸入 restart）';

// 支援的開始關鍵字（含中文）
const isStart = (s = '') => /^(z|start|hi|我想做預先問診)$/i.test(s.trim());

// ===== 呼叫某一步（模組介面：{ msg, from } -> { text, done }）=====
async function runStep(stepId, { msg, from }) {
  const def = STEPS.find(s => s.id === stepId);
  if (!def || typeof def.handler !== 'function') {
    return { text: `👉 第 ${stepId} 步（未接線），請按 z 繼續。`, done: false };
  }
  try {
    const r = await def.handler({ msg, from }) || {};
    return {
      text: typeof r.text === 'string' ? r.text : `👉 第 ${stepId} 步（製作中）`,
      done: !!r.done
    };
  } catch (e) {
    console.error(`[index] step ${stepId} error:`, e?.stack || e);
    return { text: `⚠️ 第 ${stepId} 步發生錯誤，請稍後再試或輸入 restart 重新開始。`, done: false };
  }
}

// ===== Webhook =====
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').toString();
  const body = (req.body.Body || '').toString().trim();

  // 讀取目前 step（可能是 -1 / 0..7）
  let step = await getStep(from);

  // DONE 狀態：僅在 restart 或「開始關鍵字」時才重啟；否則靜默不回覆
  if (step === -1) {
    if (/^restart$/i.test(body) || isStart(body)) {
      await setStep(from, 0);
      step = 0;
    } else {
      return res.status(204).end();
    }
  }

  const twiml = new MessagingResponse();

  // restart 指令（任何時候有效）
  if (/^restart$/i.test(body)) {
    await setStep(from, 0);
    step = 0;
  }

  // step 0：需要開始關鍵字
  if (step === 0) {
    if (!isStart(body)) {
      twiml.message(welcomeText());
      return res.type('text/xml').send(twiml.toString());
    }
    // 直接進第 1 步
    await setStep(from, 1);
    const r1 = await runStep(1, { msg: '', from });
    twiml.message(r1.text);
    return res.type('text/xml').send(twiml.toString());
  }

  // 安全：若 step 超範圍（>7），視為完成並重置
  if (step > STEPS.length) {
    await setStep(from, -1);
    twiml.message(finishText());
    return res.type('text/xml').send(twiml.toString());
  }

  // 交給當前步驟模組
  const curr = await runStep(step, { msg: body, from });
  if (!curr.done) {
    twiml.message(curr.text);
    return res.type('text/xml').send(twiml.toString());
  }

  // 本步完成 → 下一步或結束
  const nextStep = step + 1;
  if (nextStep > STEPS.length) {
    await setStep(from, -1); // 進入 DONE
    twiml.message(finishText());
    return res.type('text/xml').send(twiml.toString());
  }

  await setStep(from, nextStep);
  const next = await runStep(nextStep, { msg: '', from });
  twiml.message(next.text);
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v6.3.0-fs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));