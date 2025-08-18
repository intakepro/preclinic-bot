// modules/history.js
// Version: 6.4
// 介面：async handleHistory({ from, msg, patientId, patientName }) -> { text: string, done?: boolean }
// - 回傳欄位一律使用 { text, done } 以符合 index v6.4.4-fs 需求
// - 線性流程：已有病史 => 摘要 + 1更改/2下一步；無病史 => 依序詢問 PMH→Meds→過敏類型→過敏明細→吸菸→飲酒→旅遊→總結確認
// - Firestore 結構：users/{fromPhone}/patients/{patientId}/(history)

'use strict';

const admin = require('firebase-admin');

// ---------- Firebase ----------
(function ensureFirebase(){
  if (admin.apps.length) return;
  try{
    if (process.env.FIREBASE_SERVICE_ACCOUNT){
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('[history] Firebase via FIREBASE_SERVICE_ACCOUNT');
    }else{
      admin.initializeApp();
      console.log('[history] Firebase via default credentials');
    }
  }catch(e){
    console.error('[history] Firebase init error:', e?.message || e);
    throw e;
  }
})();
const db = admin.firestore();

// ---------- utils ----------
const phoneOf = (from) => (from || '').toString().replace(/^whatsapp:/i,'').trim();

const last4 = (p) => String(p||'').replace(/\D/g,'').slice(-4).padStart(4,'*');
const banner = (name, phone) => `👤 病人：${name || '（未命名）'}（${last4(phone)}）`;

const arrFromText = t => String(t||'').split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean);
const fmtList = a => (Array.isArray(a) && a.length) ? a.map(v=>`  • ${v}`).join('\n') : '  （無）';
const fmtText = s => (s && String(s).trim()) ? String(s).trim() : '（無）';

const renderSummary = (h={})=>{
  const pmh   = fmtList(h.pmh||[]);
  const meds  = fmtList(h.meds||[]);
  const types = fmtList(h.allergies?.types||[]);
  const items = fmtList(h.allergies?.items||[]);
  const smk   = fmtText(h.social?.smoking);
  const alc   = fmtText(h.social?.alcohol);
  const trv   = fmtText(h.social?.travel);
  return [
    '📋 病史摘要：',
    '',
    '— 過去病史（PMH）—', pmh,
    '',
    '— 現用藥（Meds）—',  meds,
    '',
    '— 過敏（Allergies）—',
    `  類型：\n${types}`,
    `  明細：\n${items}`,
    '',
    '— 社會史（Social）—',
    `  吸菸：${smk}`,
    `  飲酒：${alc}`,
    `  旅遊：${trv}`,
  ].join('\n');
};

// ---------- Firestore helpers ----------
async function readIndexSession(from){
  const key = phoneOf(from) || 'DEFAULT';
  const snap = await db.collection('sessions').doc(key).get();
  return snap.exists ? snap.data() : {};
}
function refs(fromPhone, patientId){
  const userRef = db.collection('users').doc(fromPhone);
  return {
    patientRef: userRef.collection('patients').doc(patientId),
    histSessRef: db.collection('history_sessions').doc(fromPhone)
  };
}
async function readPatient(fromPhone, patientId){
  const { patientRef } = refs(fromPhone, patientId);
  const s = await patientRef.get();
  return s.exists ? { id: patientId, ...s.data() } : null;
}
async function writeHistory(fromPhone, patientId, history){
  const { patientRef } = refs(fromPhone, patientId);
  await patientRef.set(
    { history, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge:true }
  );
}
async function readHistSession(fromPhone){
  const { histSessRef } = refs(fromPhone, '_');
  const s = await histSessRef.get();
  return s.exists ? s.data() : { state:'ENTRY', buf:{} };
}
async function writeHistSession(fromPhone, patch){
  const { histSessRef } = refs(fromPhone, '_');
  await histSessRef.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
}

// ---------- states ----------
/*
ENTRY
SHOW_EXISTING           -> wait 1/2
PMH_INPUT               -> text
MEDS_INPUT              -> text
ALG_TYPES_INPUT         -> text
ALG_ITEMS_INPUT         -> text
SOCIAL_SMOKING_INPUT    -> text
SOCIAL_ALCOHOL_INPUT    -> text
SOCIAL_TRAVEL_INPUT     -> text
REVIEW                  -> wait 1/2
*/

async function handleHistory({ from, msg, patientId, patientName }){
  const fromPhone = phoneOf(from);
  const body = (msg||'').trim();

  // 補參數（index 若未帶）
  if (!patientId || !patientName){
    const sess = await readIndexSession(from);
    const sel = sess.selectedPatient || {};
    patientId   = patientId   || sel.patientId;
    patientName = patientName || sel.name;
  }
  if (!fromPhone || !patientId){
    return { text: '⚠️ 尚未選定病人，請先完成第 1 步。', done:false };
  }

  const hs = await readHistSession(fromPhone);
  let state = hs.state || 'ENTRY';
  let buf   = hs.buf   || {};

  const pDoc = await readPatient(fromPhone, patientId);
  const nameForBanner = pDoc?.name || patientName;
  const phoneForBanner = pDoc?.phone || fromPhone;

  if (state === 'ENTRY'){
    const h = pDoc?.history;
    const hasHistory = !!(h && (
      (Array.isArray(h.pmh) && h.pmh.length) ||
      (Array.isArray(h.meds) && h.meds.length) ||
      (h.allergies && ((Array.isArray(h.allergies.types) && h.allergies.types.length) ||
                       (Array.isArray(h.allergies.items) && h.allergies.items.length))) ||
      (h.social && (h.social.smoking || h.social.alcohol || h.social.travel))
    ));
    if (hasHistory){
      await writeHistSession(fromPhone, { state:'SHOW_EXISTING', buf:{} });
      return {
        text:
`${banner(nameForBanner, phoneForBanner)}

${renderSummary(h)}

是否需要更改？
1️⃣ 需要更改
2️⃣ 下一步`,
        done:false
      };
    }else{
      await writeHistSession(fromPhone, { state:'PMH_INPUT', buf:{} });
      return {
        text:
`${banner(nameForBanner, phoneForBanner)}

尚未建立病史，先從「過去病史（PMH）」開始。
請輸入過去病史，多項以「，」、「、」或換行分隔。
（例如：高血壓、糖尿病、痛風）`,
        done:false
      };
    }
  }

  if (state === 'SHOW_EXISTING'){
    if (body === '1'){
      await writeHistSession(fromPhone, { state:'PMH_INPUT', buf:{} });
      return {
        text:
`${banner(nameForBanner, phoneForBanner)}

請輸入過去病史（PMH），多項以「，」、「、」或換行分隔。`,
        done:false
      };
    }
    if (body === '2'){
      await writeHistSession(fromPhone, { state:'ENTRY', buf:{} });
      return { text:'✅ 病史已確認無需更改，進入下一步。', done:true };
    }
    return { text:'請輸入 1（需要更改）或 2（下一步）。', done:false };
  }

  if (state === 'PMH_INPUT'){
    const pmh = arrFromText(body);
    buf.history = buf.history || {}; buf.history.pmh = pmh;
    await writeHistSession(fromPhone, { state:'MEDS_INPUT', buf });
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}

✅ 已記錄 PMH
${fmtList(pmh)}

請輸入「現用藥（Meds）」清單，多項以「，」、「、」或換行分隔。
（例如：二甲雙胍、阿司匹林）`,
      done:false
    };
  }

  if (state === 'MEDS_INPUT'){
    const meds = arrFromText(body);
    buf.history = buf.history || {}; buf.history.meds = meds;
    await writeHistSession(fromPhone, { state:'ALG_TYPES_INPUT', buf });
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}

✅ 已記錄現用藥
${fmtList(meds)}

請輸入「過敏類型（types）」清單（例如：藥物、食物、環境）。`,
      done:false
    };
  }

  if (state === 'ALG_TYPES_INPUT'){
    const types = arrFromText(body);
    buf.history = buf.history || {};
    buf.history.allergies = buf.history.allergies || {};
    buf.history.allergies.types = types;
    await writeHistSession(fromPhone, { state:'ALG_ITEMS_INPUT', buf });
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}

✅ 已記錄過敏類型
${fmtList(types)}

請輸入「過敏明細（items）」清單（例如：阿莫西林、花生、塵蟎）。`,
      done:false
    };
  }

  if (state === 'ALG_ITEMS_INPUT'){
    const items = arrFromText(body);
    buf.history = buf.history || {};
    buf.history.allergies = buf.history.allergies || {};
    buf.history.allergies.items = items;
    await writeHistSession(fromPhone, { state:'SOCIAL_SMOKING_INPUT', buf });
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}

✅ 已記錄過敏明細
${fmtList(items)}

請輸入吸菸情形（例如：不吸菸／已戒菸／每日半包）。`,
      done:false
    };
  }

  if (state === 'SOCIAL_SMOKING_INPUT'){
    buf.history = buf.history || {};
    buf.history.social = buf.history.social || {};
    buf.history.social.smoking = fmtText(body);
    await writeHistSession(fromPhone, { state:'SOCIAL_ALCOHOL_INPUT', buf });
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}

✅ 已記錄吸菸：${fmtText(body)}

請輸入飲酒情形（例如：不飲酒／偶爾小酌／每週 2 次）。`,
      done:false
    };
  }

  if (state === 'SOCIAL_ALCOHOL_INPUT'){
    buf.history = buf.history || {};
    buf.history.social = buf.history.social || {};
    buf.history.social.alcohol = fmtText(body);
    await writeHistSession(fromPhone, { state:'SOCIAL_TRAVEL_INPUT', buf });
    return {
      text:
`${banner(nameForBanner, phoneForBanner)}

✅ 已記錄飲酒：${fmtText(body)}

請輸入近期旅遊史（例如：無／上月赴日本 5 天）。`,
      done:false
    };
  }

  if (state === 'SOCIAL_TRAVEL_INPUT'){
    buf.history = buf.history || {};
    buf.history.social = buf.history.social || {};
    buf.history.social.travel = fmtText(body);

    const newHistory = buf.history;
    await writeHistory(fromPhone, patientId, newHistory);
    await writeHistSession(fromPhone, { state:'REVIEW', buf:{ history:newHistory } });

    return {
      text:
`${banner(nameForBanner, phoneForBanner)}

✅ 已儲存最新病史

${renderSummary(newHistory)}

是否需要更改？
1️⃣ 重新填寫
2️⃣ 下一步`,
      done:false
    };
  }

  if (state === 'REVIEW'){
    if (body === '1'){
      await writeHistSession(fromPhone, { state:'PMH_INPUT', buf:{} });
      return {
        text:
`${banner(nameForBanner, phoneForBanner)}

請輸入過去病史（PMH），多項以「，」、「、」或換行分隔。`,
        done:false
      };
    }
    if (body === '2'){
      await writeHistSession(fromPhone, { state:'ENTRY', buf:{} });
      return { text:'✅ 病史模組完成，進入下一步。', done:true };
    }
    return { text:'請輸入 1（重新填寫）或 2（下一步）。', done:false };
  }

  // fallback
  await writeHistSession(fromPhone, { state:'ENTRY', buf:{} });
  return { text:'（提示）病史流程已重置，請重新開始本模組。', done:false };
}

module.exports = { handleHistory };