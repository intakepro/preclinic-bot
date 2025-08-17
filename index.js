/**
 * Module: index.js
 * Version: v3.3.1
 * Date: 2025-08-17
 * 更新內容：
 * - restart/首次進入：先回「歡迎語」，再於同一回合立即委派 name_input 發出第一題
 * - 保持規則：第 4 步（history）不可用 0 跳過；0 僅適用於佔位模組（2/3/5/6/7）
 */

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

const { handleNameInput } = require('./modules/name_input');
const { handleHistory } = require('./modules/history_module');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====== 流程步驟定義（7 個）======
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組' },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組（佔位）' },
  { id: 3, key: 'profile',    name: '讀取病人資料模組（佔位）' },
  { id: 4, key: 'history',    name: '讀取病人病史模組' },
  { id: 5, key: 'interview',  name: '問診系統模組（佔位）' },
  { id: 6, key: 'ai_summar',  name: 'AI整理模組（佔位）' },
  { id: 7, key: 'export',     name: '匯出總結模組（佔位）' },
];

// 記憶體 Session：{ [fromPhone]: { stepIndex, selectedPatient? } }
const sessions = new Map();
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { stepIndex: 0, selectedPatient: null });
  }
  return sessions.get(from);
}

// UI
function placeholderMessage(step) {
  return [
    `🔧 【${step.id}. ${step.name}】`,
    `此步驟暫為佔位畫面。請輸入「0」跳去下一個流程。`
  ].join('\n');
}
function welcomeText() {
  return [
    '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊',
    '（提示：任何題目可用 0 / prev / ← 回上一題；',
    '  在佔位步驟 2/3/5/6/7 可用 0 跳至下一步；第 4 步不可用 0 跳過）'
  ].join('\n');
}

// ====== 自動前進 helper ======
function applyAutoNext(result, session, nextIndex) {
  if (result && result.autoNext === true) {
    session.stepIndex = nextIndex;
  }
  return result && result.replied;
}

// ====== Webhook ======
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').toString();
  const msg  = (req.body.Body || '').toString().trim();
  const session = getSession(from);
  const currentStep = STEPS[session.stepIndex];

  // ============ restart / 首次進入：同一回合送「歡迎語」+ 交由 name_input 發第一題 ============
  if (/^restart$/i.test(msg) || (session.stepIndex === 0 && msg === '')) {
    session.stepIndex = 0;

    // 建立 TwiML，先放歡迎語
    const twiml = new MessagingResponse();
    twiml.message(welcomeText());

    // 立即把同一個 TwiML 交給 name_input，請它把「第一題」附加在這個 twiml 上
    // 注意：name_input 需支援當傳入 { twiml } 時，使用 twiml.message() 並且不要 res.send()
    const result = await handleNameInput({
      req, res, from, msg: '',
      twiml,   // ★ 新增：讓模組把問題加在這個 TwiML
      // 舊 callback 仍可用（相容）
      advanceNext: () => { session.stepIndex = 1; }
    });

    // 若模組已經把訊息加進 twiml，這裡直接一次過送出
    // （即使 result 為 undefined 也沒所謂，只要 twiml 已包含兩段訊息即可）
    return res.type('text/xml').send(twiml.toString());
  }

  // ===== help =====
  if (/^help$/i.test(msg)) {
    const twiml = new MessagingResponse();
    const lines = STEPS.map(s => `  ${s.id}. ${s.name}`).join('\n');
    twiml.message('📖 流程步驟清單：\n' + lines);
    return res.type('text/xml').send(twiml.toString());
  }

  // ===== Step 1：name_input =====
  if (currentStep.key === 'name_input') {
    const result = await handleNameInput({
      req, res, from, msg,
      advanceNext: () => { session.stepIndex = 1; }
    });
    if (applyAutoNext(result, session, 1)) return;
    if (result && result.replied) return;
    const twiml = new MessagingResponse();
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // ===== Step 4：history（❌ 不允許 0 跳過；看 autoNext 決定是否前進）=====
  if (currentStep.key === 'history') {
    const result = await handleHistory({ from, body: msg });
    if (applyAutoNext(result, session, 4)) return;
    if (result && result.replied) return;
    const twiml = new MessagingResponse();
    twiml.message('（系統已處理你的輸入）');
    return res.type('text/xml').send(twiml.toString());
  }

  // ===== 其他佔位模組：0 ➝ 下一步（統一處理）=====
  if (msg === '0') {
    const twiml = new MessagingResponse();
    if (session.stepIndex < STEPS.length - 1) {
      session.stepIndex += 1;
      const nextStep = STEPS[session.stepIndex];
      twiml.message(placeholderMessage(nextStep));
      return res.type('text/xml').send(twiml.toString());
    } else {
      twiml.message('✅ 問診已完成，你的資料已傳送給醫生，祝你早日康復 ❤️');
      res.type('text/xml').send(twiml.toString());
      setTimeout(() => process.exit(0), 1000);
      return;
    }
  }

  // 其他一般輸入 → 顯示佔位提示
  const twiml = new MessagingResponse();
  twiml.message(placeholderMessage(currentStep));
  return res.type('text/xml').send(twiml.toString());
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
