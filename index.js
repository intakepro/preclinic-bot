// index.js — Twilio WhatsApp + Firestore（單檔可部署）
// 新增：0 回上一頁、最多 8 人、滿額時提供刪除選單

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    console.log('[BOOT] Firebase via FIREBASE_SERVICE_ACCOUNT');
  } catch (e) {
    console.error('[BOOT] FIREBASE_SERVICE_ACCOUNT JSON parse failed:', e.message);
    admin.initializeApp();
  }
} else {
  admin.initializeApp();
  console.log('[BOOT] Firebase via default credentials');
}
const db = admin.firestore();

function sendReply(res, twiml, text) {
  twiml.message(text);
  res.type('text/xml').send(twiml.toString());
}

// ----- Session -----
async function getSession(phone) {
  const ref = db.collection('sessions').doc(phone);
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = {
      phone,
      module: 'patientName',
      state: 'INIT', // INIT | MENU | ADD_NAME | ADD_GENDER | ADD_DOB | ADD_ID | DELETE_MENU
      temp: {},
      updatedAt: new Date()
    };
    await ref.set(fresh);
    return fresh;
  }
  const data = snap.data() || {};
  data.phone = phone; // 強制覆蓋防污染
  return data;
}
async function saveSession(session) {
  if (!session || typeof session.phone !== 'string' || !session.phone.trim()) {
    throw new Error(`saveSession: invalid session.phone (${session && session.phone})`);
  }
  session.updatedAt = new Date();
  await db.collection('sessions').doc(session.phone).set(session, { merge: true });
}

// ----- Data -----
async function ensureAccount(phone) {
  const userRef = db.collection('users').doc(phone);
  const snap = await userRef.get();
  if (!snap.exists) {
    await userRef.set({ phone, createdAt: new Date(), updatedAt: new Date() });
  } else {
    await userRef.set({ updatedAt: new Date() }, { merge: true });
  }
}
async function listPatients(phone) {
  const snap = await db.collection('users').doc(phone).collection('patients')
    .orderBy('createdAt', 'asc').get();
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.slice(0, 8);
}
async function addPatient(phone, data) {
  const col = db.collection('users').doc(phone).collection('patients');
  const now = new Date();
  const payload = {
    name: data.name,
    gender: data.gender,
    birthDate: data.birthDate, // YYYY-MM-DD
    idNumber: data.idNumber,
    createdAt: now,
    updatedAt: now
  };
  const ref = await col.add(payload);
  return { id: ref.id, ...payload };
}
async function deletePatient(phone, patientId) {
  await db.collection('users').doc(phone).collection('patients').doc(patientId).delete();
}

// ----- Validate -----
function isValidGender(t) { return t === '男' || t === '女'; }
function isValidDateYYYYMMDD(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y, m, d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === m && dt.getUTCDate() === d && y >= 1900 && y <= 2100;
}
function isValidId(t) { return typeof t === 'string' && t.trim().length >= 4; }

// ----- UI -----
function renderMenu(patients, firstTime = false) {
  const lines = [];
  if (firstTime || patients.length === 0) {
    lines.push('👋 歡迎使用預先問診系統。此電話尚未有病人資料。');
    lines.push('請先新增個人資料（依序：姓名→性別→出生日期→身份證號）。');
    lines.push('');
    lines.push('回覆「1」開始新增。');
    return lines.join('\n');
  }
  lines.push('👤 請選擇病人，或新增其他病人：');
  patients.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  lines.push(`${patients.length + 1}. ➕ 新增病人`);
  lines.push('');
  lines.push('請回覆編號（例如：1）。');
  return lines.join('\n');
}
function renderProfile(p) {
  return [
    '📄 病人個人資料',
    `姓名：${p.name}`,
    `性別：${p.gender}`,
    `出生日期：${p.birthDate}`,
    `身份證號碼：${p.idNumber}`
  ].join('\n');
}
function renderDeleteMenu(patients) {
  const lines = [];
  lines.push('📦 使用者最多可儲存 8 人資料。請選擇要刪除的一位：');
  patients.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  lines.push('');
  lines.push('回覆對應編號刪除，或輸入 **0** 返回上一頁。');
  return lines.join('\n');
}

// 回上一頁輔助（每個輸入畫面支援 0）
function isBackKey(text) {
  return typeof text === 'string' && text.trim() === '0';
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.get('/', (req, res) => res.status(200).send('OK'));

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();

  const rawFrom = (req.body.From ?? req.body.FromNumber ?? '').toString();
  const phone = rawFrom.replace(/^whatsapp:/i, '').trim();
  const body = (req.body.Body || '').toString().trim();

  console.log('[INBOUND]', { from: rawFrom, parsedPhone: phone, bodyPreview: body.slice(0, 120) });

  if (!phone) {
    return sendReply(res, twiml, '系統未能識別你的電話號碼，請透過 WhatsApp 連結重新進入。');
  }

  try {
    await ensureAccount(phone);
    let session = await getSession(phone);
    session.module = 'patientName';
    let patients = await listPatients(phone);

    // INIT
    if (session.state === 'INIT') {
      if (patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = {};
        await saveSession(session);
        return sendReply(res, twiml, '首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）');
      } else {
        session.state = 'MENU';
        await saveSession(session);
        return sendReply(res, twiml, renderMenu(patients));
      }
    }

    switch (session.state) {
      case 'MENU': {
        const n = Number(body);
        if (patients.length === 0) {
          session.state = 'ADD_NAME';
          session.temp = {};
          await saveSession(session);
          return sendReply(res, twiml, '首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）');
        }
        if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
          if (n <= patients.length) {
            const chosen = patients[n - 1];
            return sendReply(res, twiml, `${renderProfile(chosen)}\n\n（已回到主選單）\n\n${renderMenu(patients)}`);
          }
          // 新增
          if (n === patients.length + 1) {
            if (patients.length >= 8) {
              session.state = 'DELETE_MENU';
              await saveSession(session);
              return sendReply(res, twiml, '⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients));
            }
            session.state = 'ADD_NAME';
            session.temp = {};
            await saveSession(session);
            return sendReply(res, twiml, '1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）');
          }
        }
        await saveSession(session);
        return sendReply(res, twiml, renderMenu(patients));
      }

      case 'ADD_NAME': {
        if (isBackKey(body)) {
          // 回上一頁 → MENU
          session.state = 'MENU';
          await saveSession(session);
          return sendReply(res, twiml, renderMenu(patients, patients.length === 0));
        }
        if (!body) return sendReply(res, twiml, '請輸入有效的姓名（身份證姓名）。\n（輸入 0 回上一頁）');
        session.temp.name = body;
        session.state = 'ADD_GENDER';
        await saveSession(session);
        return sendReply(res, twiml, '2️⃣ 請輸入性別（回覆「男」或「女」）。\n（輸入 0 回上一頁）');
      }

      case 'ADD_GENDER': {
        if (isBackKey(body)) {
          session.state = 'ADD_NAME';
          await saveSession(session);
          return sendReply(res, twiml, '1️⃣ 請輸入姓名（身份證姓名）。\n（輸入 0 回上一頁）');
        }
        if (!isValidGender(body)) return sendReply(res, twiml, '格式不正確。請回覆「男」或「女」。\n（輸入 0 回上一頁）');
        session.temp.gender = body;
        session.state = 'ADD_DOB';
        await saveSession(session);
        return sendReply(res, twiml, '3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（輸入 0 回上一頁）');
      }

      case 'ADD_DOB': {
        if (isBackKey(body)) {
          session.state = 'ADD_GENDER';
          await saveSession(session);
          return sendReply(res, twiml, '2️⃣ 請輸入性別（回覆「男」或「女」）。\n（輸入 0 回上一頁）');
        }
        if (!isValidDateYYYYMMDD(body)) {
          return sendReply(res, twiml, '出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）。\n（輸入 0 回上一頁）');
        }
        session.temp.birthDate = body;
        session.state = 'ADD_ID';
        await saveSession(session);
        return sendReply(res, twiml, '4️⃣ 請輸入身份證號碼：\n（輸入 0 回上一頁）');
      }

      case 'ADD_ID': {
        if (isBackKey(body)) {
          session.state = 'ADD_DOB';
          await saveSession(session);
          return sendReply(res, twiml, '3️⃣ 請輸入出生日期（YYYY-MM-DD，例如：1978-01-21）。\n（輸入 0 回上一頁）');
        }
        if (!isValidId(body)) return sendReply(res, twiml, '身份證號碼不正確，請重新輸入（至少 4 個字元）。\n（輸入 0 回上一頁）');

        // 寫入前再檢查是否已達 8 人（避免競態）
        patients = await listPatients(phone);
        if (patients.length >= 8) {
          session.state = 'DELETE_MENU';
          await saveSession(session);
          return sendReply(res, twiml, '⚠️ 已達 8 人上限，無法新增。\n\n' + renderDeleteMenu(patients));
        }

        session.temp.idNumber = body;
        const created = await addPatient(phone, session.temp);

        // 清暫存、回主選單
        session.state = 'MENU';
        session.temp = {};
        await saveSession(session);

        patients = await listPatients(phone);
        return sendReply(res, twiml,
          `💾 已儲存。\n\n${renderProfile(created)}\n\n（已回到主選單）\n\n${renderMenu(patients)}`
        );
      }

      case 'DELETE_MENU': {
        // 0 返回上一頁
        if (isBackKey(body)) {
          session.state = 'MENU';
          await saveSession(session);
          return sendReply(res, twiml, renderMenu(patients));
        }
        // 選擇要刪除的人
        const n = Number(body);
        if (Number.isInteger(n) && n >= 1 && n <= patients.length) {
          const target = patients[n - 1];
          await deletePatient(phone, target.id);
          session.state = 'MENU';
          await saveSession(session);
          const after = await listPatients(phone);
          return sendReply(res, twiml, `🗑️ 已刪除：${target.name}\n\n${renderMenu(after)}`);
        }
        // 其他輸入 → 重顯刪除選單
        return sendReply(res, twiml, renderDeleteMenu(patients));
      }

      default: {
        session.state = 'MENU';
        await saveSession(session);
        return sendReply(res, twiml, renderMenu(patients, patients.length === 0));
      }
    }
  } catch (err) {
    console.error('❌ Handler error:', err && err.stack ? err.stack : err);
    const twiml = new MessagingResponse();
    return sendReply(res, twiml, '系統暫時忙碌，請稍後再試。');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[BOOT] WhatsApp bot running on ${PORT}`));




