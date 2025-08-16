// src/modules/history_module_v2.js
'use strict';

// 狀態
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
  '高血壓', //1
  '糖尿病', //2
  '心臟病', //3
  '腎臟病', //4
  '肝病',   //5
  '中風',   //6
  '癌症',   //7
  '其他',   //8
  '無'      //9
];

const YES = '1';
const NO  = '2';

// ---------- 小工具 ----------
function parseArgs(arg) {
  // 支援 { from, body } 或 req
  if (arg && typeof arg === 'object' && Object.prototype.hasOwnProperty.call(arg, 'from')) {
    return { from: String(arg.from || '').trim(), body: String(arg.body || '').trim() };
  }
  const req = arg || {};
  return {
    from: String((req.body && req.body.From) || '').trim(),
    body: String((req.body && req.body.Body) || '').trim()
  };
}
function commaNumListToIndices(text) {
  return String(text || '')
    .replace(/，/g, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(n => parseInt(n, 10))
    .filter(n => !Number.isNaN(n));
}
function isYesNo(v){ return v === YES || v === NO; }
function initHistory(){
  return { pmh: [], meds: [], allergies: { types: [], items: [] }, social: { smoking:'', alcohol:'', travel:'' } };
}
function renderPMHMenu(){
  return '請選擇您曾經患有的疾病（可複選，用逗號分隔數字）：\n' +
    PMH_OPTIONS.map((t,i)=>`${i+1}️⃣ ${t}`).join('\n');
}
function renderSummary(h){
  const pmh      = h.pmh?.length ? h.pmh.join('、') : '無';
  const meds     = h.meds?.length ? h.meds.join('、') : '無';
  const alTypes  = h.allergies?.types?.length ? h.allergies.types.join('、') : '無';
  const alItems  = h.allergies?.items?.length ? h.allergies.items.join('、') : '無';
  const smoking  = h.social?.smoking || '未填';
  const alcohol  = h.social?.alcohol || '未填';
  const travel   = h.social?.travel  || '未填';
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

// ---------- 預設記憶體儲存 ----------
class MemoryStore {
  constructor(){
    this.patients = new Map(); // phone -> { history }
    this.sessions = new Map(); // phone -> { state, buffer }
  }
  async getPatient(phone){ return this.patients.get(phone) || null; }
  async savePatient(phone, patch){
    const cur = this.patients.get(phone) || {};
    this.patients.set(phone, { ...cur, ...patch });
  }
  async getSession(phone){ return this.sessions.get(phone) || { state: STATES.ENTRY, buffer:{} }; }
  async saveSession(phone, data){
    const cur = this.sessions.get(phone) || {};
    this.sessions.set(phone, { ...cur, ...data });
  }
}

// ---------- Firestore 儲存（日後要換時再用） ----------
class FirestoreStore {
  constructor(db){ this.db = db; }
  async getPatient(phone){
    const snap = await this.db.collection('patients').doc(phone).get();
    return snap.exists ? snap.data() : null;
  }
  async savePatient(phone, patch){
    await this.db.collection('patients').doc(phone).set(patch, { merge:true });
  }
  async getSession(phone){
    const doc = await this.db.collection('sessions').doc(phone).get();
    return doc.exists ? doc.data() : { state: STATES.ENTRY, buffer:{} };
  }
  async saveSession(phone, data){
    await this.db.collection('sessions').doc(phone).set(data, { merge:true });
  }
}

// ---------- 主工廠 ----------
function createHistoryModule({ store } = {}){
  const kv = store || new MemoryStore();

  async function handle(arg){
    const { from, body } = parseArgs(arg);
    if (!from) return '病史模組啟動失敗：無法識別電話號碼。';

    // 病史內部忽略 "0"（避免被當跳過鍵）
    if (body === '0'){
      const s = await kv.getSession(from);
      return resendPromptForState(s.state);
    }

    let session  = await kv.getSession(from);
    const person = await kv.getPatient(from);
    const existing = person?.history || null;

    // 入口
    if (session.state === STATES.ENTRY){
      if (existing){
        session.state = STATES.SHOW_EXISTING;
        await kv.saveSession(from, session);
        return `您之前輸入的病史資料如下：\n${renderSummary(existing)}\n\n請問需要更改嗎？\n1️⃣ 需要更改\n2️⃣ 不需要，直接繼續`;
      }
      session.state = STATES.FIRST_NOTICE;
      await kv.saveSession(from, session);
      return '由於您第一次使用這個電話號碼進行預先問診，\n我們需要花大約 2–3 分鐘收集您的基本病史資料。\n\n請輸入 1️⃣ 繼續';
    }

    if (session.state === STATES.SHOW_EXISTING){
      if (!isYesNo(body)) return '請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續';
      if (body === YES){
        session.state = STATES.PMH_SELECT;
        session.buffer = { history: initHistory() };
        await kv.saveSession(from, session);
        return renderPMHMenu();
      }
      session.state = STATES.DONE;
      await kv.saveSession(from, session);
      return '✅ 病史已確認無需更改，將為您進入下一個模組。';
    }

    if (session.state === STATES.FIRST_NOTICE){
      if (body !== YES) return '請輸入 1️⃣ 繼續';
      session.state = STATES.PMH_SELECT;
      session.buffer = { history: initHistory() };
      await kv.saveSession(from, session);
      return renderPMHMenu();
    }

    // PMH
    if (session.state === STATES.PMH_SELECT){
      const idxs = commaNumListToIndices(body);
      if (!idxs.length || !idxs.every(n=>n>=1 && n<=PMH_OPTIONS.length)){
        return '格式不正確，請以逗號分隔數字，例如：1,2 或 1,3,7\n\n' + renderPMHMenu();
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
        await kv.saveSession(from, session);
        return '請輸入「其他」的具體病名（可多個，以逗號或頓號分隔）';
      }
      session.state = STATES.MEDS_YN;
      await kv.saveSession(from, session);
      return '您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有';
    }

    if (session.state === STATES.PMH_OTHER_INPUT){
      const extra = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
      session.buffer.history.pmh.push(...extra);
      session.state = STATES.MEDS_YN;
      await kv.saveSession(from, session);
      return '您目前是否有在服用藥物？\n1️⃣ 有\n2️⃣ 沒有';
    }

    // 用藥
    if (session.state === STATES.MEDS_YN){
      if (!isYesNo(body)) return '請輸入 1️⃣ 有 或 2️⃣ 沒有';
      if (body === YES){
        session.state = STATES.MEDS_INPUT;
        await kv.saveSession(from, session);
        return '請輸入正在服用的藥物名稱（可多個，以逗號或頓號分隔）';
      }
      session.buffer.history.meds = [];
      session.state = STATES.ALLERGY_YN;
      await kv.saveSession(from, session);
      return '是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無';
    }

    if (session.state === STATES.MEDS_INPUT){
      const meds = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
      session.buffer.history.meds = meds;
      session.state = STATES.ALLERGY_YN;
      await kv.saveSession(from, session);
      return '是否有藥物或食物過敏？\n1️⃣ 有\n2️⃣ 無';
    }

    // 過敏
    if (session.state === STATES.ALLERGY_YN){
      if (!isYesNo(body)) return '請輸入 1️⃣ 有 或 2️⃣ 無';
      if (body === YES){
        session.state = STATES.ALLERGY_TYPE;
        session.buffer.history.allergies = { types:[], items:[] };
        await kv.saveSession(from, session);
        return '過敏類型（可複選，用逗號分隔）：\n1️⃣ 藥物\n2️⃣ 食物\n3️⃣ 其他';
      }
      session.buffer.history.allergies = { types:[], items:[] };
      session.state = STATES.SOCIAL_SMOKE;
      await kv.saveSession(from, session);
      return '吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）';
    }

    if (session.state === STATES.ALLERGY_TYPE){
      const idxs = commaNumListToIndices(body);
      if (!idxs.length || !idxs.every(n=>n>=1 && n<=3)){
        return '請以逗號分隔數字，例如：1,2（1=藥物 2=食物 3=其他）';
      }
      const map={1:'藥物',2:'食物',3:'其他'};
      session.buffer.history.allergies.types = [...new Set(idxs.map(n=>map[n]))];
      session.state = STATES.ALLERGY_INPUT;
      await kv.saveSession(from, session);
      return '請輸入過敏項目（例如：青黴素、花生…；可多個，用逗號或頓號分隔）';
    }

    if (session.state === STATES.ALLERGY_INPUT){
      const items = body.replace(/，/g,'、').split(/[、,]/).map(s=>s.trim()).filter(Boolean);
      session.buffer.history.allergies.items = items;
      session.state = STATES.SOCIAL_SMOKE;
      await kv.saveSession(from, session);
      return '吸菸情況：\n1️⃣ 有\n2️⃣ 無\n（若已戒可輸入：已戒）';
    }

    // 社會史
    if (session.state === STATES.SOCIAL_SMOKE){
      const v = body.trim();
      let smoking='';
      if (v===YES) smoking='有';
      else if (v===NO) smoking='無';
      else if (v==='已戒') smoking='已戒';
      else return '請輸入 1️⃣ 有、2️⃣ 無，或輸入「已戒」';
      session.buffer.history.social.smoking = smoking;
      session.state = STATES.SOCIAL_ALCOHOL;
      await kv.saveSession(from, session);
      return '飲酒情況：\n1️⃣ 每天\n2️⃣ 偶爾\n（若不喝請輸入：無）';
    }

    if (session.state === STATES.SOCIAL_ALCOHOL){
      const v = body.trim();
      let alcohol='';
      if (v===YES) alcohol='每天';
      else if (v===NO) alcohol='偶爾';
      else if (v==='無') alcohol='無';
      else return '請輸入 1️⃣ 每天、2️⃣ 偶爾，或輸入「無」';
      session.buffer.history.social.alcohol = alcohol;
      session.state = STATES.SOCIAL_TRAVEL;
      await kv.saveSession(from, session);
      return '最近三個月是否出國旅行？\n1️⃣ 有\n2️⃣ 無';
    }

    if (session.state === STATES.SOCIAL_TRAVEL){
      if (!isYesNo(body)) return '請輸入 1️⃣ 有 或 2️⃣ 無';
      session.buffer.history.social.travel = (body===YES)?'有':'無';

      // 寫入患者（MemoryStore：存在記憶體；若換 FirestoreStore：會寫 DB）
      const history = session.buffer.history;
      await kv.savePatient(from, { history });

      session.state = STATES.REVIEW;
      await kv.saveSession(from, session);
      return renderReview(history);
    }

    if (session.state === STATES.REVIEW){
      if (!isYesNo(body)) return '請輸入 1️⃣ 需要更改 或 2️⃣ 不需要，直接繼續';
      if (body===YES){
        session.state = STATES.PMH_SELECT;
        session.buffer = { history: initHistory() };
        await kv.saveSession(from, session);
        return renderPMHMenu();
      }
      session.state = STATES.DONE;
      await kv.saveSession(from, session);
      return '✅ 已儲存最新病史，將為您進入下一個模組。';
    }

    if (session.state === STATES.DONE){
      return '（提示）病史模組已完成，請輸入 0 進入下一步。';
    }

    // 兜底：重置
    session.state = STATES.ENTRY;
    session.buffer = {};
    await kv.saveSession(from, session);
    return '已重置病史模組，請重新開始。';
  }

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
      default:                    return '請輸入指示中的數字選項繼續。';
    }
  }

  return { handle, STATES, MemoryStore, FirestoreStore };
}

module.exports = { createHistoryModule, MemoryStore, FirestoreStore };




