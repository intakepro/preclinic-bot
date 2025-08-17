// File: modules/patient_profile.js | v0.1
// 第 2 流程：病人個人資料（佔位）

module.exports = async function run({ stepNo, stepName }) {
  console.log(`\n=== [STEP ${stepNo}] ${stepName} ===`);
  console.log('提示：這是佔位模組，功能正在製作中…');
  console.log('（稍候將自動返回主流程繼續下一步）');
  await new Promise((r) => setTimeout(r, 500));
};