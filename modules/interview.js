/**
 * Module: modules/interview.js
 * Version: v6.0.0-placeholder
 * 說明：佔位；顯示第 5 步名稱，要求按 z 進入下一步
 */
async function handleInterview({ msg }) {
  const ok = /^z$/i.test((msg || '').trim());
  if (ok) return { text: '✅ 已確認進入下一步（第 5 步完成）。', done: true };
  return {
    text: '👉 第 5 步：問診系統模組（製作中）\n請按 z 進入下一步。',
    done: false
  };
}
module.exports = { handleInterview };