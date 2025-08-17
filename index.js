// File: index.js | v0.1
// 說明：主流程，順序呼叫 7 個模組；支援隨時輸入 `restart` / `end`

const readline = require('readline');

// --- 導入各模組 ---
const step1 = require('./modules/permission_check_first');
const step2 = require('./modules/patient_profile');
const step3 = require('./modules/permission_check_second');
const step4 = require('./modules/patient_history');
const step5 = require('./modules/intake_questionnaire');
const step6 = require('./modules/ai_summary');
const step7 = require('./modules/export_summary');

// --- 全域控制旗標 ---
let shouldRestart = false;
let shouldEnd = false;

// 建立 stdin 監聽，任何時候輸入 `restart` 或 `end` 都生效
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('> ');
rl.on('line', (line) => {
  const cmd = String(line || '').trim().toLowerCase();
  if (cmd === 'restart') {
    console.log('🔄 收到 restart 指令：流程將從最開頭重新開始。');
    shouldRestart = true;
  } else if (cmd === 'end') {
    console.log('👋 收到 end 指令：謝謝，程序完結。');
    shouldEnd = true;
  } else {
    console.log('（提示：輸入 `restart` 可重來；輸入 `end` 可結束）');
  }
  rl.prompt();
});

// 小工具：檢查是否要重啟或結束
function checkControl() {
  if (shouldEnd) {
    console.log('🙏 謝謝程序完結');
    process.exit(0);
  }
  if (shouldRestart) {
    shouldRestart = false; // 清回來，避免無限重啟
    return true;           // 呼叫端據此決定重新開始
  }
  return false;
}

// 主流程
async function runFlow() {
  console.clear();
  console.log('你好，我喺X醫生的預先問診系統，我哋現在開始啦😊');
  console.log('（任何時候輸入 `restart` 立即重來；輸入 `end` 立即結束）\n');

  const steps = [
    { fn: step1, name: '第一次權限檢查模組' },
    { fn: step2, name: '病人個人資料模組' },
    { fn: step3, name: '第二次權限檢查模組' },
    { fn: step4, name: '病人病史模組' },
    { fn: step5, name: '問診系統模組' },
    { fn: step6, name: 'AI整理模組' },
    { fn: step7, name: '匯出總結模組' },
  ];

  for (let i = 0; i < steps.length; i++) {
    // 每步開始先檢查控制旗標
    if (checkControl()) return runFlow(); // 重新開始
    const stepNo = i + 1;
    await steps[i].fn({ stepNo, stepName: steps[i].name });

    // 每步完成後再檢查一次（可能在模組顯示過程中使用者下了指令）
    if (checkControl()) return runFlow();
  }

  console.log('\n✅ 問診已完成，你的資料已傳送給醫生。謝謝你，祝你身體早日康復❤️');
  process.exit(0);
}

// 啟動
rl.prompt();
runFlow().catch((err) => {
  console.error('流程發生錯誤：', err);
  process.exit(1);
});