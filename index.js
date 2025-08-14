
// index.js — 單檔可部署版（Twilio WhatsApp + Firestore）
// ----------------------------------------------------------

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// --- Firestore 初始化（Render 建議用環境變數 FIREBASE_SERVICE_ACCOUNT） ---
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
} else {
  // 本機開發可用 GOOGLE_APPLICATION_CREDENTIALS
  admin.initializeApp();
}
const db = admin.firestore();

// -------------------- 工具：回覆 --------------------
function sendReply(res, twiml, text) {
  twiml.message(text);
  res.type('text/xml').send(twiml.toString());
}

// -------------------- 工具：Session --------------------
async function getSession(phone) {
  const ref = db.collection('sessions').doc(phone);
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = {
      phone,
      module: 'patientName',
      state: 'INIT', // INIT | MENU | ADD_NAME | ADD_GENDER | ADD_YEAR | ADD_ID | DELETE_MENU | VIEW_PROFILE
      temp: {},
      updatedAt: new Date()
    };
    await ref.set(fresh);
    return fresh;
  }
  return snap.data();
}
async function saveSession(session) {
  session.updatedAt = new Date();
  await db.collection('sessions').doc(session.phone).set(session, { merge: true });
}

// -------------------- 工具：帳號/病人資料 --------------------
async function ensureAccount(phone) {
  const userRef = db.collection('users').doc(phone);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({ phone, createdAt: new Date(), updatedAt: new Date() });
    return { createdNow: true };
  } else {
    await userRef.set({ updatedAt: new Date() }, { merge: true });
    return { createdNow: false };
  }
}

async function listPatients(phone) {
  const snap = await db.collection('users').doc(phone).collection('patients')
    .orderBy('createdAt', 'asc')
    .get();
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.slice(0, 8);
}

async function addPatient(phone, data) {
  const col = db.collection('users').doc(phone).collection('patients');
  const now = new Date();
  const payload = {
    name: data.name,
    gender: data.gender,       // '男' | '女'
    birthYear: data.birthYear, // number
    idNumber: data.idNumber,   // string
    createdAt: now,
    updatedAt: now
  };
  const docRef = await col.add(payload);
  return { id: docRef.id, ...payload };
}

async function deletePatient(phone, patientId) {
  await db.collection('users').doc(phone).collection('patients').doc(patientId).delete();
}

// -------------------- 驗證 --------------------
function isValidGender(t) { return t === '男' || t === '女'; }
function isValidYear(t) {
  const y = Number(t);
  const now = new Date().getFullYear();
  return Number.isInteger(y) && y >= 1900 && y <= now;
}
function isValidId(t) { return typeof t === 'string' && t.trim().length >= 4; }

// -------------------- 文字樣板 --------------------
function renderMenu(patients, firstTime = false) {
  const lines = [];
  if (firstTime || patients.length === 0) {
    lines.push('👋 歡迎使用。偵測到這是你首次使用或尚未建立資料。');
    lines.push('請先新增一位病人（依序輸入：姓名→性別→出生年份→身份證號）。');
    lines.push('');
    lines.push('回覆「1」開始新增。');
    return lines.join('\n');
  }

  lines.push('👤 請選擇或新增病人：');
  patients.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  lines.push(`${patients.length + 1}. ➕ 新增病人`);
  lines.push('');
  lines.push('請回覆編號（例如：1）。');
  return lines.join('\n');
}

function renderDeleteMenu(patients) {
  const lines = [];
  lines.push('📦 已達上限：此帳號最多可儲存 8 位病人。');
  lines.push('請選擇要刪除的一位病人：');
  patients.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  lines.push('');
  lines.push('回覆編號刪除，或輸入 0 返回上一頁。');
  return lines.join('\n');
}

function renderProfile(p) {
  return [
    '📄 病人個人資料',
    `姓名：${p.name}`,
    `性別：${p.gender}`,
    `出生年份：${p.birthYear}`,
    `身份證號碼：${p.idNumber}`
  ].join('\n');
}

// -------------------- 主路由：任何訊息即進入本模組 --------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = (req.body.From || '').replace('whatsapp:', ''); // e.g. +852XXXXXXXX
  const body = (req.body.Body || '').trim();

  // 1) 建立/更新帳號；抓 session
  await ensureAccount(from);
  let session = await getSession(from);
  session.module = 'patientName'; // 單模組檔

  // 2) 抓目前名單
  let patients = await listPatients(from);

  // 3) 首次使用或沒有名單 → 直接導向新增流程
  if (session.state === 'INIT') {
    if (patients.length === 0) {
      session.state = 'ADD_NAME';
      session.temp = {};
      await saveSession(session);
      return sendReply(res, twiml, '首次使用：請新增病人。\n\n1️⃣ 請輸入姓名（請依「身份證姓名」輸入）：');
    } else {
      session.state = 'MENU';
      await saveSession(session);
      return sendReply(res, twiml, renderMenu(patients));
    }
  }

  // 4) 狀態機
  switch (session.state) {
    case 'MENU': {
      const n = Number(body);
      // 若沒有病人且使用者回其它字 → 引導新增
      if (patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = {};
        await saveSession(session);
        return sendReply(res, twiml, '首次使用：請新增病人。\n\n1️⃣ 請輸入姓名（請依「身份證姓名」輸入）：');
      }
      if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
        if (n <= patients.length) {
          const chosen = patients[n - 1];
          session.state = 'VIEW_PROFILE';
          session.temp = { viewId: chosen.id };
          await saveSession(session);
          return sendReply(res, twiml, `${renderProfile(chosen)}\n\n（已回到主選單）\n\n${renderMenu(patients)}`);
        }
        // 新增
        if (n === patients.length + 1) {
          if (patients.length >= 8) {
            session.state = 'DELETE_MENU';
            await saveSession(session);
            return sendReply(res, twiml, renderDeleteMenu(patients));
          }
          session.state = 'ADD_NAME';
          session.temp = {};
          await saveSession(session);
          return sendReply(res, twiml, '1️⃣ 請輸入姓名（請依「身份證姓名」輸入）：');
        }
      }
      // 不是有效數字 → 再顯示選單
      await saveSession(session);
      return sendReply(res, twiml, renderMenu(patients));
    }

    case 'ADD_NAME': {
      if (!body) return sendReply(res, twiml, '請輸入有效的姓名（身份證姓名）：');
      session.temp.name = body;
      session.state = 'ADD_GENDER';
      await saveSession(session);
      return sendReply(res, twiml, '2️⃣ 請輸入性別（回覆「男」或「女」）：');
    }

    case 'ADD_GENDER': {
      if (!isValidGender(body)) return sendReply(res, twiml, '格式不正確。請回覆「男」或「女」。');
      session.temp.gender = body;
      session.state = 'ADD_YEAR';
      await saveSession(session);
      return sendReply(res, twiml, '3️⃣ 請輸入出生年份（例如：1978）：');
    }

    case 'ADD_YEAR': {
      if (!isValidYear(body)) {
        const now = new Date().getFullYear();
        return sendReply(res, twiml, `年份不正確。請輸入 1900–${now} 的四位數年份：`);
      }
      session.temp.birthYear = Number(body);
      session.state = 'ADD_ID';
      await saveSession(session);
      return sendReply(res, twiml, '4️⃣ 請輸入身份證號碼：');
    }

    case 'ADD_ID': {
      if (!isValidId(body)) return sendRe

