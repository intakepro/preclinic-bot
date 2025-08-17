// File: modules/permission_check_first.js | v0.1
// 第 1 流程：第一次權限檢查（佔位）

module.exports = async function run({ stepNo, stepName }) {
  console.log(`\n=== [STEP ${stepNo}] ${stepName} ===`);
  console.log('檢查：這是佔位模組，功能正在製作中…');
  console.log('（稍候將自動返回主流程繼續下一步）');
  await new Promise((r) => setTimeout(r, 500));
};