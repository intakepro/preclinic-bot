/**
 * Module: modules/ai_summar.js
 * Version: v6.0.0-placeholder
 * 說明：佔位；顯示第 6 步名稱，要求按 z 進入下一步
 */
async function handleAiSummar({ msg }) {
  const ok = /^z$/i.test((msg || '').trim());
  if (ok) return { text: '✅ 已確認進入下一步（第 6 步完成）。', done: true };
  return {
    text: '👉 第 6 步：AI 整理模組（製作中）\n請按 z 進入下一步。',
    done: false
  };
}
module.exports = { handleAiSummar };