// index.js
// WhatsApp Webhook（Twilio）＋ 模組 1/2/3/4 串接，支援使用者輸入 0 直接跳過 2、3 進入 4

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const { handleHistoryModule } = require('./modules/history_module');
// 你既有的名字模組
const { handleNameInput } = require('./modules/name_input');

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====== 流程定義 ======
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組' },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組（可跳過）' },
  { id: 3, key: 'profile',    name: '讀取病人資料模組（可跳過）' },
  { id: 4, key: 'history',    name: '病史模組' },
];

const userStep = {}; // { [from]: number }

function getCurrentStepKey(from) {
  const idx = userStep[from] ?? 1;
  return STEPS.find(s => s.id === idx)?.key || 'name_input';
}
function setStep(from, id) { userStep[from] = id; }
function advanceStep(from) {
  const current = userStep[from] ?? 1;
  userStep[from] = Math.min(current + 1, STEPS.length);
}

// ====== 模組 2：權限檢查（示範用）======
async function handleAuthModule({ body }) {
  if ((body || '').trim() === '0') {
    return { text: '⏭️ 已跳過【問診權限檢查】並直接前往病史模組。', skipToStep: 4 };
  }
  // 你之後可改為：校驗預約號、黑名單等
  return { text: '✅ 問診權限檢查通過（輸入 0 可跳過此步驟並直接前往病史）。', done: true };
}

// ====== 模組 3：極簡 Profile 子流程 ======
const PROFILE_STATE = {
  ENTRY: 'PROFILE_ENTRY',
  SHOW: 'PROFILE_SHOW',
  ASK_CHANGE: 'PROFILE_ASK_CHANGE',
  ASK_GENDER: 'PROFILE_ASK_GENDER',
  ASK_BIRTHYEAR: 'PROFILE_ASK_BIRTHYEAR',
  DONE: 'PROFILE_DONE'
};
async function getProfileSession(from) {
  const doc = await db.collection('sessions').doc(from).get();
  const data = doc.exists ? doc.data() : {};
  return {
    profile_state: data.profile_state || PROFILE_STATE.ENTRY,
    profile_buffer: data.profile_buffer || {}
  };
}
async function saveProfileSession(from, patch) {
  await db.collection('sessions').doc(from).set(patch, { merge: true });
}
async function getPatientProfile(from) {
  const snap = await db.collection('patients').doc(from).get();
  const data = snap.exists ? snap.data() : {};
  return data.profile || null;
}
async function savePatientProfile(from, profile) {
  await db.collection('patients').doc(from).set({
    profile,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}
function renderProfileSummary(p) {
  if (!p) return '（尚無資料）';
  return `- 性別：${p.gender || '未填'}\n- 出生年：${p.birthYear || '未填'}`;
}
async function handleProfileModule({ from, body }) {
  const input = (body || '').trim();

  // 全域跳過鍵
  if (input === '0') {
    return { text: '⏭️ 已跳過【基本資料】並直接前往病史模組。', skipToStep: 4 };
  }

  let { profile_state, profile_buffer } = await getProfileSession(from);
  const existing = await getPatientProfile(from);

  if (profile_state === PROFILE_STATE.ENTRY) {
    if (existing) {
      await saveProfileSession(from, { profile_state: PROFILE_STATE.SHOW });
      return { text: `您已有基本資料：\n${renderProfileSummary(existing)}\n\n需要更改嗎？（輸入 0 可跳過）\n1️⃣ 需要\n2️⃣ 不需要` };
    } else {
      await saveProfileSession(from, { profile_state: PROFILE_STATE.ASK_GENDER, profile_buffer: {} });
      return { text: `首次使用將建立基本資料（約 10–20 秒）（輸入 0 可跳過）\n請輸入性別：\n1️⃣ 男\n2️⃣ 女` };
    }
  }

  if (profile_state === PROFILE_STATE.SHOW) {
    if (!['1','2'].includes(input)) return { text: '請輸入 1️⃣ 需要 或 2️⃣ 不需要（或輸入 0 跳過）' };
    if (input === '1') {
      await saveProfileSession(from, { profile_state: PROFILE_STATE.ASK_GENDER, profile_buffer: {} });
      return { text: `請輸入性別：\n1️⃣ 男\n2️⃣ 女（輸入 0 可跳過）` };
    } else {
      await saveProfileSession(from, { profile_state: PROFILE_STATE.DONE });
      return { text: '✅ 基本資料已確認，進入下一步。', done: true };
    }
  }

  if (profile_state === PROFILE_STATE.ASK_GENDER) {
    if (!['1','2'].includes(input)) return { text: '請輸入 1️⃣ 男 或 2️⃣ 女（或輸入 0 跳過）' };
    profile_buffer.gender = (input === '1') ? '男' : '女';
    await saveProfileSession(from, { profile_state: PROFILE_STATE.ASK_BIRTHYEAR, profile_buffer });
    return { text: '請輸入出生年（例如：1985；或輸入 0 跳過）' };
  }

  if (profile_state === PROFILE_STATE.ASK_BIRTHYEAR) {
    if (input === '0') {
      return { text: '⏭️ 已跳過【基本資料】並直接前往病史模組。', skipToStep: 4 };
    }
    const year = parseInt(input, 10);
    if (!year || year < 1900 || year > 2025) {
      return { text: '格式不正確，請輸入 1900–2025 的 4 位數年份（或輸入 0 跳過）' };
    }
    profile_buffer.birthYear = year;
    await savePatientProfile(from, { gender: profile_buffer.gender, birthYear: profile_buffer.birthYear });
    await saveProfileSession(from, { profile_state: PROFILE_STATE.DONE, profile_buffer: {} });
    const summary = renderProfileSummary({ gender: profile_buffer.gender, birthYear: profile_buffer.birthYear });
    return { text: `✅ 已儲存基本資料：\n${summary}\n\n進入下一步。`, done: true };
  }

  return { text: '（提示）基本資料已完成。', done: true };
}

// ====== 路由器（含全域 0 跳過到 step 4）======
async function stateRouter({ from, body }) {
  const input = (body || '').trim();

  // 全域「0」：只要未到病史（4），就直接跳到 4
  const currentId = userStep[from] ?? 1;
  if (input === '0' && currentId < 4) {
    setStep(from, 4);
    return '⏭️ 已依您的指示跳過中間步驟，直接前往【病史模組】。';
  }

  const key = getCurrentStepKey(from);

  // 1) 名字模組（使用你既有 handleNameInput）
  if (key === 'name_input') {
    const resp = await handleNameInput({ from, body });
    // 完成判斷（你可改成用旗標）
    const done = typeof resp === 'string' && /完成|已記錄|下一步|進入下一步/.test(resp);
    if (done) advanceStep(from);
    return (resp || '請輸入您的名字（例如：陳大文）\n（提示：若要略過中間步驟直接到病史，輸入 0）');
  }

  // 2) 權限模組（可跳過）
  if (key === 'auth') {
    const { text, done, skipToStep } = await handleAuthModule({ body });
    if (skipToStep) { setStep(from, skipToStep); }
    else if (done) { advanceStep(from); }
    return text + '\n（提示：若要直接到病史，隨時輸入 0）';
  }

  // 3) 基本資料模組（可跳過）
  if (key === 'profile') {
    const { text, done, skipToStep } = await handleProfileModule({ from, body });
    if (skipToStep) { setStep(from, skipToStep); }
    else if (done) { advanceStep(from); }
    return text + '\n（提示：若要直接到病史，隨時輸入 0）';
  }

  // 4) 病史模組
  if (key === 'history') {
    const reply = await handleHistoryModule({ from, body });
    // 若病史模組結束，你可以在這裡接下一個模組
    return reply;
  }

  return `目前在模組：${key}`;
}

app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').replace(/^whatsapp:/, '').trim();
  const body = (req.body.Body || '').trim();

  const twiml = new MessagingResponse();
  try {
    const replyMsg = await stateRouter({ from, body });
    twiml.message(replyMsg);
  } catch (err) {
    console.error('Error:', err);
    twiml.message('系統忙碌或發生錯誤，請稍後再試 🙏');
  }

  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ WhatsApp 問診機器人運行中，port: ${PORT}`);
});






