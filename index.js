// index.js
// Version: v6.4.3-fs
// 變更要點：
// - 任意時刻：只要訊息「包含」『我想做預先問診』或輸入 restart → 完全重置為 step=0，回覆【歡迎語】；不自動進入第 1 步。
// - 歡迎畫面（step=0）：只能輸入 z 才進入第 1 步（不接受 start/hi）。若再次輸入『我想做預先問診』仍會重置回歡迎語。
// - 步驟完成後自動前進；全部完成後 step=-1（靜默），直到再收到『我想做預先問診』或 restart 才重設。

'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// ===== Firebase =====
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

// ===== 載入你的模組（與現有版本相容）=====
const { handleNameInput } = require('./modules/name_input');   // v6.0.1-fs（建議）
const { handleAuth }      = require('./modules/auth');
const { handleProfile }   = require('./modules/profile');
const { handleHistory }   = require('./modules/history');      // v6.2.1-fs-composite（建議）
const { handleInterview } = require('./modules/interview');
const { handleAiSummar }  = require('./modules/ai_summar');
const { handleExport }    = require('./modules/export');

// ===== 步驟表（可減少項目；程式會自動判斷最後一步）=====
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

// ===== Session 工具 =====
const phoneOf = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';

async function getSession(from) {
  const key = phoneOf(from);
  const ref = db.collection('sessions').doc(key);
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = { step: 0, updatedAt: nowTS() };
    await ref.set(fresh);
    return { ref, data: fresh };
  }
  return { ref, data: snap.data() || { step: 0 } };
}
async function setSession(from, patch) {
  const key = phoneOf(from);
  await db.collection('sessions').doc(key)
    .set({ ...patch, updatedAt: nowTS() }, { merge: true });
}
async function getStep(from) {
  const { data } = await getSession(from);
  const s = Number(data.step ?? 0);
  return s === -1 ? -1 : Math.max(0, Math.min(s, STEPS.length));
}
async function setStep(from, step) {
  await setSession(from, { step });
}
async function clearSelectedPatient(from) {
  await setSession(from, { selectedPatient: admin.firestore.FieldValue.delete() });
}

// ===== 文案 / 觸發詞 =====
const welcomeText = () =>
  '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊\n\n請輸入 **z** 開始第 1 步。';
const finishText  = () =>
  '✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你早日康復 ❤️\n（如需重新開始，請輸入「我想做預先問診」或 restart）';

const containsStartPhrase = (s='') => /我想做預先問診/i.test(s);
const isZ = (s='') => s.trim().toLowerCase() === 'z';

// ===== 單步執行器（history 會帶 selectedPatient）=====
async function runStep(stepId, { msg, from }) {
  const def = STEPS.find(s => s.id === stepId);
  if (!def || typeof def.handler !== 'function') {
    return { text: `👉 第 ${stepId} 步（未接線），請按 z 繼續。`, done: false };
  }

  try {
    if (def.key === 'history') {
      const { data } = await getSession(from);
      const sel = data.selectedPatient || {};
      const patientId   = sel.patientId || '';
      const patientName = sel.name || '';
      if (!patientId || !patientName) {
        return {
          text: '⚠️ 尚未選定病人，請回到第 1 步選擇或新增病人後再試。\n（輸入「我想做預先問診」或 restart 回到歡迎畫面）',
          done: false
        };
      }
      const r = await def.handler({ msg, from, patientId, patientName }) || {};
      return { text: r.text || `👉 第 ${stepId} 步（製作中）`, done: !!r.done };
    }

    const r = await def.handler({ msg, from }) || {};
    return { text: r.text || `👉 第 ${stepId} 步（製作中）`, done: !!r.done };
  } catch (e) {
    console.error(`[index] step ${stepId} error:`, e?.stack || e);
    return { text: `⚠️ 第 ${stepId} 步發生錯誤，請稍後再試或輸入「我想做預先問診」或 restart 回到歡迎畫面。`, done: false };
  }
}

// ===== Webhook =====
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').toString();
  const body = (req.body.Body || '').toString().trim();
  let step = await getStep(from);

  // A. 任意時刻：包含『我想做預先問診』或 restart → 完全重置為 step=0，清除已選病人，回覆【歡迎語】（不自動進 Step 1）
  if (containsStartPhrase(body) || /^restart$/i.test(body)) {
    await clearSelectedPatient(from);
    await setStep(from, 0);
    const tw = new MessagingResponse();
    tw.message(welcomeText());
    return res.type('text/xml').send(tw.toString());
  }

  // B. 全部完成（step = -1）：除非再收到『我想做預先問診』或 restart，否則靜默
  if (step === -1) {
    return res.status(204).end();
  }

  // C. 歡迎畫面（step = 0）：只有 z 能開始第 1 步；其它文字（包括 start/hi）一律重覆歡迎語
  if (step === 0) {
    const tw = new MessagingResponse();
    if (isZ(body)) {
      await setStep(from, 1);
      const r1 = await runStep(1, { msg: '', from });
      // 第 1 步未完成 → 回覆第 1 步內容
      if (!r1.done) {
        tw.message(r1.text);
        return res.type('text/xml').send(tw.toString());
      }
      // 第 1 步已完成 → 直接前進至第 2 步
      const nextStep = 2;
      if (nextStep > STEPS.length) {
        await setStep(from, -1);
        tw.message(finishText());
        return res.type('text/xml').send(tw.toString());
      }
      await setStep(from, nextStep);
      const next = await runStep(nextStep, { msg: '', from });
      tw.message(next.text);
      return res.type('text/xml').send(tw.toString());
    } else {
      tw.message(welcomeText());
      return res.type('text/xml').send(tw.toString());
    }
  }

  // D. 超範圍保險
  if (step > STEPS.length) {
    await setStep(from, -1);
    const tw = new MessagingResponse();
    tw.message(finishText());
    return res.type('text/xml').send(tw.toString());
  }

  // E. 正常流程：把輸入交給當前步驟
  const curr = await runStep(step, { msg: body, from });
  const tw = new MessagingResponse();

  if (!curr.done) {
    tw.message(curr.text);
    return res.type('text/xml').send(tw.toString());
  }

  // 本步完成 → 前進或結束
  const nextStep = step + 1;
  if (nextStep > STEPS.length) {
    await setStep(from, -1); // DONE
    tw.message(finishText());
    return res.type('text/xml').send(tw.toString());
  }

  await setStep(from, nextStep);
  const next = await runStep(nextStep, { msg: '', from });
  tw.message(next.text);
  return res.type('text/xml').send(tw.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v6.4.3-fs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));