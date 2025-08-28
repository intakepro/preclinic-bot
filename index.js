// index.js
// Version: v6.4.6-fs
// 修正：模組回傳 texts 陣列時會逐則輸出；不再出現選了病人卻沒回覆的沉默問題。
// 保留 v6.4.4-fs 的流程邏輯（z 開始、restart/「我想做預先問診」重設、完成後 step=-1 靜默）。

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

// ===== 載入模組 =====
const { handleNameInput } = require('./modules/name_input');
const { handleAuth }      = require('./modules/auth');
const { handleProfile }   = require('./modules/profile');
const { handleHistory }   = require('./modules/history');
const { handleInterview } = require('./modules/interview');
const { handleAiSummar }  = require('./modules/ai_summar');
const { handleExport }    = require('./modules/export');

// ===== 步驟表 =====
const STEPS = [
  { id: 5, key: 'name_input', name: '輸入病人名字模組', handler: handleNameInput },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組', handler: handleAuth },
  { id: 3, key: 'profile',    name: '讀取病人資料模組',     handler: handleProfile },
  { id: 4, key: 'history',    name: '讀取病人病史模組',     handler: handleHistory },
  { id: 1, key: 'interview',  name: '問診系統模組',         handler: handleInterview },
  { id: 6, key: 'ai_summar',  name: 'AI 整理模組',          handler: handleAiSummar },
  { id: 7, key: 'export',     name: '匯出總結模組',          handler: handleExport },
];

// ===== App =====
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 🔧 管理端上傳路由（支援 GET 上傳 JSON 到 Firestore）

const uploadSymptoms = require('./routes/upload-symptoms');
app.use('/admin', uploadSymptoms);


//const uploadBodyParts = require('./routes/upload_body_parts_to_firestore');
//app.use('/admin', uploadBodyParts);


const uploadBodyParts = require('./routers/upload_body_parts');

app.get('/admin/upload-body-parts', async (req, res) => {
  const key = req.query.key;
  if (key !== process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    return res.status(403).send('Forbidden: invalid key');
  }

  try {
    await uploadBodyPartsToFirestore();
    res.send('✅ Body parts uploaded to Firestore!');
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Upload failed: ' + err.message);
  }
});






const uploadBodyPartsToFirestore = require('./routes/upload_body_parts_to_firestore');

app.get('/admin/upload_body_parts_to_firestore', async (req, res) => {
  try {
    await uploadBodyPartsToFirestore();
    res.send('✅ Body parts uploaded to Firestore successfully.');
  } catch (error) {
    console.error('❌ Upload failed:', error);
    res.status(500).send('❌ Failed to upload body parts to Firestore.');
  }
});


const uploadSymptomQuestions = require('./routes/upload_symptom_questions');
app.use('/admin', uploadSymptomQuestions);

const clearSymptomQuestions = require('./routes/clear_symptom_questions');
app.use('/admin', clearSymptomQuestions);


// Webhook 驗證（Meta 用來驗證 callback URL）
app.get('/whatsapp', (req, res) => {
  const verifyToken = 'iloveprime'; // 🔒要與 Meta 設定的一致

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === verifyToken) {
    console.log('[Webhook] Meta webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});








// ===== Session（Firestore）=====
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
async function setStep(from, step) { await setSession(from, { step }); }
async function clearSelectedPatient(from) {
  await setSession(from, { selectedPatient: admin.firestore.FieldValue.delete() });
}

// ===== 文案 / 觸發詞 =====
const welcomeText = () =>
  '👋 歡迎使用 B 醫生問診系統，我哋而家開始啦⋯⋯😊\n\n請輸入 **z** 開始第 1 步。';
const finishText  = () =>
  '✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你早日康復 ❤️\n（如需重新開始，請輸入「我想做預先問診」或 restart）';

const containsStartPhrase = (s='') => /我想做預先問診/i.test(s);
const isZ = (s='') => s.trim().toLowerCase() === 'z';

// 把模組回傳統一成陣列
function toArrayTexts(out) {
  if (!out) return [];
  if (Array.isArray(out.texts)) return out.texts.filter(t => typeof t === 'string' && t.trim());
  if (typeof out.text === 'string' && out.text.trim()) return [out.text];
  return [];
}

// ===== 執行單一步驟 =====
async function runStep(stepId, { msg, from }) {
  const def = STEPS.find(s => s.id === stepId);
  if (!def || typeof def.handler !== 'function') {
    console.log(`[DEBUG] runStep(${stepId}) 未接線 handler`);
    return { texts: [], done: false };
  }

  try {
    console.log(`[DEBUG] runStep(${stepId}) -> ${def.key} 觸發，msg="${msg}"`);

    // history 需要 selectedPatient
    if (def.key === 'history') {
      const { data } = await getSession(from);
      const sel = data.selectedPatient || {};
      const patientId   = sel.patientId || '';
      const patientName = sel.name || '';
      if (!patientId || !patientName) {
        console.log('[DEBUG] history 缺少 selectedPatient');
        return {
          texts: ['⚠️ 尚未選定病人，請先於第 1 步選擇或新增病人。\n（輸入「我想做預先問診」或 restart 回到歡迎畫面）'],
          done: false
        };
      }
      const r = await def.handler({ msg, from, patientId, patientName }) || {};
      const texts = toArrayTexts(r);
      console.log(`[DEBUG] runStep(${stepId}) <- done=${!!r.done}, texts=${texts.length}`);
      return { texts, done: !!r.done };
    }

    const r = await def.handler({ msg, from }) || {};
    const texts = toArrayTexts(r);
    console.log(`[DEBUG] runStep(${stepId}) <- done=${!!r.done}, texts=${texts.length}`);
    return { texts, done: !!r.done };
  } catch (e) {
    console.error(`[index] step ${stepId} error:`, e?.stack || e);
    return { texts: [`⚠️ 第 ${stepId} 步發生錯誤，請稍後再試或輸入「我想做預先問診」/restart 重設。`], done: false };
  }
}

// ===== Webhook =====
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').toString();
  const body = (req.body.Body || '').toString().trim();
  let step = await getStep(from);

  // A) 任何時刻：啟動詞或 restart -> 重設到歡迎
  if (containsStartPhrase(body) || /^restart$/i.test(body)) {
    await clearSelectedPatient(from);
    await setStep(from, 0);
    console.log('[DEBUG] RESET -> step=0 (WELCOME)');
    const tw = new MessagingResponse();
    tw.message(welcomeText());
    return res.type('text/xml').send(tw.toString());
  }

  // B) 完成後靜默
  if (step === -1) {
    console.log('[DEBUG] step=-1 (DONE) 靜默中');
    return res.status(204).end();
  }

  // C) 歡迎畫面
  if (step === 0) {
    const tw = new MessagingResponse();
    if (isZ(body)) {
      await setStep(from, 1);
      console.log('[DEBUG] WELCOME -> z，設定 step=1，觸發第一步（不自動前進）');
      const r1 = await runStep(1, { msg: '', from });
      const texts = r1.texts || [];
      if (texts.length) {
        texts.forEach(t => tw.message(t));
        return res.type('text/xml').send(tw.toString());
      }
      return res.status(204).end();
    }
    console.log('[DEBUG] WELCOME 非 z，重覆歡迎語');
    tw.message(welcomeText());
    return res.type('text/xml').send(tw.toString());
  }

  // D) 超範圍保險：視為完成
  if (step > STEPS.length) {
    await setStep(from, -1);
    const tw = new MessagingResponse();
    tw.message(finishText());
    return res.type('text/xml').send(tw.toString());
  }

  // E) 正常流程：把輸入交給當前步驟
  console.log(`[DEBUG] 當前 step=${step}，執行 ${STEPS.find(s=>s.id===step)?.key}`);
  const curr = await runStep(step, { msg: body, from });

  if (!curr.done) {
    const texts = curr.texts || [];
    if (texts.length) {
      const tw = new MessagingResponse();
      texts.forEach(t => tw.message(t));
      return res.type('text/xml').send(tw.toString());
    }
    return res.status(204).end();
  }

  // 本步完成 → 前進或結束
  const nextStep = step + 1;
  if (nextStep > STEPS.length) {
    await setStep(from, -1); // DONE
    console.log('[DEBUG] 所有步驟完成 -> step=-1');
    const tw = new MessagingResponse();
    tw.message(finishText());
    return res.type('text/xml').send(tw.toString());
  }

  await setStep(from, nextStep);
  console.log(`[DEBUG] 前進至 step=${nextStep}，觸發下一步`);
  const next = await runStep(nextStep, { msg: '', from });
  const texts = next.texts || [];
  if (texts.length) {
    const tw = new MessagingResponse();
    texts.forEach(t => tw.message(t));
    return res.type('text/xml').send(tw.toString());
  }
  return res.status(204).end();
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor flow server running. v6.4.6-fs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
