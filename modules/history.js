/**
 * Module: modules/history.js
 * Version: v2025-08-17-01
 * 兼容：index v4.0.0（完成時回 { replied:true, done:true }）
 *
 * 功能：
 * - 進入時讀取 users/{phone}/history
 * - 若尚未建立：請病人輸入病史（自由文字）→ 儲存 → 完成
 * - 若已存在：顯示現有病史，詢問是否需要更改（1=是、2=否）
 *   - 1：進入編輯 → 病人輸入新病史 → 儲存 → 完成
 *   - 2：不更改 → 直接完成
 * - 支援回上一項：0 / prev / ←
 */

const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// ---------- Firebase 初始化（與 name_input 一致） ----------
let _initialized = false;
function ensureFirebase() {
  if (_initialized) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[history] Firebase via FIREBASE_SERVICE_ACCOUNT');
    } catch (e) {
      console.error('[history] FIREBASE_SERVICE_ACCOUNT JSON parse failed:', e.message);
      admin.initializeApp();
    }
  } else {
    admin.initializeApp();
    console.log('[history] Firebase via default credentials');
  }
  _initialized = true;
}
function db() { ensureFirebase(); return admin.firestore(); }

// ---------- Firestore I/O ----------
async function ensureAccount(phone) {
  const userRef = db().collection('users').doc(phone);
  const snap = await userRef.get();
  if (!snap.exists) {
    await userRef.set({ phone, createdAt: new Date(), updatedAt: new Date() });
  } else {
    await userRef.set({ updatedAt: new Date() }, { merge: true });
  }
}
async function getHistory(phone) {
  const ref = db().collection('users').doc(phone).collection('meta').doc('history');
  const s = await ref.get();
  return s.exists ? { id: ref.id, ...(s.data() || {}) } : null;
}
async function saveHistory(phone, text) {
  const ref = db().collection('users').doc(phone).collection('meta').doc('history');
  const now = new Date();
  await ref.set({ text, updatedAt: now, createdAt: now }, { merge: true });
}

// ---------- Session（僅供本模組使用） ----------
async function getSession(phone) {
  const ref = db().collection('sessions').doc(`${phone}__history`);
  const snap = await ref.get();
  if (!snap.exists) {
    const fresh = { phone, module: 'history', state: 'INIT', temp: {}, updatedAt: new Date() };
    await ref.set(fresh);
    return fresh;
  }
  const data = snap.data() || {};
  data.phone = phone;
  return data;
}
async function saveSession(session) {
  session.updatedAt = new Date();
  await db().collection('sessions').doc(`${session.phone}__history`).set(session, { merge: true });
}

// ---------- 工具 ----------
function isBackKey(t) {
  const v = (t || '').trim().toLowerCase();
  return v === '0' || v === 'prev' || v === '←';
}
function reply(res, text) {
  const tw = new MessagingResponse();
  tw.message(text);
  res.type('text/xml').send(tw.toString());
  return { replied: true, done: false };
}
function showHistoryText(h) {
  const content = (h && h.text) ? h.text : '（尚未填寫）';
  return `📄 現有病史：\n${content}`;
}

// ---------- 主處理器 ----------
async function handleHistory({ req, res }) {
  ensureFirebase();

  const rawFrom = (req.body?.From ?? req.body?.FromNumber ?? '').toString();
  const phone   = rawFrom.replace(/^whatsapp:/i, '').trim();
  const body    = (req.body?.Body ?? '').toString().trim();

  if (!phone) {
    return reply(res, '系統未能識別你的電話號碼，請透過 WhatsApp 連結重新進入。');
  }

  try {
    await ensureAccount(phone);
    let session = await getSession(phone);
    let history = await getHistory(phone);

    // INIT：根據是否已有病史決定下一步
    if (session.state === 'INIT') {
      if (!history) {
        session.state = 'EDITING';
        session.temp = {};
        await saveSession(session);
        return reply(res,
          '📝 尚未建立病史，請直接輸入你的病史（自由文字）。\n（回上一項：0 / prev / ←）'
        );
      } else {
        session.state = 'CONFIRM_EDIT';
        await saveSession(session);
        return reply(res,
          `${showHistoryText(history)}\n\n是否需要更改？\n1＝是　2＝否`
        );
      }
    }

    // CONFIRM_EDIT：1編輯，2不改→完成
    if (session.state === 'CONFIRM_EDIT') {
      if (isBackKey(body)) {
        // 回到 INIT，再走一次邏輯（基本上會回到 CONFIRM_EDIT）
        session.state = 'INIT';
        await saveSession(session);
        return reply(res, `${showHistoryText(history)}\n\n是否需要更改？\n1＝是　2＝否`);
      }
      if (body === '1') {
        session.state = 'EDITING';
        session.temp = {};
        await saveSession(session);
        return reply(res,
          '✅ 好的，請輸入新的病史（自由文字）。\n（回上一項：0 / prev / ←）'
        );
      }
      if (body === '2') {
        // 不更改 → 完成
        const tw = new MessagingResponse();
        tw.message('👌 保持現有病史不變。將進入下一步。');
        res.type('text/xml').send(tw.toString());
        return { replied: true, done: true };
      }
      return reply(res, '請回覆「1」或「2」。\n（回上一項：0 / prev / ←）');
    }

    // EDITING：接收自由文字 → 儲存 → 完成
    if (session.state === 'EDITING') {
      if (isBackKey(body)) {
        // 有舊病史則回 CONFIRM_EDIT；沒有就仍停在 EDITING
        if (history) {
          session.state = 'CONFIRM_EDIT';
          await saveSession(session);
          return reply(res, `${showHistoryText(history)}\n\n是否需要更改？\n1＝是　2＝否`);
        }
        return reply(res,
          '📝 請直接輸入你的病史（自由文字）。\n（回上一項：0 / prev / ←）'
        );
      }
      if (!body) {
        return reply(res, '內容不可為空，請輸入病史（自由文字）。');
      }
      // 寫入
      await saveHistory(phone, body);

      // 清 session
      session.state = 'INIT';
      session.temp = {};
      await saveSession(session);

      const tw = new MessagingResponse();
      tw.message('💾 病史已儲存。將進入下一步。');
      res.type('text/xml').send(tw.toString());
      return { replied: true, done: true };
    }

    // 兜底：重設為 INIT
    session.state = 'INIT';
    await saveSession(session);
    return reply(res, '請稍等，系統已重置病史流程，請再次輸入。');

  } catch (err) {
    console.error('[history] error:', err && err.stack ? err.stack : err);
    return reply(res, '系統暫時忙碌，請稍後再試。');
  }
}

module.exports = { handleHistory };