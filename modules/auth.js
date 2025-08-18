/**
 * Module: modules/auth.js
 * Version: v6.0.0-placeholder
 * 說明：佔位；顯示第 2 步名稱，要求按 z 進入下一步
 */
async function handleAuth({ msg }) {
  const ok = /^z$/i.test((msg || '').trim());
  if (ok) return { text: '✅ 已確認進入下一步（第 2 步完成）。', done: true };
  return {
    text: '👉 第 2 步：病人問診權限檢查模組（製作中）\n請按 z 進入下一步。',
    done: false
  };
}
module.exports = { handleAuth };