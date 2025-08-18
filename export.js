/**
 * Module: modules/export.js
 * Version: v6.0.0-placeholder
 * 說明：佔位；顯示第 7 步名稱，要求按 z 進入下一步
 */
async function handleExport({ msg }) {
  const ok = /^z$/i.test((msg || '').trim());
  if (ok) return { text: '✅ 已確認完成（第 7 步完成）。', done: true };
  return {
    text: '👉 第 7 步：匯出總結模組（製作中）\n請按 z 完成流程。',
    done: false
  };
}
module.exports = { handleExport };