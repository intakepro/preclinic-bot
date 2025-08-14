// index.js
// --- 基礎：Express + Twilio + Firestore（Render 環境友善寫法） ---
const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

// Firestore 初始化（雲端：用 FIREBASE_SERVICE_ACCOUNT；本機：用 GOOGLE_APPLICATION_CREDENTIALS）
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
} else {
  admin.initializeApp();
}
const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- 導航用：流程定義 ---
const FLOW = [
  {
    id: 'intro',
    name: '系統歡迎頁',
    questions: [
      {
        id: 'welcome',
        prompt:
          '👋 歡迎使用預先問診系統。\n輸入 1 開始；隨時輸入 0 回上一頁（此頁為最上層，0 將重新顯示本頁）。',
      },
    ],
  },
  {
    id: 'm1',
    name: '輸入病人名字模組',
    questions: [
      { id: 'pname', prompt: '1) 請輸入病人姓名（按 0 回上一頁）。' },
      { id: 'pname_confirm', prompt: '2) 請確認姓名是否正確？(1=是, 2=否；0=上一頁)' },
      { id: 'm1_placeholder', prompt: '📦 模組功能製作中…輸入任意鍵繼續（0=上一頁）。' },
    ],
  },
  {
    id: 'm2',
    name: '問診權限檢查模組',
    questions: [
      { id: 'auth_check', prompt: '是否同意進行問診權限檢查？(1=同意, 2=不同意；0=上一頁)' },
      { id: 'm2_placeholder', prompt: '📦 模組功能製作中…輸入任意鍵繼續（0=上一頁）。' },
    ],
  },
  {
    id: 'm3',
    name: '讀取病人資料模組',
    questions: [
      { id: 'fetch_profile', prompt: '讀取既有基本資料？(1=讀取, 2=略過；0=上一頁)' },
      { id: 'm3_placeholder', prompt: '📦 模組功能製作中…輸入任意鍵繼續（0=上一頁）。' },
    ],
  },
  {
    id: 'm4',
    name: '讀取病史模組',
    questions: [
      { id: 'hx', prompt: '是否載入過往病史？(1=是, 2=否；0=上一頁)' },
      { id: 'm4_placeholder', prompt: '📦 模組功能製作中…輸入任意鍵繼續（0=上一頁）。' },
    ],
  },
  {
    id: 'm5',
    name: '問診系統模組',
    questions: [
      { id: 'chief', prompt: '主訴是什麼？請用一句話描述（0=上一頁）。' },
      { id: 'onset', prompt: '開始時間/持續多久？（0=上一頁）' },
      { id: 'aggravate', prompt: '何時加重/誘因？（0=上一頁）' },
      { id: 'relieve', prompt: '什麼可緩解？（0=上一頁）' },
      { id: 'assoc', prompt: '伴隨症狀？（0=上一頁）' },
    ],
  },
  {
    id: 'm6',
    name: 'AI 整理模組',
    questions: [{ id: 'ai_compile', prompt: '📦 整理摘要（占位）。輸入任意鍵繼續（0=上一頁）。' }],
  },
  {
    id: 'm7',
    name: '匯出總結模組',
    questions: [{ id: 'export', prompt: '📦 匯出總結（占位）。輸入任意鍵完成（0=上一頁）。' }],
  },
];

// ---------- 安全工具 ----------
function clampState(state) {
  // 夾模組
  if (
    typeof state.currentModule !== 'number' ||
    state.currentModule < 0 ||
    state.currentModule >= FLOW.length
  ) {
    state.currentModule = 0;
  }
  const mod = FLOW[state.currentModule];

  // 夾題號
  if (
    typeof state.currentQuestion !== 'number' ||
    state.currentQuestion < 0 ||
    state.currentQuestion >= mod.questions.length
  ) {
    state.currentQuestion = 0;
  }

  // 歷史防呆
  if (!Array.isArray(state.history)) state.history = [];
  if (typeof state.answers !== 'object' || !state.answers) state.answers = {};
  return state;
}

function posKey(mIdx, qIdx) {
  // 邊界保護
  if (mIdx < 0 || mIdx >= FLOW.length) return null;
  const mod = FLOW[mIdx];
  if (!mod || qIdx < 0 || qIdx >= mod.questions.length) return null;
  return `${mod.id}.${mod.questions[qIdx].id}`;
}

function getPrompt(mIdx, qIdx) {
  const key = posKey(mIdx, qIdx);
  if (!key) {
    // 越界就回到 0,0
    return `【${FLOW[0].name} / 第 1 題】\n${FLOW[0].questions[0].prompt}\n\n（隨時輸入 0 回上一頁）`;
  }
  const mod = FLOW[mIdx];
  const q = mod.questions[qIdx];
  return `【${mod.name} / 第 ${qIdx + 1} 題】\n${q.prompt}\n\n（隨時輸入 0 回上一頁）`;
}

function isAtFirstQuestionOfModule(state) {
  return state.currentQuestion === 0;
}

function moveToNext(state) {
  clampState(state);
  const mod = FLOW[state.currentModule];
  if (state.currentQuestion < mod.questions.length - 1) {
    state.currentQuestion += 1;
    return state;
  }
  if (state.currentModule < FLOW.length - 1) {
    state.currentModule += 1;
    state.currentQuestion = 0;
    return state;
  }
  state.done = true;
  return state;
}

function moveToPrev(state) {
  clampState(state);
  if (!isAtFirstQuestionOfModule(state)) {
    state.currentQuestion -= 1;
    return state;
  }
  if (state.currentModule > 0) {
    state.currentModule -= 1;
    state.currentQuestion = FLOW[state.currentModule].questions.length - 1;
    return state;
  }
  return state; // 已到最頂
}

function recordAnswer(state, input) {
  clampState(state);
  const k = posKey(state.currentModule, state.currentQuestion);
  if (!k) return; // 越界就忽略一次
  state.answers[k] = input;
}

// --- 工具：取或建 session 狀態（每個來電號碼一份） ---
async function getOrCreateSession(phone) {
  const ref = db.collection('sessions').doc(phone);
  const snap = await ref.get();
  if (snap.exists) {
    const s = snap.data() || {};
    return { ref, data: clampState(s) };
  }

  const initState = clampState({
    currentModule: 0,
    currentQuestion: 0,
    history: [], // [{ m, q }]
    answers: {},
    done: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await ref.set(initState);
  return { ref, data: initState };
}

function reply(msg) {
  const twiml = new MessagingResponse();
  twiml.message(msg);
  return twiml.toString();
}

// --- 主處理：Twilio Webhook ---
app.post('/whatsapp', async (req, res) => {
  const fromRaw = req.body.From || '';
  const phone = fromRaw.replace('whatsapp:', '');
  const userInput = (req.body.Body || '').trim();

  const twiml = new MessagingResponse();

  try {
    const { ref, data: state } = await getOrCreateSession(phone);
    clampState(state);

    // restart
    if (/^restart$/i.test(userInput)) {
      const reset = {
        currentModule: 0,
        currentQuestion: 0,
        history: [],
        answers: {},
        done: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await ref.set(reset, { merge: true });
      twiml.message(getPrompt(0, 0));
      return res.type('text/xml').send(twiml.toString());
    }

    // 已完成
    if (state.done) {
      twiml.message('✅ 問診已完成。輸入 "restart" 重新開始。');
      return res.type('text/xml').send(twiml.toString());
    }

    // 回上一頁
    if (userInput === '0') {
      if (Array.isArray(state.history) && state.history.length > 0) {
        const prev = state.history.pop();
        if (prev && Number.isInteger(prev.m) && Number.isInteger(prev.q)) {
          state.currentModule = prev.m;
          state.currentQuestion = prev.q;
        } else {
          moveToPrev(state);
        }
      } else {
        moveToPrev(state);
      }

      clampState(state);
      await ref.set(
        { ...state, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      twiml.message(getPrompt(state.currentModule, state.currentQuestion));
      return res.type('text/xml').send(twiml.toString());
    }

    // 正常作答
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.push({ m: state.currentModule, q: state.currentQuestion });

    recordAnswer(state, userInput);
    moveToNext(state);
    clampState(state);

    await ref.set(
      {
        currentModule: state.currentModule,
        currentQuestion: state.currentQuestion,
        history: state.history.slice(-50), // 限制長度
        answers: state.answers,
        done: !!state.done,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (state.done) {
      twiml.message('🏁 全流程完成！\n你的資料已傳送給系統。\n輸入 "restart" 可重新開始。');
    } else {
      twiml.message(getPrompt(state.currentModule, state.currentQuestion));
    }
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Error:', err);
    twiml.message('⚠️ 系統發生錯誤，請稍後再試。');
    return res.type('text/xml').send(twiml.toString());
  }
});

// 健康檢查
app.get('/', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
