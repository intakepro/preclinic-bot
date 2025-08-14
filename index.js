// index.js — 單檔可部署（Twilio WhatsApp + Firestore）
// 需求：
//  - 病人按連結傳任何字 → 以電話號碼當帳號
//  - 若帳號無資料 → 引導首次建檔（姓名→性別→出生日期→身份證）→ 儲存 → 回到主選單
//  - 若已有資料 → 列出所有姓名供選擇；亦可新增其他病人
//  - 選定姓名後 → 顯示其個人資料
//  - 加入「電話為空」防呆，避免 Firestore .doc('') 錯誤
//  - 內建健康檢查路由與錯誤日誌

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// --- Firestore 初始化 ---
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    console.log('[BOOT] Firebase via FIREBASE_SERVICE_ACCOUNT');
  } catch (e) {
    console.error('[BOOT] FIREBASE_SERVICE_ACCOUNT JSON 解析失敗：', e.message);
    // 仍嘗試以預設憑證啟動，避免整個服務掛掉
    admin.initializeApp();
  }
} else {
  admin.initializeApp();
  console.log('[BOOT] Firebase via default credentials (GOOGLE_APPLICATION_CREDENTIALS)');
}
const db = admin.firestore();

// ------------- 共用：回覆 -------------
function sendReply(res, twiml, text) {
  twiml.message(text);
  res.type('text/xml').send(twiml.toString());
}

// ------------- Session 工具 -------------
async function getSession(phone) {
  const ref = db.collection('sessions').doc(phone);
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = {
      phone,
      module: 'patientName',
      state: 'INIT', // INIT | MENU | ADD_NAME | ADD_GENDER | ADD_DOB | ADD_ID | VIEW_PROFILE
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

// ------------- 帳號/病人資料 -------------
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
  return out;
}
async function addPatient(phone, data) {
  const col = db.collection('users').doc(phone).collection('patients');
  const now = new Date();
  const payload = {
    name: data.name,
    gender: data.gender,        // '男' | '女'
    birthDate: data.birthDate,  // 'YYYY-MM-DD'
    idNumber: data.idNumber,
    createdAt: now,
    updatedAt: now
  };
  const docRef = await col.add(payload);
  return { id: docRef.id, ...payload };
}

// ------------- 驗證 -------------
function isValidGender(t) { return t === '男' || t === '女'; }
function isValidDateYYYYMMDD(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y, m, d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y &&
         (dt.getUTCMonth() + 1) === m &&
         dt.getUTCDate() === d &&
         y >= 1900 && y <= 2100;
}
function isValidId(t) { return typeof t === 'string' && t.trim().length >= 4; }

// ------------- 文案 -------------
function renderMenu(patients, firstTime = false) {
  const lines = [];
  if (firstTime || patients.length === 0) {
    lines.push('👋 歡迎使用預先問診系統。偵測到此電話尚未有病人資料。');
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

// ------------- App 與路由 -------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 健康檢查（方便 Render / 瀏覽器檢測）
app.get('/', (req, res) => res.status(200).send('OK'));

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();

  // 1) 取電話：加強防呆，避免為空
  const rawFrom = (req.body.From ?? req.body.FromNumber ?? '').toString();
  const phone = rawFrom.replace(/^whatsapp:/i, '').trim();
  const body = (req.body.Body || '').toString().trim();

  console.log('[INBOUND]', {
    from: rawFrom,
    parsedPhone: phone,
    bodyPreview: body.slice(0, 120)
  });

  if (!phone) {
    console.error('❌ 無法取得電話號碼 From，拒絕進一步存取 Firestore .doc()');
    return sendReply(
      res, twiml,
      '系統未能識別你的電話號碼，請從 WhatsApp 啟動連結重新進入，或直接回覆此對話一次。'
    );
  }

  try {
    // 2) 確保帳號；抓 session 與名單
    await ensureAccount(phone);
    let session = await getSession(phone);
    session.module = 'patientName';

    let patients = await listPatients(phone);

    // 3) 首次進入
    if (session.state === 'INIT') {
      if (patients.length === 0) {
        session.state = 'ADD_NAME';
        session.temp = {};
        await saveSession(session);
        return sendReply(res, twiml, '首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（請依「身份證姓名」輸入）：');
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
        if (patients.length === 0) {
          session.state = 'ADD_NAME';
          session.temp = {};
          await saveSession(session);
          return sendReply(res, twiml, '首次使用：請輸入個人資料。\n\n1️⃣ 請輸入姓名（請依「身份證姓名」輸入）：');
        }
        if (Number.isInteger(n) && n >= 1 && n <= patients.length + 1) {
          if (n <= patients.length) {
            const chosen = patients[n - 1];
            const profileText = renderProfile(chosen);
            const menuText = renderMenu(patients);
            return sendReply(res, twiml, `${profileText}\n\n（已回到主選單）\n\n${menuText}`);
          }
          // 新增
          if (n === patients.length + 1) {
            session.state = 'ADD_NAME';
            session.temp = {};
            await saveSession(session);
            return sendReply(res, twiml, '1️⃣ 請輸入姓名（請依「身份證姓名」輸入）：');
          }
        }
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
        session.state = 'ADD_DOB';
        await saveSession(session);
        return sendReply(res, twiml, '3️⃣ 請輸入出生日期（格式：YYYY-MM-DD，例如：1978-01-21）：');
      }

      case 'ADD_DOB': {
        if (!isValidDateYYYYMMDD(body)) {
          return sendReply(res, twiml, '出生日期格式不正確。請用 YYYY-MM-DD（例如：1978-01-21）：');
        }
        session.temp.birthDate = body;
        session.state = 'ADD_ID';
        await saveSession(session);
        return sendReply(res, twiml, '4️⃣ 請輸入身份證號碼：');
      }

      case 'ADD_ID': {
        if (!isValidId(body)) return sendReply(res, twiml, '身份證號碼不正確，請重新輸入（至少 4 個字元）：');

        session.temp.idNumber = body;

        // 寫入
        const created = await addPatient(phone, session.temp);

        // 清暫存、回主選單
        session.state = 'MENU';
        session.temp = {};
        await saveSession(session);

        // 重新載入列表
        patients = await listPatients(phone);

        return sendReply(
          res,
          twiml,
          `💾 已儲存。\n\n${renderProfile(created)}\n\n（已回到主選單）\n\n${renderMenu(patients)}`
        );
      }

      default: {
        session.state = 'MENU';
        await saveSession(session);
        return sendReply(res, twiml, renderMenu(patients, patients.length === 0));
      }
    }
  } catch (err) {
    console.error('❌ Handler error:', err && err.stack ? err.stack : err);
    // 優雅回覆使用者，避免 Twilio 逾時
    return sendReply(res, twiml, '系統暫時忙碌，請稍後再試。若持續出現問題，請把這段訊息截圖給診所。');
  }
});

// Render/Twilio 入口
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[BOOT] WhatsApp bot running on ${PORT}`));


