// modules/name_input.js
// 名字模組：相容兩種呼叫方式（req 或 { from, body }）＋ Firestore 永續化

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const NAME_STATE = {
  ENTRY: 'NAME_ENTRY',
  SHOW: 'NAME_SHOW',
  ASK_NAME: 'NAME_ASK_NAME',
  DONE: 'NAME_DONE'
};

// ---- 工具：相容舊／新兩種呼叫介面 ----
function parseArgs(arg) {
  // 新介面 { from, body }
  if (arg && typeof arg === 'object' && Object.prototype.hasOwnProperty.call(arg, 'from')) {
    const from = String(arg.from || '').trim();
    const body = String(arg.body || '').trim();
    return { from, body };
  }
  // 舊介面：req（Express/Twilio）
  const req = arg || {};
  const from = String((req.body && req.body.From) || '')
    .replace(/^whatsapp:/, '')
    .trim();
  const body = String((req.body && req.body.Body) || '').trim();
  return { from, body };
}

// ---- Firestore helpers ----
async function getSession(from) {
  const doc = await db.collection('sessions').doc(from).get();
  const data = doc.exists ? doc.data() : {};
  return { name_state: data.name_state || NAME_STATE.ENTRY };
}
async function saveSession(from, patch) {
  await db.collection('sessions').doc(from).set(patch, { merge: true });
}

async function getProfile(from) {
  const snap = await db.collection('patients').doc(from).get();
  const data = snap.exists ? snap.data() : {};
  return data.profile || null;
}
async function saveProfile(from, profilePatch) {
  const snap = await db.collection('patients').doc(from).get();
  const cur = snap.exists ? (snap.data().profile || {}) : {};
  await db.collection('patients').doc(from).set(
    {
      profile: { ...cur, ...profilePatch },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

function renderName(p) {
  return p?.name ? `- 已登記姓名：${p.name}` : '（尚未登記姓名）';
}

// ---- 主流程 ----
async function handleNameInput(arg) {
  const { from, body } = parseArgs(arg);

  // 防呆：from 缺失時不 throw，回導引字串避免崩潰
  if (!from) return '請輸入您的名字（例如：陳大文）';

  const { name_state } = await getSession(from);
  const profile = await getProfile(from);

  if (name_state === NAME_STATE.ENTRY) {
    if (profile?.name) {
      await saveSession(from, { name_state: NAME_STATE.SHOW });
      return `您目前的資料：\n${renderName(profile)}\n\n需要更改嗎？\n輸入 1️⃣ 需要\n輸入 2️⃣ 不需要`;
    }
    await saveSession(from, { name_state: NAME_STATE.ASK_NAME });
    return '請輸入您的名字（例如：陳大文）';
  }

  if (name_state === NAME_STATE.SHOW) {
    if (body !== '1' && body !== '2') return '請輸入 1️⃣ 需要 或 2️⃣ 不需要';
    if (body === '1') {
      await saveSession(from, { name_state: NAME_STATE.ASK_NAME });
      return '請輸入您的名字（例如：陳大文）';
    } else {
      await saveSession(from, { name_state: NAME_STATE.DONE });
      return '✅ 姓名已確認，進入下一步';
    }
  }

  if (name_state === NAME_STATE.ASK_NAME) {
    if (!body || body.length < 2) {
      return '名字看起來太短了，請再輸入一次（例如：陳大文）';
    }
    // 你可在此加上更多驗證（僅允許中英文與空白、禁止 emoji 等）
    await saveProfile(from, { name: body });
    await saveSession(from, { name_state: NAME_STATE.DONE });
    return `✅ 已記錄姓名：${body}\n進入下一步`;
  }

  // DONE 或其他狀態兜底
  return '（提示）姓名已完成。';
}

module.exports = { handleNameInput };


