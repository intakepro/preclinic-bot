// modules/history.js
// Version: v6.3.0-fs-match-index
// 目的：與 index v6.4.x 介面完全對齊：handleHistory({ msg, from, patientId, patientName }) -> { text, done }
// 變更重點：
// - 接受 msg/from/patientId/patientName；回傳 { text, done }（不再使用 { message } 或 createHistoryModule 工廠）
// - 病史儲存：history/{phone#patientId}、history_sessions/{phone#patientId}
// - 顯示舊資料時：頂部顯示「病人姓名＋電話末四碼」，並提示：1=更改、z=下一步
// - 全流程統一：z = 進入下一步；0 = 返回上一層；1 = 進入/確認更改；其他數字依畫面
// - 僅回文字，Twilio 回覆由 index 統一處理

'use strict';
const admin = require('firebase-admin');

// ---- Firebase init (once) ----
(function ensureFirebase() {
  if (admin.apps.length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[history] Firebase via FIREBASE_SERVICE_ACCOUNT');
    } else {
      admin.initializeApp();
      console.log('[history] Firebase via default credentials');
    }
  } catch (e) {
    console.error('[history] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();

// ---- helpers ----
const phoneOf = (from) =>
  (from || '').toString().replace(/^whatsapp:/i, '').trim();

const histKey = (phone, patientId) => `${phone}#${patientId}`;
const isZ = (s='') => s.trim().toLowerCase() === 'z';
const isBack = (s='') => s.trim() === '0';
const last4 = (phone) => (String(phone).replace(/\D/g,'').slice(-4) || '').padStart(4, '*');

const STATES = {
  ENTRY: 'H_ENTRY',
  SHOW_EXISTING: 'H_SHOW',
  PMH: 'H_PMH',
  MEDS: 'H_MEDS',
  ALG_MENU: 'H_ALG_MENU',
  ALG_TYPES: 'H_ALG_TYPES',
  ALG_ITEMS: 'H_ALG_ITEMS',
  SOC_MENU: 'H_SOC_MENU',
  SOC_SMK: 'H_SOC_SMK',
  SOC_ALC: 'H_SOC_ALC',
  SOC_TRV: 'H_SOC_TRV',
  REVIEW: 'H_REVIEW'
};

const toArray = (text) =>
  String(text || '')
    .split(/[,，、\n]/)
    .map(s => s.trim())
    .filter(Boolean);

const fmtList = (arr) => (Array.isArray(arr) && arr.length)
  ? arr.map(v => `  • ${v}`).join('\n')
  : '（無）';

const fmtText = (s) => (s && String(s).trim() ? String(s).trim() : '（無）');

const banner = (name, phone) => `👤 病人：${name || '（未命名）'}（${last4(phone)}）`;

function renderSummary(h = {}) {
  const pmh = fmtList(h.pmh);
  const meds = fmtList(h.meds);
  const types = fmtList(h.allergies?.types || []);
  const items = fmtList(h.allergies?.items || []);
  const smoking = fmtText(h.social?.smoking);
  const alcohol = fmtText(h.social?.alcohol);
  const travel  = fmtText(h.social?.travel);
  return [
    '📋 病史摘要：',
    '',
    '— 過去病史（PMH）—',
    pmh,
    '',
    '— 現用藥（Meds）—',
    meds,
    '',
    '— 過敏（Allergies）—',
    `  類型：\n${types}`,
    `  明細：\n${items}`,
    '',
    '— 社會史（Social）—',
    `  吸菸：${smoking}`,
    `  飲酒：${alcohol}`,
    `  旅遊：${travel}`,
  ].join('\n');
}

const decisionPrompt = '是否要更改病史？\n1️⃣ 更改\nz️⃣ 下一步（保持不變）\n（請輸入 1 或 z）';
const editMenuText = '請選擇要更改的項目：\n1️⃣ 過去病史（PMH）\n2️⃣ 現用藥（Meds）\n3️⃣ 過敏（Allergies）\n4️⃣ 社會史（Social）\n0️⃣ 返回上一層選單';
const allergiesMenuText = '過敏（Allergies）要更改哪一項？\n1️⃣ 類型（types）\n2️⃣ 明細（items）\n0️⃣ 返回上一層';
const socialMenuText = '社會史（Social）要更改哪一項？\n1️⃣ 吸菸（smoking）\n2️⃣ 飲酒（alcohol）\n3️⃣ 旅遊（travel）\n0️⃣ 返回上一層';

function ensureHistoryShape(h = {}) {
  return {
    pmh: Array.isArray(h.pmh) ? h.pmh : [],
    meds: Array.isArray(h.meds) ? h.meds : [],
    allergies: {
      types: Array.isArray(h.allergies?.types) ? h.allergies.types : [],
      items: Array.isArray(h.allergies?.items) ? h.allergies.items : [],
    },
    social: {
      smoking: h.social?.smoking || '',
      alcohol: h.social?.alcohol || '',
      travel:  h.social?.travel  || '',
    }
  };
}

// ---- Firestore I/O ----
async function getHistSession(key) {
  const ref = db.collection('history_sessions').doc(key);
  const s = await ref.get();
  if (!s.exists) {
    const fresh = { state: STATES.ENTRY, buffer: {}, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    await ref.set(fresh);
    return { ref, data: fresh };
  }
  return { ref, data: s.data() || { state: STATES.ENTRY, buffer: {} } };
}
async function setHistSession(key, patch) {
  const ref = db.collection('history_sessions').doc(key);
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function getHistoryDoc(key) {
  const ref = db.collection('history').doc(key);
  const s = await ref.get();
  return s.exists ? (s.data()?.history || null) : null;
}
async function saveHistoryDoc(key, historyObj) {
  await db.collection('history').doc(key).set(
    { history: historyObj, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function getPatientProfile(phone, patientId) {
  const ref = db.collection('users').doc(phone).collection('patients').doc(patientId);
  const s = await ref.get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}

// ---- 主處理器：index 會呼叫這個 ----
async function handleHistory({ msg, from, patientId, patientName }) {
  const phone = phoneOf(from);
  if (!phone) return { text: '（系統）未能識別電話，請重新進入。', done: false };
  if (!patientId) return { text: '（系統）尚未選定病人，請先於第 1 步選擇病人。', done: false };

  const key = histKey(phone, patientId);
  const input = (msg || '').trim();

  // 讀 profile & history & session
  const profile = await getPatientProfile(phone, patientId);
  const history = ensureHistoryShape(await getHistoryDoc(key) || {});
  const { data: session } = await getHistSession(key);

  // 進入點
  if (session.state === STATES.ENTRY) {
    // 若已有任何病史 → 顯示、問更改或下一步；否則直接引導建立
    const hasAny =
      history.pmh.length || history.meds.length ||
      history.allergies.types.length || history.allergies.items.length ||
      history.social.smoking || history.social.alcohol || history.social.travel;

    if (hasAny) {
      await setHistSession(key, { state: STATES.SHOW_EXISTING });
      return {
        text: [
          banner(profile?.name || patientName, phone),
          '',
          renderSummary(history),
          '',
          decisionPrompt
        ].join('\n'),
        done: false
      };
    } else {
      await setHistSession(key, { state: STATES.PMH, buffer: {} });
      return {
        text: [
          banner(profile?.name || patientName, phone),
          '尚未建立病史，先從「過去病史（PMH）」開始。',
          '請輸入過去病史，多項以「，」、「、」或換行分隔。',
          '（例如：高血壓、糖尿病、痛風）'
        ].join('\n'),
        done: false
      };
    }
  }

  // 狀態機
  switch (session.state) {
    case STATES.SHOW_EXISTING: {
      if (input === '1') {
        await setHistSession(key, { state: STATES.PMH, buffer: {} });
        return { text: '請輸入「過去病史（PMH）」清單，多項可用逗號或換行分隔。', done: false };
      }
      if (isZ(input)) {
        // 下一步
        await setHistSession(key, { state: STATES.ENTRY, buffer: {} }); // 重置
        return { text: '✅ 病史保持不變，將進入下一步。', done: true };
      }
      return { text: '請輸入 1（更改）或 z（下一步）。', done: false };
    }

    // PMH
    case STATES.PMH: {
      if (isBack(input)) {
        await setHistSession(key, { state: STATES.SHOW_EXISTING, buffer: {} });
        return {
          text: [
            banner(profile?.name || patientName, phone),
            '',
            renderSummary(history),
            '',
            decisionPrompt
          ].join('\n'),
          done: false
        };
      }
      const pmh = toArray(input);
      const newH = ensureHistoryShape({ ...history, pmh });
      await saveHistoryDoc(key, newH);
      await setHistSession(key, { state: STATES.MEDS, buffer: {} });
      return { text: '✅ 已更新 PMH。\n請輸入「現用藥（Meds）」清單，多項可用逗號或換行分隔。', done: false };
    }

    case STATES.MEDS: {
      if (isBack(input)) {
        await setHistSession(key, { state: STATES.PMH, buffer: {} });
        return { text: '請輸入「過去病史（PMH）」清單，多項可用逗號或換行分隔。', done: false };
      }
      const meds = toArray(input);
      const newH = ensureHistoryShape({ ...history, meds });
      await saveHistoryDoc(key, newH);
      await setHistSession(key, { state: STATES.ALG_MENU, buffer: {} });
      return { text: '✅ 已更新 Meds。\n' + allergiesMenuText, done: false };
    }

    case STATES.ALG_MENU: {
      if (input === '1') {
        await setHistSession(key, { state: STATES.ALG_TYPES });
        return { text: '請輸入「過敏類型（types）」清單，例如：藥物、食物、環境。', done: false };
      }
      if (input === '2') {
        await setHistSession(key, { state: STATES.ALG_ITEMS });
        return { text: '請輸入「過敏明細（items）」清單，例如：阿莫西林、花生。', done: false };
      }
      if (input === '0') {
        await setHistSession(key, { state: STATES.MEDS });
        return { text: '請輸入「現用藥（Meds）」清單，多項可用逗號或換行分隔。', done: false };
      }
      if (isZ(input)) {
        await setHistSession(key, { state: STATES.SOC_MENU });
        return { text: '跳過過敏，前往社會史。\n' + socialMenuText, done: false };
      }
      return { text: '請輸入 1/2（編輯）或 0 返回上一層；或按 z 跳過。', done: false };
    }

    case STATES.ALG_TYPES: {
      if (isBack(input)) {
        await setHistSession(key, { state: STATES.ALG_MENU });
        return { text: allergiesMenuText, done: false };
      }
      const types = toArray(input);
      const newH = ensureHistoryShape({ ...history, allergies: { ...(history.allergies||{}), types } });
      await saveHistoryDoc(key, newH);
      await setHistSession(key, { state: STATES.ALG_MENU });
      return { text: '✅ 已更新過敏類型。\n' + allergiesMenuText, done: false };
    }

    case STATES.ALG_ITEMS: {
      if (isBack(input)) {
        await setHistSession(key, { state: STATES.ALG_MENU });
        return { text: allergiesMenuText, done: false };
      }
      const items = toArray(input);
      const newH = ensureHistoryShape({ ...history, allergies: { ...(history.allergies||{}), items } });
      await saveHistoryDoc(key, newH);
      await setHistSession(key, { state: STATES.ALG_MENU });
      return { text: '✅ 已更新過敏明細。\n' + allergiesMenuText, done: false };
    }

    case STATES.SOC_MENU: {
      if (input === '1') { await setHistSession(key, { state: STATES.SOC_SMK }); return { text: '請輸入吸菸情形（例如：不吸菸／已戒菸／每日半包）。', done:false }; }
      if (input === '2') { await setHistSession(key, { state: STATES.SOC_ALC }); return { text: '請輸入飲酒情形（例如：不飲酒／偶爾小酌／每週 2 次）。', done:false }; }
      if (input === '3') { await setHistSession(key, { state: STATES.SOC_TRV }); return { text: '請輸入近期旅遊史（例如：無／上月赴日本 5 天）。', done:false }; }
      if (input === '0') { await setHistSession(key, { state: STATES.ALG_MENU }); return { text: allergiesMenuText, done:false }; }
      if (isZ(input))  { await setHistSession(key, { state: STATES.REVIEW }); return { text: '（已跳過社會史）\n將進行總覽確認。請輸入任意鍵以顯示摘要。', done:false }; }
      return { text: '請輸入 1/2/3 或 0 返回；或按 z 跳過。', done:false };
    }

    case STATES.SOC_SMK: {
      if (isBack(input)) { await setHistSession(key, { state: STATES.SOC_MENU }); return { text: socialMenuText, done:false }; }
      const newH = ensureHistoryShape({ ...history, social: { ...(history.social||{}), smoking: fmtText(input) } });
      await saveHistoryDoc(key, newH);
      await setHistSession(key, { state: STATES.SOC_MENU });
      return { text: '✅ 已更新「吸菸」。\n' + socialMenuText, done:false };
    }
    case STATES.SOC_ALC: {
      if (isBack(input)) { await setHistSession(key, { state: STATES.SOC_MENU }); return { text: socialMenuText, done:false }; }
      const newH = ensureHistoryShape({ ...history, social: { ...(history.social||{}), alcohol: fmtText(input) } });
      await saveHistoryDoc(key, newH);
      await setHistSession(key, { state: STATES.SOC_MENU });
      return { text: '✅ 已更新「飲酒」。\n' + socialMenuText, done:false };
    }
    case STATES.SOC_TRV: {
      if (isBack(input)) { await setHistSession(key, { state: STATES.SOC_MENU }); return { text: socialMenuText, done:false }; }
      const newH = ensureHistoryShape({ ...history, social: { ...(history.social||{}), travel: fmtText(input) } });
      await saveHistoryDoc(key, newH);
      await setHistSession(key, { state: STATES.SOC_MENU });
      return { text: '✅ 已更新「旅遊」。\n' + socialMenuText, done:false };
    }

    case STATES.REVIEW: {
      // 顯示總覽 + 問是否完成
      await setHistSession(key, { state: STATES.ENTRY, buffer: {} }); // 回到入口（下次再次進來會顯示現況）
      return {
        text: [
          banner(profile?.name || patientName, phone),
          '',
          renderSummary(history),
          '',
          '若無需再更改，請按 z 進入下一步；若要更改請輸入 1。'
        ].join('\n'),
        done: false
      };
    }

    default:
      await setHistSession(key, { state: STATES.ENTRY, buffer: {} });
      return { text: '（系統）已重置病史流程，請再試一次。', done: false };
  }
}

module.exports = { handleHistory };