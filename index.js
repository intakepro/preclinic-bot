/**
 * Module: index.js
 * Version: v3.4.0
 * Date: 2025-08-17
 * 更新內容：
 * - 徹底移除 Index 層的「0 跳去下一步」行為（所有步驟前進由各模組回傳 autoNext 控制）
 * - restart/首次進入：先回歡迎語，並在同一回合委派 name_input 發第一題（twiml 直寫）
 * - 統一接線：依步驟呼叫對應模組，若回 {autoNext:true} 則自動前進並呼叫下一模組
 * - 整合模組：name_input、auth、profile、history、interview、ai_summar、export
 */

const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;

// ===== 你的各模組 Handler =====
const { handleNameInput } = require('./modules/name_input');
const { handleAuth } = require('./modules/auth');
const { handleProfile } = require('./modules/profile');
const { handleHistory } = require('./modules/history_module');
const { handleInterview } = require('./modules/interview');
const { handleAiSummar } = require('./modules/ai_summar');
const { handleExport } = require('./modules/export');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ===== 流程步驟定義（固定 7 步）=====
const STEPS = [
  { id: 1, key: 'name_input', name: '輸入病人名字模組', handler: handleNameInput },
  { id: 2, key: 'auth',       name: '病人問診權限檢查模組', handler: handleAuth },
  { id: 3, key: 'profile',    name: '讀取病人資料模組',   handler: handleProfile },
  { id: 4, key: 'history',    name: '讀取病人病史模組',   handler: handleHistory },
  { id: 5, key: 'interview',  name: '問診系統模組',       handler: handleInterview },
  { id: 6, key: 'ai_summar',  name: 'AI 整理模組',        handler: handleAiSummar },
  { id: 7, key: 'export',     name: '匯出總結模組',        handler: handleExport },
];

// ===== 簡單 Session（記憶體）=====
const sessions = new Map();
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { stepIndex: 0, selectedPatient: null });
  }
  return sessions.get(from);
}

// ===== UI =====
function welcomeText() {
  return [
    '👋 歡迎使用 X 醫生問診系統，我哋而家開始啦⋯⋯😊',
    '提示：各模組完成後會自動跳到下一步；如需回上一題，請依各模組提示（例如 0 / prev / ←）。'
  ].join('\n');
}
function finishText() {
  return '✅ 問診已完成，你的資料已傳送給醫生，謝謝你，祝你早日康復 ❤️';
}

// ===== 工具：標準化模組回傳 =====
function normalizeResult(result) {
  if (result && typeof result === 'object') {
    return { replied: !!result.replied, autoNext: !!result.autoNext, text: result.text ?? null };
  }
  if (typeof result === 'string') {
    const auto = result.includes('[[AUTO_NEXT]]');
    return { replied: false, autoNext: auto, text: result.replace('[[AUTO_NEXT]]', '').trim() };
  }
  return { replied: false, autoNext: false, text: null };
}
function inRangeStep(i) {
  return Math.max(0, Math.min(i, STEPS.length - 1));
}

// ===== 呼叫目前步驟對應模組 =====
async function runCurrentStep({ stepIndex, req, res, from, msg, twiml, session }) {
  const step = STEPS[inRangeStep(stepIndex)];
  const handler = step.handler;
  if (typeof handler !== 'function') {
    // 沒有 handler（理論上不會發生）
    const tw = twiml || new MessagingResponse();
    tw.message(`【${step.id}. ${step.name}】暫未接線。`);
    if (!twiml) return res.type('text/xml').send(tw.toString());
    return;
  }

  // 呼叫模組
  const raw = await handler({ req, res, from, msg, twiml });

  // 標準化
  const r = normalizeResult(raw);
  if (r.replied) {
    // 模組已回覆（或 twiml 已寫入）
    if (r.autoNext) {
      session.stepIndex = inRangeStep(stepIndex + 1);
      // 如果還有下一個步驟，立即呼叫下一模組（同一回合續寫 twiml）
      if (twiml && session.stepIndex < STEPS.length) {
        await runCurrentStep({ stepIndex: session.stepIndex, req, res, from, msg: '', twiml, session });
      }
    }
    return true; // 已回覆
  }

  // 若模組只回了純文字（少見），由 index 回覆
  if (r.text) {
    const tw = twiml || new MessagingResponse();
    tw.message(r.text);
    if (r.autoNext) {
      session.stepIndex = inRangeStep(stepIndex + 1);
      if (!twiml) return res.type('text/xml').send(tw.toString());
      return true;
    }
    if (!twiml) return res.type('text/xml').send(tw.toString());
    return true;
  }

  // 兜底：不多發雜訊
  if (!twiml) return res.status(204).end();
  return true;
}

// ===== Webhook =====
app.post('/whatsapp', async (req, res) => {
  const from = (req.body.From || '').toString();
  const msg  = (req.body.Body || '').toString().trim();
  const session = getSession(from);

  // 指令：restart
  if (/^restart$/i.test(msg)) {
    session.stepIndex = 0;
    const twiml = new MessagingResponse();
    twiml.message(welcomeText());
    // 同回合立即執行 Step 1（name_input）第一題
    await runCurrentStep({ stepIndex: 0, req, res, from, msg: '', twiml, session });
    return res.type('text/xml').send(twiml.toString());
  }

  // 指令：help（列步驟）
  if (/^help$/i.test(msg)) {
    const twiml = new MessagingResponse();
    twiml.message(
      '📖 流程步驟：\n' + STEPS.map(s => `  ${s.id}. ${s.name}`).join('\n')
    );
    return res.type('text/xml').send(twiml.toString());
  }

  // 首次進入（空訊息）：歡迎 + 同回合進 Step 1
  if (session.stepIndex === 0 && msg === '') {
    const twiml = new MessagingResponse();
    twiml.message(welcomeText());
    await runCurrentStep({ stepIndex: 0, req, res, from, msg: '', twiml, session });
    return res.type('text/xml').send(twiml.toString());
  }

  // 一般流程：把輸入交給當前步驟模組處理
  const handled = await runCurrentStep({
    stepIndex: session.stepIndex, req, res, from, msg, session
  });
  if (handled) return;

  // 若走到此處，表示模組沒回覆任何內容（極少見）
  return res.status(204).end();
});

// 健康檢查
app.get('/', (_req, res) => res.send('PreDoctor AI flow server running v3.4.0'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));