// index.js
// Version: v6.1.0-fs
// 說明：Firestore 版流程控制（每步皆需使用者回覆 z 才前進）
// 依賴：firebase-admin、twilio、express、body-parser

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// ===== Firebase 初始化（支援 FIREBASE_SERVICE_ACCOUNT 或預設憑證） =====
(function ensureFirebase() {
  if (admin.apps.length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[index] Firebase initialized via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp(); // 使用 GOOGLE_APPLICATION_CREDENTIALS 或執行環境預設
      console.log('[index] Firebase initialized via default credentials');
    }
  } catch (e) {
    console.error('[index] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

// ===== 你的模組（保持既有檔名）=====
const { handleNameInput } = require('./modules/name_input');
const { handleAuth }      = require('./modules/auth');
const { handleProfile }   = require('./modules/profile');
const { handleHistory }   = require('./modules/history'); // 你已有 Firestore 版 history，會用到 from
const { handleInterview } = require('./modules/interview');
const { handleAiSummar }  = require('./modules/ai_summar');
const { handleExport }    = require('./modules/export');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ===== 步驟表（固定 7 步）=====
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組', handler: handleNameInput },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組', handler: handleAuth },
  { id: 3, key: 'profile',    name: '讀取病人資料模組',   handler: handleProfile },
  { id: 4, key: 'history',    name: '讀取病人病史模組',   handler: handleHistory },
  { id: 5, key: 'interview',  name: '問診系統模組',       handler: handleInterview },
  { id: 6, key: 'ai_summar',  name: 'AI 整理模組',        handler: handleAiSummar },
  { id: 7, key: 'export',     name: '匯出總結模組',        handler: handleExport },
];

// ===== Firestore Session I/O =====
function userKey(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';
}

async function getSessionStep(from) {
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

async function setSessionStep(from, step) {
  const key = userKey(from);
  await db.collection('sessions').doc(key)
    .set({ step, updatedAt: nowTS() }, { merge: true });
}

// ===== UI =====
const welcomeText = () => '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊';
const finishText  = () => '✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你早日康復 ❤️';

// ===== 呼叫當前步驟模組 =====
// 模組介面固定為：async handler({ msg, from }) -> { text: string, done: boolean }
async function runStep(stepDef, { msg, from }) {
  try {
    const fn = stepDef.handler;
    if (typeof fn !== 'function') {
      return {
        text: `👉 第 ${stepDef.id} 步：${stepDef.name}\n（未接線）請按 z 進入下一步。`,
        done: false
      };
    }
    const result = await fn({ msg, from });
    if (!result || typeof result.text !== 'string') {
      return {
        text: `👉 第 ${stepDef.id} 步：${stepDef.name}\n（製作中）請按 z 進入下一步。`,
        done: false
      };
    }
    return { text: result.text, done: !!result.done };
  } catch (err) {
    console.error(`[index] step ${stepDef.id} error:`, err?.stack || err);
    return {
      text: `⚠️ 第 ${stepDef.id} 步發生錯誤，請稍後再試或輸入 restart 重新開始。`,
      done: false
    };
  }
}

// ===== Webhook =====
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').toString();
  const body = (req.body.Body || '').toString().trim();
  const twiml = new MessagingResponse();

  // restart：重置流程
  if (/^restart$/i.test(body)) {
    await setSessionStep(from, 0);
  }

  // 讀取目前步驟
  let step = await getSessionStep(from);

  // 首次 / 已重置：先出歡迎語，要求按 z 開始 → 設為 Step1
  if (step === 0) {
    if (!/^z$/i.test(body)) {
      twiml.message(`${welcomeText()}\n\n請按 z 開始第 1 步。`);
      return res.type('text/xml').send(twiml.toString());
    }
    step = 1;
    await setSessionStep(from, step);
  }

  // 完成所有步驟
  const stepDef = STEPS.find(s => s.id === step);
  if (!stepDef) {
    twiml.message(finishText());
    return res.type('text/xml').send(twiml.toString());
  }

  // 呼叫當前模組
  const result = await runStep(stepDef, { msg: body, from });

  if (result.done) {
    // 前進下一步
    const nextStep = step + 1;
    await setSessionStep(from, nextStep);

    const nextDef = STEPS.find(s => s.id === nextStep);
    if (nextDef) {
      twiml.message(`✅ 已完成：第 ${stepDef.id} 步「${stepDef.name}」。\n👉 進入第 ${nextDef.id} 步「${nextDef.name}」。\n請按 z 繼續。`);
    } else {
      twiml.message(finishText());
    }
    return res.type('text/xml').send(twiml.toString());
  }

  // 本步尚未完成（需要用戶回覆）
  twiml.message(result.text);
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v6.1.0-fs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));