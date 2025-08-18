// modules/history.js
// Version: 6
// 介面：async handleHistory({ from, msg, patientId, patientName }) -> { text, done }
// 說明：保留舊版流程（H_ENTRY→H_SHOW→H_FIRST→H_PMH...），
//       Firestore 持久化，頂部顯示病人姓名＋電話末四位。

'use strict';
const admin = require('firebase-admin');

// --- Firebase init (once) ---
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

// --- 常數（沿用舊版狀態與選項） ---
const STATES = {
  ENTRY: 'H_ENTRY',
  SHOW_EXISTING: 'H_SHOW',
  FIRST_NOTICE: 'H_FIRST',
  PMH_SELECT: 'H_PMH',
  PMH_OTHER_INPUT: 'H_PMH_OTHER',
  MEDS_YN: 'H_MEDS_YN',
  MEDS_INPUT: 'H_MEDS_IN',
  ALLERGY_YN: 'H_ALG_YN',
  ALLERGY_TYPE: 'H_ALG_T',
  ALLERGY_INPUT: 'H_ALG_IN',
  SOCIAL_SMOKE: 'H_SOC_SMK',
  SOCIAL_ALCOHOL: 'H_SOC_ALC',
  SOCIAL_TRAVEL: 'H_SOC_TRV',
  REVIEW: 'H_REVIEW',
  DONE: 'H_DONE'
};
const PMH_OPTIONS = [
  '高血壓','糖尿病','心臟病','腎臟病','肝病','中風','癌症','其他','無'
];
const YES='1', NO='2';

// --- 小工具 ---
const phoneOf = (from) => (from || '').toString().replace(/^whatsapp:/i,'').trim();
const last4 = (p) => String(p||'').replace(/\D/g,'').slice(-4).padStart(4,'*');
const banner = (name, phone) => `👤 病人：${name || '（未命名）'}（${last4(phone)}）`;
const nowTS = () => admin.firestore.FieldValue.serverTimestamp();

function commaNumListToIndices(text){
  return String(text||'').replace(/，/g,',')
    .split(',').map(s=>s.trim()).filter(Boolean)
    .map(n=>parseInt(n,10)).filter(n=>!Number.isNaN(n));
}
const isYesNo = (v) => v===YES || v===NO;
const fmtList = (arr) => (Array.isArray(arr)&&arr.length)?arr.join('、'):'無';

function initHistory(){
  return { pmh:[], meds:[], allergies:{ types:[], items:[] }, social:{ smoking:'', alcohol:'', travel:'' } };
}
function renderPMHMenu(){
  return '請選擇您曾經患有的疾病（可複選，用逗號分隔數字）：\n' +
    PMH_OPTIONS.map((t,i)=>`${i+1}️⃣ ${t}`).join('\n');
}
function renderSummary(h){
  const pmh = fmtList(h.pmh||[]);
  const meds = fmtList(h.meds||[]);
  const alTypes = fmtList(h.allergies?.types||[]);
  const alItems = fmtList(h.allergies?.items||[]);
  const smoking = h.social?.smoking || '未填';
  const alcohol = h.social?.alcohol || '未填';
  const travel  = h.social?.travel  || '未填';
  return [
    `- 過去病史：${pmh}`,
    `- 服用藥物：${meds}`,
    `- 過敏類型：${alTypes}`,
    `- 過敏明細：${alItems}`,
    `- 吸菸：${smoking}；飲酒：${alcohol}；近期出國：${travel}`
  ].join('\n');
}
function renderReview(h){
  return `感謝您提供病史資料 🙏\n以下是您剛填寫的內容：\n${renderSummary(h)}\n\n請問需要更改嗎？\n1️⃣ 需要更改\n2️⃣ 不需要，直接繼續`;
}

// --- Firestore I/O ---
// Index 的 session（用來讀 selectedPatient）
async function readIndexSession(fromPhone){
  const s = await db.collection('sessions').doc(fromPhone).get();
  return s.exists ? s.data() : {};
}
// History 專用 session
async function getHistSession(fromPhone){
  const ref = db.collection('history_sessions').doc(fromPhone);
  const s = await ref.get();
  if (s.exists) return s.data();
  const fresh = { state: STATES.ENTRY, buffer:{}, updatedAt: nowTS() };
  await ref.set(fresh);
  return fresh;
}
async function saveHistSession(fromPhone, patch){
  await db.collection('history_sessions').doc(fromPhone)
    .set({ ...patch, updatedAt: nowTS() }, { merge:true });
}
// 病人資料：users/{phone}/patients/{patientId}
function patientRef(fromPhone, patientId){
  return db.collection('users').doc(fromPhone)
           .collection('patients').doc(patientId);
}
async function readPatient(fromPhone, patientId){
  const s = await patientRef(fromPhone, patientId).get();
  return s.exists ? { id: patientId, ...s.data() } : null;
}
async function writeHistory(fromPhone, patientId, historyObj){
  await patientRef(fromPhone, patientId).set(
    { history: historyObj, updatedAt: nowTS() },
    { merge: true }
  );
}

// 針對「0」返回目前狀態提示
function resendPromptForState(state){
  switch(state){
    case STATES.SHOW_EXISTING:  return '請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續';
    case STATES.FIRST_NOTICE:   return '請輸入 1️⃣ 繼續';
    case STATES.PMH_SELECT:     return renderPMHMenu();
    case STATES.PMH_OTHER_INPUT:return '請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）';
    case STATES.MEDS_YN:        return '您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有';
    case STATES.MEDS_INPUT:     return '請輸入正在服用的藥物名稱（可多個，以逗號或頓號分隔）';
    case STATES.ALLERGY_YN:     return '是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無';
    case STATES.ALLERGY_TYPE:   return '過敏類型（可複選，用逗號分隔）：\n1️⃣ 藥物\n2️⃣ 食物\n3️⃣ 其他';
    case STATES.ALLERGY_INPUT:  return '請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）';
    case STATES.SOCIAL_SMOKE:   return '吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）';
    case STATES.SOCIAL_ALCOHOL: return '飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n（若不喝請輸入：無）';
    case STATES.SOCIAL_TRAVEL:  return '最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無';
    case STATES.REVIEW:         return '請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續';
    default:                    return '請依畫面輸入對應選項。';
  }
}

// --- 主處理器（配合 index 6.4.6） ---
async function handleHistory({ from, msg, patientId, patientName }) {
  const fromPhone = phoneOf(from);
  const body = (msg || '').trim();

  if (!fromPhone) return { text: '病史模組啟動失敗：無法識別電話號碼。', done:false };

  // 若 index 未帶 patient 資訊，嘗試從 index session 讀
  if (!patientId || !patientName) {
    const idx = await readIndexSession(fromPhone);
    const sel = idx.selectedPatient || {};
    patientId   = patientId   || sel.patientId;
    patientName = patientName || sel.name;
  }
  if (!patientId) {
    return { text: '⚠️ 尚未選定病人，請先完成第 1 步（選擇或新增病人）。', done:false };
  }

  // 讀取 history session 與 patient
  let session = await getHistSession(fromPhone);
  const pDoc = await readPatient(fromPhone, patientId);
  const nameForBanner  = pDoc?.name  || patientName || '（未命名）';
  const phoneForBanner = fromPhone; // 使用對話方電話末四位

  // 特例：輸入 "0" → 重送當前狀態提示（沿用舊版習慣）
  if (body === '0') {
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${resendPromptForState(session.state)}`, done:false };
  }

  const existing = pDoc?.history || null;

  // 入口
  if (session.state === STATES.ENTRY){
    if (existing){
      session.state = STATES.SHOW_EXISTING;
      await saveHistSession(fromPhone, session);
      return {
        text:
`${banner(nameForBanner, phoneForBanner)}
您之前輸入的病史資料如下：
${renderSummary(existing)}

請問需要更改嗎？
1️⃣ 需要更改
2️⃣ 不需要，直接繼續`,
        done:false
      };
    }
    session.state = STATES.FIRST_NOTICE;
    await saveHistSession(fromPhone, session);
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}
由於您第一次使用這個電話號碼進行預先問診，
我們需要花大約 2–3 分鐘收集您的基本病史資料。

請輸入 1️⃣ 繼續`,
      done:false
    };
  }

  if (session.state === STATES.SHOW_EXISTING){
    if (!isYesNo(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續`, done:false };
    if (body === YES){
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${renderPMHMenu()}`, done:false };
    }
    session.state = STATES.DONE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n✅ 病史已確認無需更改，將為您進入下一個模組。`, done:true };
  }

  if (session.state === STATES.FIRST_NOTICE){
    if (body !== YES)
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 繼續`, done:false };
    session.state = STATES.PMH_SELECT;
    session.buffer = { history: initHistory() };
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${renderPMHMenu()}`, done:false };
  }

  // PMH
  if (session.state === STATES.PMH_SELECT){
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=PMH_OPTIONS.length)){
      return { text: `${banner(nameForBanner, phoneForBanner)}\n格式不正確，請以逗號分隔數字，例如：1,2 或 1,3,7\n\n${renderPMHMenu()}`, done:false };
    }
    const names = [];
    let needOther = false, isNone = false;
    for (const n of idxs){
      if (n===8) needOther = true;
      if (n===9) isNone = true;
      names.push(PMH_OPTIONS[n-1]);
    }
    if (isNone) session.buffer.history.pmh = [];
    else session.buffer.history.pmh = names.filter(x=>x!=='其他' && x!=='無');

    if (needOther && !isNone){
      session.state = STATES.PMH_OTHER_INPUT;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）`, done:false };
    }
    session.state = STATES.MEDS_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有`, done:false };
  }

  if (session.state === STATES.PMH_OTHER_INPUT){
    const extra = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.pmh.push(...extra);
    session.state = STATES.MEDS_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有`, done:false };
  }

  // 用藥
  if (session.state === STATES.MEDS_YN){
    if (!isYesNo(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 有 或 2️⃣ 沒有`, done:false };
    if (body === YES){
      session.state = STATES.MEDS_INPUT;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入正在服用的藥物名稱（可多個，以逗號或頓號分隔）`, done:false };
    }
    session.buffer.history.meds = [];
    session.state = STATES.ALLERGY_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無`, done:false };
  }

  if (session.state === STATES.MEDS_INPUT){
    const meds = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.meds = meds;
    session.state = STATES.ALLERGY_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無`, done:false };
  }

  // 過敏
  if (session.state === STATES.ALLERGY_YN){
    if (!isYesNo(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 有 或 2️⃣ 無`, done:false };
    if (body === YES){
      session.state = STATES.ALLERGY_TYPE;
      session.buffer.history.allergies = { types:[], items:[] };
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n過敏類型（可複選，用逗號分隔）：\n1️⃣ 藥物\n2️⃣ 食物\n3️⃣ 其他`, done:false };
    }
    session.buffer.history.allergies = { types:[], items:[] };
    session.state = STATES.SOCIAL_SMOKE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）`, done:false };
  }

  if (session.state === STATES.ALLERGY_TYPE){
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=3)){
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請以逗號分隔數字，例如：1,2（1=藥物 2=食物 3=其他）`, done:false };
    }
    const map={1:'藥物',2:'食物',3:'其他'};
    session.buffer.history.allergies.types = [...new Set(idxs.map(n=>map[n]))];
    session.state = STATES.ALLERGY_INPUT;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）`, done:false };
  }

  if (session.state === STATES.ALLERGY_INPUT){
    const items = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.allergies.items = items;
    session.state = STATES.SOCIAL_SMOKE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）`, done:false };
  }

  // 社會史
  if (session.state === STATES.SOCIAL_SMOKE){
    const v = body.trim();
    let smoking='';
    if (v===YES) smoking='有';
    else if (v===NO) smoking='無';
    else if (v==='已戒') smoking='已戒';
    else return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 有、2️⃣ 無，或輸入「已戒」`, done:false };
    session.buffer.history.social.smoking = smoking;
    session.state = STATES.SOCIAL_ALCOHOL;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n（若不喝請輸入：無）`, done:false };
  }

  if (session.state === STATES.SOCIAL_ALCOHOL){
    const v = body.trim();
    let alcohol='';
    if (v===YES) alcohol='每天';
    else if (v===NO) alcohol='偶爾';
    else if (v==='無') alcohol='無';
    else return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 每天、2️⃣ 偶爾，或輸入「無」`, done:false };
    session.buffer.history.social.alcohol = alcohol;
    session.state = STATES.SOCIAL_TRAVEL;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無`, done:false };
  }

  if (session.state === STATES.SOCIAL_TRAVEL){
    if (!isYesNo(body)) return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 有 或 2️⃣ 無`, done:false };
    session.buffer.history.social.travel = (body===YES)?'有':'無';

    // 寫入患者 history
    const history = session.buffer.history;
    await writeHistory(fromPhone, patientId, history);

    session.state = STATES.REVIEW;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${renderReview(history)}`, done:false };
  }

  if (session.state === STATES.REVIEW){
    if (!isYesNo(body)) return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續`, done:false };
    if (body===YES){
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${renderPMHMenu()}`, done:false };
    }
    session.state = STATES.DONE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n✅ 已儲存最新病史，將為您進入下一個模組。`, done:true };
  }

  if (session.state === STATES.DONE){
    // 交回 index 控制權（不再提示 0），保持安靜或給提示
    return { text: `${banner(nameForBanner, phoneForBanner)}\n（提示）病史模組已完成。`, done:true };
  }

  // 兜底：重置
  session.state = STATES.ENTRY;
  session.buffer = {};
  await saveHistSession(fromPhone, session);
  return { text: `${banner(nameForBanner, phoneForBanner)}\n已重置病史模組，請重新開始。`, done:false };
}

module.exports = { handleHistory };