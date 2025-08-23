// modules/history.js
// Version: 7 → 7.1
// 介面：async handleHistory({ from, msg, patientId, patientName }) -> { text, done }
// 說明：保留舊版流程；所有問題底部加入「0️⃣ 返回上一題」；
//      更改時進入逐題編輯：Z/z/Ｚ/ｚ = 保留原值；0 = 返回上一題；先題目→原值→指引；
//      社會史三項分行顯示（吸菸、飲酒、近期出國）。

'use strict';
const admin = require('firebase-admin');

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
  DONE: 'H_DONE',

  // 編輯模式（逐題）
  E_PMH: 'H_E_PMH',
  E_PMH_OTHER: 'H_E_PMH_OTHER',
  E_MEDS: 'H_E_MEDS',
  E_ALG_T: 'H_E_ALG_T',
  E_ALG_IN: 'H_E_ALG_IN',
  E_SOC_SMK: 'H_E_SOC_SMK',
  E_SOC_ALC: 'H_E_SOC_ALC',
  E_SOC_TRV: 'H_E_SOC_TRV'
};
const PMH_OPTIONS = ['高血壓','糖尿病','心臟病','腎臟病','肝病','中風','癌症','其他','無'];
const YES='1', NO='2';

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
function isBackKey(t){ return (t||'').trim()==='0'; }
function isKeepKey(t){
  const s=(t||'').trim();
  return s==='Z'||s==='z'||s==='Ｚ'||s==='ｚ';
}

function initHistory(){
  return { pmh:[], meds:[], allergies:{ types:[], items:[] }, social:{ smoking:'', alcohol:'', travel:'' } };
}
function renderPMHMenu(){
  return (
    '請選擇您曾經患有的疾病（可複選，用逗號分隔數字）：\n' +
    PMH_OPTIONS.map((t,i)=>`${i+1}️⃣ ${t}`).join('\n') +
    '\n0️⃣ 返回上一題'
  );
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
    `- 吸菸：${smoking}`,
    `- 飲酒：${alcohol}`,
    `- 近期出國：${travel}`
  ].join('\n');
}
function renderReview(h){
  return (
    `感謝您提供病史資料 🙏\n以下是您剛填寫的內容：\n${renderSummary(h)}\n\n` +
    '請問需要更改嗎？\n1️⃣ 需要更改\n2️⃣ 不需要，直接繼續\n0️⃣ 返回上一題'
  );
}

async function readIndexSession(fromPhone){
  const s = await db.collection('sessions').doc(fromPhone).get();
  return s.exists ? s.data() : {};
}
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

// 「上一題」對應（含編輯流程）
const PREV = {
  [STATES.SHOW_EXISTING]: STATES.ENTRY,
  [STATES.FIRST_NOTICE]: STATES.ENTRY,
  [STATES.PMH_SELECT]: STATES.FIRST_NOTICE,
  [STATES.PMH_OTHER_INPUT]: STATES.PMH_SELECT,
  [STATES.MEDS_YN]: STATES.PMH_SELECT,
  [STATES.MEDS_INPUT]: STATES.MEDS_YN,
  [STATES.ALLERGY_YN]: STATES.MEDS_YN,
  [STATES.ALLERGY_TYPE]: STATES.ALLERGY_YN,
  [STATES.ALLERGY_INPUT]: STATES.ALLERGY_TYPE,
  [STATES.SOCIAL_SMOKE]: STATES.ALLERGY_YN,
  [STATES.SOCIAL_ALCOHOL]: STATES.SOCIAL_SMOKE,
  [STATES.SOCIAL_TRAVEL]: STATES.SOCIAL_ALCOHOL,
  [STATES.REVIEW]: STATES.SOCIAL_TRAVEL,

  [STATES.E_PMH]: STATES.SHOW_EXISTING,
  [STATES.E_PMH_OTHER]: STATES.E_PMH,
  [STATES.E_MEDS]: STATES.E_PMH,
  [STATES.E_ALG_T]: STATES.E_MEDS,
  [STATES.E_ALG_IN]: STATES.E_ALG_T,
  [STATES.E_SOC_SMK]: STATES.E_ALG_T,
  [STATES.E_SOC_ALC]: STATES.E_SOC_SMK,
  [STATES.E_SOC_TRV]: STATES.E_SOC_ALC
};
function backState(s){ return PREV[s] || STATES.ENTRY; }

// —— 編輯模式提示：先題目→原值→指引
function promptEditPMH(existingPmh){
  return (
`請選擇您曾經患有的疾病（可複選，用逗號分隔數字）：
${PMH_OPTIONS.map((t,i)=>`${i+1}️⃣ ${t}`).join('\n')}
原值：${fmtList(existingPmh||[])}
輸入 Z 保留原值；或輸入新的選項（例如：1,2 或 1,3,7；8=其他；9=無）
0️⃣ 返回上一題`
  );
}
function promptEditPMHOther(existingPmh){
  const std = new Set(PMH_OPTIONS.slice(0,7));
  const curExtras = (existingPmh||[]).filter(x=>!std.has(x) && x!=='無');
  return (
`請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）
原值：${fmtList(curExtras)}
輸入 Z 保留原值；或輸入新的其他病名
0️⃣ 返回上一題`
  );
}
function promptEditMeds(existingMeds){
  return (
`請輸入正在服用的藥物名稱（可多個，以逗號或頓號分隔）
原值：${fmtList(existingMeds||[])}
輸入 Z 保留原值；或輸入新的藥物清單；若無請輸入「無」
0️⃣ 返回上一題`
  );
}
function promptEditAllergyTypes(existingTypes){
  return (
`過敏類型（可複選，用逗號分隔）：
1️⃣ 藥物
2️⃣ 食物
3️⃣ 其他
原值：${fmtList(existingTypes||[])}
輸入 Z 保留原值；或輸入新的選項（例如：1,2）
0️⃣ 返回上一題`
  );
}
function promptEditAllergyItems(existingItems){
  return (
`請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）
原值：${fmtList(existingItems||[])}
輸入 Z 保留原值；或輸入新的過敏項目；若無請輸入「無」
0️⃣ 返回上一題`
  );
}
function promptEditSmoke(existing){
  return (
`吸菸情況（可輸入 1/2/3 或 文字：有／無／已戒）：
1️⃣ 有
2️⃣ 無
3️⃣ 已戒
原值：${existing || '未填'}
輸入 Z 保留原值；或輸入 有／無／已戒（或 1/2/3）
0️⃣ 返回上一題`
  );
}
function promptEditAlcohol(existing){
  return (
`飲酒情況（可輸入 1/2/3 或 文字：每天／偶爾／無）：
1️⃣ 每天
2️⃣ 偶爾
3️⃣ 無
原值：${existing || '未填'}
輸入 Z 保留原值；或輸入 每天／偶爾／無（或 1/2/3）
0️⃣ 返回上一題`
  );
}
function promptEditTravel(existing){
  return (
`最近三個月是否出國旅行？（可輸入 1/2 或 文字：有／無）
1️⃣ 有
2️⃣ 無
原值：${existing || '未填'}
輸入 Z 保留原值；或輸入 有／無（或 1/2）
0️⃣ 返回上一題`
  );
}

function resendPromptForState(state, existing){
  switch(state){
    case STATES.SHOW_EXISTING:  return '請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續\n0️⃣ 返回上一題';
    case STATES.FIRST_NOTICE:   return '請輸入 1️⃣ 繼續\n0️⃣ 返回上一題';
    case STATES.PMH_SELECT:     return renderPMHMenu();
    case STATES.PMH_OTHER_INPUT:return '請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）\n0️⃣ 返回上一題';
    case STATES.MEDS_YN:        return '您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有\n0️⃣ 返回上一題';
    case STATES.MEDS_INPUT:     return '請輸入正在服用的藥物名稱（可多個，以逗號或頓號分隔）\n0️⃣ 返回上一題';
    case STATES.ALLERGY_YN:     return '是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無\n0️⃣ 返回上一題';
    case STATES.ALLERGY_TYPE:   return '過敏類型（可複選，用逗號分隔）：\n1️⃣ 藥物\n2️⃣ 食物\n3️⃣ 其他\n0️⃣ 返回上一題';
    case STATES.ALLERGY_INPUT:  return '請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）\n0️⃣ 返回上一題';
    case STATES.SOCIAL_SMOKE:   return '吸菸情況：\n1️⃣ 有\n2️⃣ 無\n3️⃣ 已戒\n0️⃣ 返回上一題';
    case STATES.SOCIAL_ALCOHOL: return '飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n3️⃣ 無\n0️⃣ 返回上一題';
    case STATES.SOCIAL_TRAVEL:  return '最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無\n0️⃣ 返回上一題';

    // 編輯模式
    case STATES.E_PMH:          return promptEditPMH(existing?.pmh);
    case STATES.E_PMH_OTHER:    return promptEditPMHOther(existing?.pmh);
    case STATES.E_MEDS:         return promptEditMeds(existing?.meds);
    case STATES.E_ALG_T:        return promptEditAllergyTypes(existing?.allergies?.types);
    case STATES.E_ALG_IN:       return promptEditAllergyItems(existing?.allergies?.items);
    case STATES.E_SOC_SMK:      return promptEditSmoke(existing?.social?.smoking);
    case STATES.E_SOC_ALC:      return promptEditAlcohol(existing?.social?.alcohol);
    case STATES.E_SOC_TRV:      return promptEditTravel(existing?.social?.travel);
    default:                    return '請依畫面輸入對應選項。';
  }
}

// --- 主處理器 ---
async function handleHistory({ from, msg, patientId, patientName }) {
  const fromPhone = phoneOf(from);
  const body = (msg || '').trim();

  if (!fromPhone) return { text: '病史模組啟動失敗：無法識別電話號碼。', done:false };

  if (!patientId || !patientName) {
    const idx = await readIndexSession(fromPhone);
    const sel = idx.selectedPatient || {};
    patientId   = patientId   || sel.patientId;
    patientName = patientName || sel.name;
  }
  if (!patientId) {
    return { text: '⚠️ 尚未選定病人，請先完成第 1 步（選擇或新增病人）。\n0️⃣ 返回上一題', done:false };
  }

  let session = await getHistSession(fromPhone);
  const pDoc = await readPatient(fromPhone, patientId);
  const nameForBanner  = pDoc?.name  || patientName || '（未命名）';
  const phoneForBanner = fromPhone;

  const firstHit = body === '';
  const invalid = !session.state || !String(session.state).startsWith('H_') || session.state === STATES.DONE;
  if (firstHit || invalid) {
    session.state = STATES.ENTRY;
    session.buffer = {};
    await saveHistSession(fromPhone, session);
  }

  if (isBackKey(body)) {
    const prev = backState(session.state);
    session.state = prev;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${resendPromptForState(prev, pDoc?.history)}`, done:false };
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
2️⃣ 不需要，直接繼續
0️⃣ 返回上一題`,
        done:false
      };
    }
    session.state = STATES.FIRST_NOTICE;
    session.buffer = { history: initHistory() };
    await saveHistSession(fromPhone, session);
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}
由於您第一次使用這個電話號碼進行預先問診，
我們需要花大約 2–3 分鐘收集您的基本病史資料。

請輸入 1️⃣ 繼續
0️⃣ 返回上一題`,
      done:false
    };
  }

  if (session.state === STATES.SHOW_EXISTING){
    if (!isYesNo(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 更改 或 2️⃣ 不需要，直接繼續\n0️⃣ 返回上一題`, done:false };

    if (body === YES){
      // 進入編輯模式，預填現有資料
      session.buffer = { history: JSON.parse(JSON.stringify(existing || initHistory())) };
      session.state = STATES.E_PMH;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditPMH(session.buffer.history.pmh)}`, done:false };
    }

    session.state = STATES.DONE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n✅ 病史已確認無需更改，將為您進入下一個模組。`, done:true };
  }

  if (session.state === STATES.FIRST_NOTICE){
    if (body !== YES)
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 繼續\n0️⃣ 返回上一題`, done:false };
    session.state = STATES.PMH_SELECT;
    session.buffer = { history: initHistory() };
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${renderPMHMenu()}`, done:false };
  }

  // ====== 原有建立流程（保留） ======
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
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）\n0️⃣ 返回上一題`, done:false };
    }
    session.state = STATES.MEDS_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.PMH_OTHER_INPUT){
    const extra = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.pmh.push(...extra);
    session.state = STATES.MEDS_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.MEDS_YN){
    if (!isYesNo(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有\n0️⃣ 返回上一題`, done:false };
    if (body === YES){
      session.state = STATES.MEDS_INPUT;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入正在服用的藥物名稱（可多個，以逗號或頓號分隔）\n0️⃣ 返回上一題`, done:false };
    }
    session.buffer.history.meds = [];
    session.state = STATES.ALLERGY_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.MEDS_INPUT){
    const meds = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.meds = meds;
    session.state = STATES.ALLERGY_YN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.ALLERGY_YN){
    if (!isYesNo(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無\n0️⃣ 返回上一題`, done:false };
    if (body === YES){
      session.state = STATES.ALLERGY_TYPE;
      session.buffer.history.allergies = { types:[], items:[] };
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n過敏類型（可複選，用逗號分隔）：\n1️⃣ 藥物\n2️⃣ 食物\n3️⃣ 其他\n0️⃣ 返回上一題`, done:false };
    }
    session.buffer.history.allergies = { types:[], items:[] };
    session.state = STATES.SOCIAL_SMOKE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n吸菸情況：\n1️⃣ 有\n2️⃣ 無\n3️⃣ 已戒\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.ALLERGY_TYPE){
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=3)){
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請以逗號分隔數字，例如：1,2（1=藥物 2=食物 3=其他）\n0️⃣ 返回上一題`, done:false };
    }
    const map={1:'藥物',2:'食物',3:'其他'};
    session.buffer.history.allergies.types = [...new Set(idxs.map(n=>map[n]))];
    session.state = STATES.ALLERGY_INPUT;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.ALLERGY_INPUT){
    const items = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    session.buffer.history.allergies.items = items;
    session.state = STATES.SOCIAL_SMOKE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n吸菸情況：\n1️⃣ 有\n2️⃣ 無\n3️⃣ 已戒\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.SOCIAL_SMOKE){
    if (!['1','2','3'].includes(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n吸菸情況：\n1️⃣ 有\n2️⃣ 無\n3️⃣ 已戒\n0️⃣ 返回上一題`, done:false };
    const map = { '1':'有', '2':'無', '3':'已戒' };
    session.buffer.history.social.smoking = map[body];
    session.state = STATES.SOCIAL_ALCOHOL;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n3️⃣ 無\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.SOCIAL_ALCOHOL){
    if (!['1','2','3'].includes(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n3️⃣ 無\n0️⃣ 返回上一題`, done:false };
    const map = { '1':'每天', '2':'偶爾', '3':'無' };
    session.buffer.history.social.alcohol = map[body];
    session.state = STATES.SOCIAL_TRAVEL;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無\n0️⃣ 返回上一題`, done:false };
  }

  if (session.state === STATES.SOCIAL_TRAVEL){
    if (!['1','2'].includes(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無\n0️⃣ 返回上一題`, done:false };
    session.buffer.history.social.travel = (body==='1')?'有':'無';

    const history = session.buffer.history;
    await writeHistory(fromPhone, patientId, history);

    session.state = STATES.REVIEW;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${renderReview(history)}`, done:false };
  }

  if (session.state === STATES.REVIEW){
    if (!isYesNo(body))
      return { text: `${banner(nameForBanner, phoneForBanner)}\n請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續\n0️⃣ 返回上一題`, done:false };
    if (body===YES){
      // 進入編輯模式（以現有填答為基礎）
      session.state = STATES.E_PMH;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditPMH(session.buffer.history.pmh)}`, done:false };
    }
    session.state = STATES.DONE;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n✅ 已儲存最新病史，將為您進入下一個模組。`, done:true };
  }

  // ====== 編輯模式（Z 保留） ======

  if (session.state === STATES.E_PMH){
    if (isKeepKey(body)){
      // 是否原本有「其他」內容？如有，繼續問 E_PMH_OTHER
      const std = new Set(PMH_OPTIONS.slice(0,7));
      const curExtras = (session.buffer.history.pmh||[]).filter(x=>!std.has(x) && x!=='無');
      if (curExtras.length){
        session.state = STATES.E_PMH_OTHER;
        await saveHistSession(fromPhone, session);
        return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditPMHOther(session.buffer.history.pmh)}`, done:false };
      }
      session.state = STATES.E_MEDS;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditMeds(session.buffer.history.meds)}`, done:false };
    }
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=PMH_OPTIONS.length)){
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditPMH(session.buffer.history.pmh)}`, done:false };
    }
    let picked = [];
    let needOther=false, isNone=false;
    for (const n of idxs){
      if (n===8) needOther = true;
      if (n===9) isNone = true;
      picked.push(PMH_OPTIONS[n-1]);
    }
    if (isNone) {
      session.buffer.history.pmh = [];
      session.state = STATES.E_MEDS;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditMeds(session.buffer.history.meds)}`, done:false };
    }
    session.buffer.history.pmh = picked.filter(x=>x!=='其他' && x!=='無');
    if (needOther){
      session.state = STATES.E_PMH_OTHER;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditPMHOther(session.buffer.history.pmh)}`, done:false };
    }
    session.state = STATES.E_MEDS;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditMeds(session.buffer.history.meds)}`, done:false };
  }

  if (session.state === STATES.E_PMH_OTHER){
    if (isKeepKey(body)){
      session.state = STATES.E_MEDS;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditMeds(session.buffer.history.meds)}`, done:false };
    }
    const extra = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
    const std = new Set(PMH_OPTIONS.slice(0,7));
    const base = (session.buffer.history.pmh||[]).filter(x=>std.has(x));
    session.buffer.history.pmh = base.concat(extra);
    session.state = STATES.E_MEDS;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditMeds(session.buffer.history.meds)}`, done:false };
  }

  if (session.state === STATES.E_MEDS){
    if (isKeepKey(body)){
      session.state = STATES.E_ALG_T;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditAllergyTypes(session.buffer.history.allergies?.types)}`, done:false };
    }
    const raw = body.trim();
    if (raw === '無'){
      session.buffer.history.meds = [];
    } else {
      const meds = raw.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
      session.buffer.history.meds = meds;
    }
    session.state = STATES.E_ALG_T;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditAllergyTypes(session.buffer.history.allergies?.types)}`, done:false };
  }

  if (session.state === STATES.E_ALG_T){
    if (isKeepKey(body)){
      const hasTypes = (session.buffer.history.allergies?.types||[]).length>0;
      session.state = hasTypes ? STATES.E_ALG_IN : STATES.E_SOC_SMK;
      await saveHistSession(fromPhone, session);
      const nextText = hasTypes ? promptEditAllergyItems(session.buffer.history.allergies?.items)
                                : promptEditSmoke(session.buffer.history.social?.smoking);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${nextText}`, done:false };
    }
    const idxs = commaNumListToIndices(body);
    if (!idxs.length || !idxs.every(n=>n>=1 && n<=3)){
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditAllergyTypes(session.buffer.history.allergies?.types)}`, done:false };
    }
    const map={1:'藥物',2:'食物',3:'其他'};
    session.buffer.history.allergies = session.buffer.history.allergies || { types:[], items:[] };
    session.buffer.history.allergies.types = [...new Set(idxs.map(n=>map[n]))];
    session.state = STATES.E_ALG_IN;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditAllergyItems(session.buffer.history.allergies.items)}`, done:false };
  }

  if (session.state === STATES.E_ALG_IN){
    if (isKeepKey(body)){
      session.state = STATES.E_SOC_SMK;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditSmoke(session.buffer.history.social?.smoking)}`, done:false };
    }
    const raw = body.trim();
    if (raw === '無'){
      session.buffer.history.allergies.items = [];
    } else {
      const items = raw.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
      session.buffer.history.allergies.items = items;
    }
    session.state = STATES.E_SOC_SMK;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditSmoke(session.buffer.history.social?.smoking)}`, done:false };
  }

  if (session.state === STATES.E_SOC_SMK){
    if (isKeepKey(body)){
      session.state = STATES.E_SOC_ALC;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditAlcohol(session.buffer.history.social?.alcohol)}`, done:false };
    }
    let val = body.trim();
    if (val==='1') val='有'; else if(val==='2') val='無'; else if(val==='3') val='已戒';
    if (!['有','無','已戒'].includes(val)){
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditSmoke(session.buffer.history.social?.smoking)}`, done:false };
    }
    session.buffer.history.social.smoking = val;
    session.state = STATES.E_SOC_ALC;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditAlcohol(session.buffer.history.social?.alcohol)}`, done:false };
  }

  if (session.state === STATES.E_SOC_ALC){
    if (isKeepKey(body)){
      session.state = STATES.E_SOC_TRV;
      await saveHistSession(fromPhone, session);
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditTravel(session.buffer.history.social?.travel)}`, done:false };
    }
    let val = body.trim();
    if (val==='1') val='每天'; else if(val==='2') val='偶爾'; else if(val==='3') val='無';
    if (!['每天','偶爾','無'].includes(val)){
      return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditAlcohol(session.buffer.history.social?.alcohol)}`, done:false };
    }
    session.buffer.history.social.alcohol = val;
    session.state = STATES.E_SOC_TRV;
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditTravel(session.buffer.history.social?.travel)}`, done:false };
  }

  if (session.state === STATES.E_SOC_TRV){
    if (!isKeepKey(body)){
      let val = body.trim();
      if (val==='1') val='有'; else if (val==='2') val='無';
      if (!['有','無'].includes(val)){
        return { text: `${banner(nameForBanner, phoneForBanner)}\n${promptEditTravel(session.buffer.history.social?.travel)}`, done:false };
      }
      session.buffer.history.social.travel = val;
    }
    const history = session.buffer.history;
    await writeHistory(fromPhone, patientId, history);

    session.state = STATES.REVIEW; // 回到回顧畫面
    await saveHistSession(fromPhone, session);
    return { text: `${banner(nameForBanner, phoneForBanner)}\n${renderReview(history)}`, done:false };
  }

  // 兜底：重置
  session.state = STATES.ENTRY;
  session.buffer = {};
  await saveHistSession(fromPhone, session);
  return { text: `${banner(nameForBanner, phoneForBanner)}\n已重置病史模組，請重新開始。`, done:false };
}

module.exports = { handleHistory };