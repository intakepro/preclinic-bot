// modules/history.js
// File: modules/history.js
// Version: v6.2.0-fs-composite
//
// 功能重點：
// 1) 當使用者於 name_input 選擇病人後，如該病人已有病史：
//    - 顯示「病人姓名＋電話末四碼」在頂部
//    - 列出病史摘要
//    - 詢問：「是否要更改？還是下一步？」（1=更改，2=下一步）
// 2) 若選擇更改，提供分項編輯選單：過去病史/現用藥/過敏/社會史（吸菸/飲酒/旅遊）
// 3) 若選擇下一步，回傳 done: true 讓 index.js 進入下一模組
//
// Firestore 結構：
// patients/{phone}: {
//   name: String,
//   phone: String,
//   history: {
//     pmh: [String], // 過去病史
//     meds: [String], // 現用藥
//     allergies: { types: [String], items: [String] },
//     social: { smoking: String, alcohol: String, travel: String }
//   },
//   updatedAt: Timestamp
// }
//
// sessions/{from}: {
//   state: String,           // e.g. 'history:await_decision', 'history:menu', 'history:edit_pmh'...
//   patient: { name, phone } // 建議由 name_input 模組寫入
//   buffer: any              // 編輯暫存
//   module: 'history'        // 目前所在模組標記（可選）
// }
//
// 介面：createHistoryModule({ db }) -> { handle }
// 使用：
// const { createHistoryModule } = require('./modules/history');
// const { handle: handleHistory } = createHistoryModule(); // 若專案已初始化 admin，參數可省略
//
// 在 index.js 裡：
// const result = await handleHistory({ from, body });
// if (result.done) { // 進入下一步 }

const admin = require('firebase-admin');

// 僅初始化一次（整個專案可多檔共用）
if (!admin.apps.length) {
  // 建議用 GOOGLE_APPLICATION_CREDENTIALS 或應用預設認證
  admin.initializeApp();
}

const db = admin.firestore();

// ---- 工具函式 ---------------------------------------------------------
const last4 = (phone) => {
  if (!phone) return '****';
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-4).padStart(4, '*');
};

const fmtList = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return '（無）';
  return arr.map((v, i) => `  • ${v}`).join('\n');
};

const fmtText = (s) => (s && String(s).trim() ? String(s).trim() : '（無）');

const banner = (name, phone) =>
  `👤 病人：${name || '（未命名）'}（${last4(phone)}）`;

const renderHistorySummary = (history = {}) => {
  const pmh = fmtList(history.pmh);
  const meds = fmtList(history.meds);
  const allergiesTypes = fmtList((history.allergies && history.allergies.types) || []);
  const allergiesItems = fmtList((history.allergies && history.allergies.items) || []);
  const smoking = fmtText(history.social?.smoking);
  const alcohol = fmtText(history.social?.alcohol);
  const travel  = fmtText(history.social?.travel);

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
    `  類型：\n${allergiesTypes}`,
    `  明細：\n${allergiesItems}`,
    '',
    '— 社會史（Social）—',
    `  吸菸：${smoking}`,
    `  飲酒：${alcohol}`,
    `  旅遊：${travel}`,
  ].join('\n');
};

const decisionPrompt =
  '是否要更改病史？\n' +
  '1️⃣ 更改\n' +
  '2️⃣ 下一步（保持不變）\n' +
  '（請輸入 1 或 2）';

const editMenuText =
  '請選擇要更改的項目：\n' +
  '1️⃣ 過去病史（PMH）\n' +
  '2️⃣ 現用藥（Meds）\n' +
  '3️⃣ 過敏（Allergies）\n' +
  '4️⃣ 社會史（Social）\n' +
  '0️⃣ 返回上一層選單';

const allergiesMenuText =
  '過敏（Allergies）要更改哪一項？\n' +
  '1️⃣ 類型（types，例：藥物/食物/環境）\n' +
  '2️⃣ 明細（items，例：阿莫西林、花生）\n' +
  '0️⃣ 返回上一層';

const socialMenuText =
  '社會史（Social）要更改哪一項？\n' +
  '1️⃣ 吸菸（smoking）\n' +
  '2️⃣ 飲酒（alcohol）\n' +
  '3️⃣ 旅遊（travel）\n' +
  '0️⃣ 返回上一層';

// 將逗號、頓號、換行分割成陣列（去除空白）
const toArray = (text) =>
  String(text || '')
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

// ---- Firestore 讀寫 ----------------------------------------------------
async function readSession(from) {
  const ref = db.collection('sessions').doc(from);
  const snap = await ref.get();
  return snap.exists ? snap.data() : {};
}

async function writeSession(from, data) {
  const ref = db.collection('sessions').doc(from);
  await ref.set(data, { merge: true });
}

async function readPatientByPhone(phone) {
  if (!phone) return null;
  const ref = db.collection('patients').doc(phone);
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

async function upsertPatientHistory(phone, partialHistory) {
  const ref = db.collection('patients').doc(phone);
  await ref.set(
    {
      phone,
      history: partialHistory ? admin.firestore.FieldValue.delete() : {},
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  // 需再 merge 寫入 history（避免刪除整個節點）
  if (partialHistory) {
    await ref.set({ history: partialHistory, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
}

// ---- 主流程 ------------------------------------------------------------
function createHistoryModule(/* { db } 可擴充 */) {
  return {
    /**
     * handle({ from, body })
     * - from：WhatsApp 來話（電話字串）
     * - body：使用者輸入文字
     * 回傳：
     * { message, done?: boolean }
     *  - 若 done 為 true：index.js 可進入下一模組
     */
    handle: async ({ from, body }) => {
      const text = String(body || '').trim();
      const session = await readSession(from);

      // 取得目前病人（建議由 name_input 寫入 sessions.{from}.patient）
      const patient = session.patient || null;
      if (!patient?.phone) {
        await writeSession(from, { state: 'history:await_patient', module: 'history' });
        return {
          message:
            '（系統）尚未取得病人資訊。\n請先在「輸入病人名字」步驟選擇病人後再進入本模組。',
        };
      }

      const patientDoc = await readPatientByPhone(patient.phone);
      const hasHistory =
        patientDoc &&
        patientDoc.history &&
        (Array.isArray(patientDoc.history.pmh) ||
          Array.isArray(patientDoc.history.meds) ||
          (patientDoc.history.allergies &&
            (Array.isArray(patientDoc.history.allergies.types) ||
             Array.isArray(patientDoc.history.allergies.items))) ||
          (patientDoc.history.social &&
            (patientDoc.history.social.smoking ||
             patientDoc.history.social.alcohol ||
             patientDoc.history.social.travel)));

      // --- 進入點：若尚未進入任何子狀態，根據是否有病史來決定顯示 ---
      if (!session.state || !String(session.state).startsWith('history:')) {
        if (hasHistory) {
          const summary = renderHistorySummary(patientDoc.history || {});
          await writeSession(from, { state: 'history:await_decision', module: 'history' });
          return {
            message:
              `${banner(patientDoc.name || patient.name, patient.phone)}\n\n` +
              summary + '\n\n' +
              decisionPrompt,
          };
        } else {
          // 沒有病史，直接引導建立（從 PMH 開始）
          await writeSession(from, { state: 'history:edit_pmh:await_input', module: 'history', buffer: {} });
          return {
            message:
              `${banner(patientDoc?.name || patient.name, patient.phone)}\n` +
              '尚未建立病史，先從「過去病史（PMH）」開始。\n' +
              '請輸入過去病史，多項以「，」、「、」或換行分隔。\n' +
              '（例如：高血壓、糖尿病、痛風）',
          };
        }
      }

      // --- 狀態機處理 ---
      const state = session.state;

      // 1) 決策：更改 or 下一步
      if (state === 'history:await_decision') {
        if (text === '1') {
          await writeSession(from, { state: 'history:menu', module: 'history' });
          return { message: editMenuText };
        }
        if (text === '2') {
          // 下一步：結束模組
          await writeSession(from, { state: 'idle', module: null });
          return { message: '✅ 已保持病史不變，進入下一步。', done: true };
        }
        return { message: '請輸入 1（更改）或 2（下一步）。' };
      }

      // 2) 主選單
      if (state === 'history:menu') {
        if (text === '1') {
          await writeSession(from, { state: 'history:edit_pmh:await_input', buffer: {} });
          return { message: '請輸入「過去病史（PMH）」清單，多項可用逗號或換行分隔。' };
        }
        if (text === '2') {
          await writeSession(from, { state: 'history:edit_meds:await_input', buffer: {} });
          return { message: '請輸入「現用藥（Meds）」清單，多項可用逗號或換行分隔。' };
        }
        if (text === '3') {
          await writeSession(from, { state: 'history:edit_allergies:menu', buffer: {} });
          return { message: allergiesMenuText };
        }
        if (text === '4') {
          await writeSession(from, { state: 'history:edit_social:menu', buffer: {} });
          return { message: socialMenuText };
        }
        if (text === '0') {
          // 返回上一層（若你有上一模組，可在 index 接到此訊息時回退）
          await writeSession(from, { state: 'history:await_decision' });
          return { message: decisionPrompt };
        }
        return { message: '請輸入 1/2/3/4 或 0 返回。' };
      }

      // 3) PMH 編輯
      if (state === 'history:edit_pmh:await_input') {
        const pmh = toArray(text);
        const existing = (await readPatientByPhone(patient.phone)) || { name: patient.name, phone: patient.phone, history: {} };
        const history = existing.history || {};
        history.pmh = pmh;
        await upsertPatientHistory(patient.phone, history);
        await writeSession(from, { state: 'history:menu', buffer: null });
        return {
          message:
            '✅ 已更新「過去病史（PMH）」\n' +
            fmtList(pmh) +
            '\n\n' +
            editMenuText,
        };
      }

      // 4) Meds 編輯
      if (state === 'history:edit_meds:await_input') {
        const meds = toArray(text);
        const existing = (await readPatientByPhone(patient.phone)) || { name: patient.name, phone: patient.phone, history: {} };
        const history = existing.history || {};
        history.meds = meds;
        await upsertPatientHistory(patient.phone, history);
        await writeSession(from, { state: 'history:menu', buffer: null });
        return {
          message:
            '✅ 已更新「現用藥（Meds）」\n' +
            fmtList(meds) +
            '\n\n' +
            editMenuText,
        };
      }

      // 5) Allergies 編輯選單
      if (state === 'history:edit_allergies:menu') {
        if (text === '1') {
          await writeSession(from, { state: 'history:edit_allergies_types:await_input' });
          return { message: '請輸入「過敏類型（types）」清單，例如：藥物、食物、環境。' };
        }
        if (text === '2') {
          await writeSession(from, { state: 'history:edit_allergies_items:await_input' });
          return { message: '請輸入「過敏明細（items）」清單，例如：阿莫西林、花生、塵蟎。' };
        }
        if (text === '0') {
          await writeSession(from, { state: 'history:menu' });
          return { message: editMenuText };
        }
        return { message: '請輸入 1/2 或 0 返回。' };
      }

      if (state === 'history:edit_allergies_types:await_input') {
        const types = toArray(text);
        const existing = (await readPatientByPhone(patient.phone)) || { name: patient.name, phone: patient.phone, history: {} };
        const history = existing.history || {};
        history.allergies = history.allergies || {};
        history.allergies.types = types;
        await upsertPatientHistory(patient.phone, history);
        await writeSession(from, { state: 'history:edit_allergies:menu' });
        return {
          message:
            '✅ 已更新「過敏類型（types）」\n' +
            fmtList(types) +
            '\n\n' +
            allergiesMenuText,
        };
      }

      if (state === 'history:edit_allergies_items:await_input') {
        const items = toArray(text);
        const existing = (await readPatientByPhone(patient.phone)) || { name: patient.name, phone: patient.phone, history: {} };
        const history = existing.history || {};
        history.allergies = history.allergies || {};
        history.allergies.items = items;
        await upsertPatientHistory(patient.phone, history);
        await writeSession(from, { state: 'history:edit_allergies:menu' });
        return {
          message:
            '✅ 已更新「過敏明細（items）」\n' +
            fmtList(items) +
            '\n\n' +
            allergiesMenuText,
        };
      }

      // 6) Social 編輯選單
      if (state === 'history:edit_social:menu') {
        if (text === '1') {
          await writeSession(from, { state: 'history:edit_social_smoking:await_input' });
          return { message: '請輸入吸菸情形（例如：不吸菸／已戒菸／每日半包）。' };
        }
        if (text === '2') {
          await writeSession(from, { state: 'history:edit_social_alcohol:await_input' });
          return { message: '請輸入飲酒情形（例如：不飲酒／偶爾小酌／每週 2 次）。' };
        }
        if (text === '3') {
          await writeSession(from, { state: 'history:edit_social_travel:await_input' });
          return { message: '請輸入近期旅遊史（例如：無／上月赴日本 5 天）。' };
        }
        if (text === '0') {
          await writeSession(from, { state: 'history:menu' });
          return { message: editMenuText };
        }
        return { message: '請輸入 1/2/3 或 0 返回。' };
      }

      if (state === 'history:edit_social_smoking:await_input') {
        const val = fmtText(text);
        const existing = (await readPatientByPhone(patient.phone)) || { name: patient.name, phone: patient.phone, history: {} };
        const history = existing.history || {};
        history.social = history.social || {};
        history.social.smoking = val;
        await upsertPatientHistory(patient.phone, history);
        await writeSession(from, { state: 'history:edit_social:menu' });
        return {
          message:
            `✅ 已更新「吸菸」：${val}\n\n` +
            socialMenuText,
        };
      }

      if (state === 'history:edit_social_alcohol:await_input') {
        const val = fmtText(text);
        const existing = (await readPatientByPhone(patient.phone)) || { name: patient.name, phone: patient.phone, history: {} };
        const history = existing.history || {};
        history.social = history.social || {};
        history.social.alcohol = val;
        await upsertPatientHistory(patient.phone, history);
        await writeSession(from, { state: 'history:edit_social:menu' });
        return {
          message:
            `✅ 已更新「飲酒」：${val}\n\n` +
            socialMenuText,
        };
      }

      if (state === 'history:edit_social_travel:await_input') {
        const val = fmtText(text);
        const existing = (await readPatientByPhone(patient.phone)) || { name: patient.name, phone: patient.phone, history: {} };
        const history = existing.history || {};
        history.social = history.social || {};
        history.social.travel = val;
        await upsertPatientHistory(patient.phone, history);
        await writeSession(from, { state: 'history:edit_social:menu' });
        return {
          message:
            `✅ 已更新「旅遊」：${val}\n\n` +
            socialMenuText,
        };
      }

      // 預設回覆：維持在當前狀態
      return { message: '未能識別指令，請依畫面提示輸入對應數字或內容。' };
    },
  };
}

module.exports = { createHistoryModule };