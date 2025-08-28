// modules/interview/location.js
// Version: v1.0.0
// 顯示第一層身體部位，並支援選擇下一層

const admin = require('firebase-admin');
const db = admin.firestore();

function phoneOf(from) {
  return (from || '').toString().replace(/^whatsapp:/i, '').trim() || 'DEFAULT';
}

async function handle({ from, msg }) {
  const userPhone = phoneOf(from);

  const parentId = msg.trim().toLowerCase() === 'z' ? null : msg.trim(); // 選項或 z 開始
  const snapshot = await db.collection('body_parts_tree')
    .where('parent_id', parentId)
    .orderBy('sort_order')
    .get();

  if (snapshot.empty) {
    return {
      text: '⚠️ 找不到子部位，請重新輸入或輸入 z 返回。',
      done: false,
    };
  }

  const options = [];
  snapshot.forEach(doc => {
    const d = doc.data();
    const emoji = d.icon || '';
    options.push(`${options.length + 1}. ${emoji}${d.name_zh} (${d.id})`);
  });

  // 儲存目前的位置 ID（可略）
  await db.collection('sessions').doc(userPhone).set({
    lastLocationParentId: parentId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return {
    text: `📍請選擇更細的身體部位：\n${options.join('\n')}\n\n輸入選項編號或 ID。`,
    done: false,
  };
}

module.exports = { handle };