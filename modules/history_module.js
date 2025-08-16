// modules/history_module.js
// 病史模組（支援：首次/修改、數字選單、Firestore 永續化）

const admin = require('../lib/firebase');

// 確保整個專案只初始化一次
if (!admin.apps.length) {
  // 建議在 Render/伺服器用 GOOGLE_APPLICATION_CREDENTIALS 或環境變數注入服務金鑰
  // 若用應用預設認證，這裡可留白直接 initializeApp()
  admin.initializeApp();
}

const db = admin.firestore();

/** Firestore 資料結構
 * patients/{phone}:
 *   history: {
 *     pmh: [String],                 // 過去病史（標準化文字）
 *     meds: [String],                // 現用藥
 *     allergies: { types:[String], items:[String] }, // 過敏類型 & 明細
 *     social: { smoking:String, alcohol:String, travel:String } // 社會史
 *   }
 *   updatedAt: Timestamp
 *
 * sessions/{phone}:
 *   state: String
 *   buffer: 任務中暫存（例如 PMH 選擇、過敏類型）
 */

const STATES = {
  ENTRY: 'HISTORY_ENTRYPOINT',
  SHOW_EXISTING: 'SHOW_EXISTING',
  ASK_CHANGE: 'ASK_CHANGE',
  FIRST_USE_NOTICE: 'FIRST_USE_NOTICE',
  PMH_SELECT: 'PMH_SELECT',
  PMH_OTHER_INPUT: 'PMH_OTHER_INPUT',
  MEDS_YN: 'MEDS_YN',
  MEDS_INPUT: 'MEDS_INPUT',
  ALLERGY_YN: 'ALLERGY_YN',
  ALLERGY_TYPE: 'ALLERGY_TYPE',
  ALLERGY_INPUT: 'ALLERGY_INPUT',
  SOCIAL_SMOKE: 'SOCIAL_SMOKE',
  SOCIAL_ALCOHOL: 'SOCIAL_ALCOHOL',
  SOCIAL_TRAVEL: 'SOCIAL_TRAVEL',
  REVIEW: 'REVIEW',
  DONE: 'DONE'
};

// 過去病史選單
const PMH_OPTIONS = [
  '高血壓',     // 1
  '糖尿病',     // 2
  '心臟病',     // 3
  '腎臟病',     // 4
  '肝病',       // 5
  '中風',       // 6
  '癌症',       // 7
  '其他',       // 8 → 需額外輸入
  '無'          // 9 → 清空 pmh
];

const YES = '1';
const NO  = '2';

function commaNumListToIndices(text) {
  // 允許「1,2,7」或「1，2，7」和空白
  return text
    .replace(/，/g, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(n => parseInt(n, 10))
    .filter(n => !Number.isNaN(n));
}

function isYesNo(body) {
  return body === YES || body === NO;
}

function renderExistingSummary(h) {
  if (!h) return '（尚無資料）';
  const pmh = h.pmh?.length ? h.pmh.join('、') : '無';
  const meds = h.meds?.length ? h.meds.join('、') : '無';
  const alTypes = h.allergies?.types?.length ? h.allergies.types.join('、') : '無';
  const alItems = h.allergies?.items?.length ? h.allergies.items.join('、') : '無';
  const smoking = h.social?.smoking ?? '未填';
  const alcohol = h.social?.alcohol ?? '未填';
  const travel  = h.social?.travel  ?? '未填';
  return [
    `- 過去病史：${pmh}`,
    `- 服用藥物：${meds}`,
    `- 過敏類型：${alTypes}`,
    `- 過敏明細：${alItems}`,
    `- 吸菸：${smoking}；飲酒：${alcohol}；近期出國：${travel}`
  ].join('\n');
}

function renderPMHMenu() {
  const lines = PMH_OPTIONS.map((name, idx) => `${idx+1}️⃣ ${name}`);
  return [
    '請選擇您曾經患有的疾病（可複選，用逗號分隔數字）：',
    ...lines
  ].join('\n');
}

function renderReview(h) {
  return `感謝您提供病史資料 🙏\n以下是您剛填寫的內容：\n${renderExistingSummary(h)}\n\n請問需要更改嗎？\n輸入 1️⃣ 需要更改\n輸入 2️⃣ 不需要，直接繼續`;
}

async function getPatientDoc(phone) {
  return db.collection('patients').doc(phone).get();
}

async function getSession(phone) {
  const doc = await db.collection('sessions').doc(phone).get();
  if (!doc.exists) {
    return { state: STATES.ENTRY, buffer: {} };
  }
  return doc.data();
}

async function saveSession(phone, session) {
  await db.collection('sessions').doc(phone).set(session, { merge: true });
}

async function saveHistory(phone, history) {
  await db.collection('patients').doc(phone).set({
    history,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

function initEmptyHistory() {
  return {
    pmh: [],
    meds: [],
    allergies: { types: [], items: [] },
    social: { smoking: '', alcohol: '', travel: '' }
  };
}

// 將自由文字常見輸入正規化（是/否/有/沒有）
function normalizeYesNo(text) {
  const t = text.trim();
  if (t === '1') return YES;
  if (t === '2') return NO;
  return t;
}

// === 對外主入口 ===
async function handleHistoryModule({ from, body }) {
  // 規範化輸入（特別是 1/2）
  const input = normalizeYesNo(body);

  // 讀取 Session 與 Patient
  let session = await getSession(from);
  const patientSnap = await getPatientDoc(from);
  const existing = patientSnap.exists ? (patientSnap.data().history || null) : null;

  // 首次進入
  if (session.state === STATES.ENTRY) {
    if (existing) {
      session.state = STATES.SHOW_EXISTING;
      await saveSession(from, session);
      return `您之前輸入的病史資料如下：\n${renderExistingSummary(existing)}\n\n請問需要更改嗎？\n輸入 1️⃣ 需要更改\n輸入 2️⃣ 不需要，直接繼續`;
    }
    session.state = STATES.FIRST_USE_NOTICE;
    await saveSession(from, session);
    return `由於您第一次使用這個電話號碼進行預先問診，\n我們需要花大約 2–3 分鐘收集您的基本病史資料，以便醫生更準確了解您的健康狀況。\n\n請輸入 1️⃣ 繼續`;
  }

  // 已有 → 問是否更改
  if (session.state === STATES.SHOW_EXISTING) {
    if (!isYesNo(input)) return '請輸入 1️⃣ 需要更改，或 2️⃣ 不需要，直接繼續';
    if (input === YES) {
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initEmptyHistory() };
      await saveSession(from, session);
      return renderPMHMenu();
    } else {
      session.state = STATES.DONE;
      await saveSession(from, session);
      return '✅ 病史已確認無需更改，將為您進入下一個模組。';
    }
  }

  // 首次使用 → 1 繼續
  if (session.state === STATES.FIRST_USE_NOTICE) {
    if (input !== YES) return '請輸入 1️⃣ 繼續';
    session.state = STATES.PMH_SELECT;
    session.buffer = { history: initEmptyHistory() };
    await saveSession(from, session);
    return renderPMHMenu();
  }

  // PMH 多選
  if (session.state === STATES.PMH_SELECT) {
    const idxs = commaNumListToIndices(input);
    if (!idxs.length || !idxs.every(n => n >= 1 && n <= PMH_OPTIONS.length)) {
      return '格式不正確，請以逗號分隔數字，例如：1,2 或 1,3,7\n\n' + renderPMHMenu();
    }
    const names = [];
    let needOther = false;
    let isNone = false;
    for (const n of idxs) {
      if (n === 8) needOther = true;
      if (n === 9) isNone = true;
      names.push(PMH_OPTIONS[n-1]);
    }
    if (isNone) {
      // 若選「無」則清空，並忽略其他選項
      session.buffer.history.pmh = [];
    } else {
      // 去除「其他」字樣本身，待補充具體內容
      session.buffer.history.pmh = names.filter(x => x !== '其他' && x !== '無');
    }
    if (needOther && !isNone) {
      session.state = STATES.PMH_OTHER_INPUT;
      await saveSession(from, session);
      return '請輸入「其他」的具體病名（可輸入多個，請以中文頓號或逗號分隔）';
    }
    session.state = STATES.MEDS_YN;
    await saveSession(from, session);
    return '您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有';
  }

  if (session.state === STATES.PMH_OTHER_INPUT) {
    const extra = body.replace(/，/g, '、').split(/[、,]/).map(s => s.trim()).filter(Boolean);
    session.buffer.history.pmh.push(...extra);
    session.state = STATES.MEDS_YN;
    await saveSession(from, session);
    return '您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有';
  }

  // 用藥
  if (session.state === STATES.MEDS_YN) {
    if (!isYesNo(input)) return '請輸入 1️⃣ 有 或 2️⃣ 沒有';
    if (input === YES) {
      session.state = STATES.MEDS_INPUT;
      await saveSession(from, session);
      return '請輸入正在服用的藥物名稱（可輸入多個，以逗號或頓號分隔）';
    } else {
      session.buffer.history.meds = [];
      session.state = STATES.ALLERGY_YN;
      await saveSession(from, session);
      return '是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無';
    }
  }

  if (session.state === STATES.MEDS_INPUT) {
    const meds = body.replace(/，/g, '、').split(/[、,]/).map(s => s.trim()).filter(Boolean);
    session.buffer.history.meds = meds;
    session.state = STATES.ALLERGY_YN;
    await saveSession(from, session);
    return '是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無';
  }

  // 過敏
  if (session.state === STATES.ALLERGY_YN) {
    if (!isYesNo(input)) return '請輸入 1️⃣ 有 或 2️⃣ 無';
    if (input === YES) {
      session.state = STATES.ALLERGY_TYPE;
      session.buffer.history.allergies = { types: [], items: [] };
      await saveSession(from, session);
      return '過敏類型（可複選，用逗號分隔）：\n1️⃣ 藥物\n2️⃣ 食物\n3️⃣ 其他';
    } else {
      session.buffer.history.allergies = { types: [], items: [] };
      session.state = STATES.SOCIAL_SMOKE;
      await saveSession(from, session);
      return '吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）';
    }
  }

  if (session.state === STATES.ALLERGY_TYPE) {
    const idxs = commaNumListToIndices(input);
    if (!idxs.length || !idxs.every(n => n >= 1 && n <= 3)) {
      return '請以逗號分隔數字，例如：1,2（1=藥物 2=食物 3=其他）';
    }
    const map = {1:'藥物',2:'食物',3:'其他'};
    session.buffer.history.allergies.types = [...new Set(idxs.map(n => map[n]))];
    session.state = STATES.ALLERGY_INPUT;
    await saveSession(from, session);
    return '請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）';
  }

  if (session.state === STATES.ALLERGY_INPUT) {
    const items = body.replace(/，/g, '、').split(/[、,]/).map(s => s.trim()).filter(Boolean);
    session.buffer.history.allergies.items = items;
    session.state = STATES.SOCIAL_SMOKE;
    await saveSession(from, session);
    return '吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）';
  }

  // 社會史
  if (session.state === STATES.SOCIAL_SMOKE) {
    const v = body.trim();
    let smoking = '';
    if (v === YES) smoking = '有';
    else if (v === NO) smoking = '無';
    else if (v === '已戒') smoking = '已戒';
    else return '請輸入 1️⃣ 有、2️⃣ 無，或輸入「已戒」';
    session.buffer.history.social.smoking = smoking;
    session.state = STATES.SOCIAL_ALCOHOL;
    await saveSession(from, session);
    return '飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n（若不喝請輸入：無）';
  }

  if (session.state === STATES.SOCIAL_ALCOHOL) {
    const v = body.trim();
    let alcohol = '';
    if (v === YES) alcohol = '每天';
    else if (v === NO) alcohol = '偶爾';
    else if (v === '無') alcohol = '無';
    else return '請輸入 1️⃣ 每天、2️⃣ 偶爾，或輸入「無」';
    session.buffer.history.social.alcohol = alcohol;
    session.state = STATES.SOCIAL_TRAVEL;
    await saveSession(from, session);
    return '最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無';
  }

  if (session.state === STATES.SOCIAL_TRAVEL) {
    if (!isYesNo(input)) return '請輸入 1️⃣ 有 或 2️⃣ 無';
    session.buffer.history.social.travel = (input === YES) ? '有' : '無';

    // 完成 → 寫入 Firestore
    const history = session.buffer.history;
    await saveHistory(from, history);

    // 進入覆核
    session.state = STATES.REVIEW;
    await saveSession(from, session);
    return renderReview(history);
  }

  // 覆核 → 是否要更改
  if (session.state === STATES.REVIEW) {
    if (!isYesNo(input)) return '請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續';
    if (input === YES) {
      // 重新來過：回到 PMH
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initEmptyHistory() };
      await saveSession(from, session);
      return renderPMHMenu();
    } else {
      session.state = STATES.DONE;
      await saveSession(from, session);
      return '✅ 已儲存最新病史，將為您進入下一個模組。';
    }
  }

  // DONE：讓外層接手進入下一模組
  if (session.state === STATES.DONE) {
    return '（提示）病史模組已完成，請呼叫下一個模組。';
  }

  // 預設兜底
  session.state = STATES.ENTRY;
  session.buffer = {};
  await saveSession(from, session);
  return '已重置病史模組，請重新開始。';
}

module.exports = {
  handleHistoryModule,
  STATES
};

