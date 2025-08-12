//  index.js
const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
} else {
  admin.initializeApp(); // 本機用 GOOGLE_APPLICATION_CREDENTIALS
}
const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 小工具：取或建 session（同號→最近未結束的；否則新建）
async function getOrCreateSession(phone) {
  const q = await db.collectionGroup('sessions')
    .where('phone', '==', phone)
    .where('closedAt', '==', null)
    .orderBy('createdAt', 'desc').limit(1).get();
  if (!q.empty) return { ref: q.docs[0].ref, data: q.docs[0].data() };

  const tenantId = 'default';
  const ref = db.collection('tenants').doc(tenantId)
    .collection('sessions').doc();
  const data = {
    phone, patientId: null, channel: 'whatsapp',
    state: 'WELCOME', complaints: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    closedAt: null, version: 1
  };
  await ref.set(data);
  return { ref, data };
}

function reply(msg) {
  const twiml = new MessagingResponse();
  twiml.message(msg);
  return twiml.toString();
}

app.post('/whatsapp', async (req, res) => {
  const phone = (req.body.From || '').replace('whatsapp:', '');
  const text = (req.body.Body || '').trim();
  const { ref, data } = await getOrCreateSession(phone);
  let state = data.state;
  let complaints = data.complaints || [];
  let current = complaints[complaints.length - 1];

  // 全域指令
  if (/^重來$/i.test(text)) {
    await ref.update({ state: 'WELCOME', complaints: [] });
    return res.send(reply('✅ 已重設。👋 你好！我是預先問診助理……（輸入「開始」繼續）'));
  }
  if (/^結束$/i.test(text)) {
    await ref.update({ closedAt: admin.firestore.FieldValue.serverTimestamp(), state: 'DONE' });
    return res.send(reply('🧾 已結束。祝早日康復！'));
  }
  if (/^返回$/i.test(text)) {
    // 簡化處理：退回上一步（實務可用 state stack）
    const backMap = {
      IDENTIFY_PATIENT: 'WELCOME',
      MAIN_COMPLAINT_LOC: 'IDENTIFY_PATIENT',
      SENSATION: 'MAIN_COMPLAINT_LOC',
      ONSET: 'SENSATION',
      COURSE: 'ONSET',
      AGGRAVATING: 'COURSE',
      RELIEVING: 'AGGRAVATING',
      ASSOCIATED: 'RELIEVING',
      SEVERITY: 'ASSOCIATED',
      IMPACT: 'SEVERITY',
      SAFETY_FLAGS: 'IMPACT',
      REVIEW: 'SAFETY_FLAGS',
      SUMMARY: 'REVIEW'
    };
    state = backMap[state] || 'WELCOME';
    await ref.update({ state, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  // 對話流程
  async function setState(s) {
    state = s;
    await ref.update({ state, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  if (state === 'WELCOME') {
    if (!/^開始|start/i.test(text)) {
      await setState('WELCOME');
      return res.send(reply(
        '👋 你好！我是預先問診助理。過程約 2 分鐘。\n輸入「開始」繼續。\n（任何時候可輸入：返回／重來／結束）'
      ));
    }
    await setState('IDENTIFY_PATIENT');
    return res.send(reply('請輸入你的稱呼（例：陳先生、媽媽、我自己）：'));
  }

  if (state === 'IDENTIFY_PATIENT') {
    const displayName = text.slice(0, 40);
    const tenantId = 'default';
    const patientsRef = db.collection('tenants').doc(tenantId).collection('patients');
    // 以 phone + displayName 去查，找不到就建一個
    const snap = await patientsRef.where('phone', '==', phone).where('displayName', '==', displayName).limit(1).get();
    let patientRef, patientId;
    if (snap.empty) {
      patientRef = patientsRef.doc();
      await patientRef.set({ phone, displayName, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      patientId = patientRef.id;
    } else {
      patientRef = snap.docs[0].ref;
      patientId = patientRef.id;
    }
    await ref.update({ patientId });
    complaints.push({ id: 'cmp_' + Date.now(), loc_display: [] });
    await ref.update({ complaints });
    await setState('MAIN_COMPLAINT_LOC');
    return res.send(reply('❓主要哪裡不舒服？（可多選，分行輸入）\n🧠頭頸｜🫁胸｜🍔腹/下背｜💪上肢｜🦵下肢｜🩺全身｜❓其他（描述）'));
  }

  if (state === 'MAIN_COMPLAINT_LOC') {
    current = complaints[complaints.length - 1];
    current.loc_display = text.split(/[，,\/\n\s]+/).filter(Boolean).slice(0, 5);
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('SENSATION');
    return res.send(reply('💢不舒服的感覺是？（可多選）\n痛(刺/灼/壓)｜麻｜癢｜脹悶｜刺痛｜乏力｜呼吸困難｜心悸｜噁心｜其他（描述）'));
  }

  if (state === 'SENSATION') {
    current = complaints[complaints.length - 1];
    current.sensation_display = text.split(/[，,\/\n\s]+/).filter(Boolean).slice(0, 8);
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('ONSET');
    return res.send(reply('⏰ 什麼時候開始？\n今天／昨天／幾天前／幾星期前／幾個月前／記不起'));
  }

  if (state === 'ONSET') {
    current = complaints[complaints.length - 1];
    current.onset = text.slice(0, 20);
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('COURSE');
    return res.send(reply('📅 是持續還是間歇？\n持續｜間歇（一天多次／偶爾）'));
  }

  if (state === 'COURSE') {
    current = complaints[complaints.length - 1];
    current.course = /間歇/.test(text) ? '間歇' : '持續';
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('AGGRAVATING');
    return res.send(reply('🔥 什麼會令它更嚴重？\n活動/運動｜吃東西/喝水｜呼吸/咳嗽｜姿勢｜情緒/壓力｜無明顯關係｜其他'));
  }

  if (state === 'AGGRAVATING') {
    current = complaints[complaints.length - 1];
    current.aggravating = text.split(/[，,\/\n\s]+/).filter(Boolean).slice(0, 6);
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('RELIEVING');
    return res.send(reply('🌿 什麼會令它好些？\n休息｜熱敷｜冷敷｜按摩｜藥物（可寫藥名）｜無'));
  }

  if (state === 'RELIEVING') {
    current = complaints[complaints.length - 1];
    current.relieving = text.split(/[，,\/\n\s]+/).filter(Boolean).slice(0, 6);
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('ASSOCIATED');
    return res.send(reply('⚠️ 有沒有伴隨症狀？（可多選）\n發燒｜嘔吐｜腹瀉｜便秘｜咳嗽/有痰｜頭晕/暈厥｜胸悶｜下肢腫｜視力模糊｜尿頻/尿痛｜陰部分泌物異常｜無｜其他'));
  }

  if (state === 'ASSOCIATED') {
    current = complaints[complaints.length - 1];
    current.associated = text.split(/[，,\/\n\s]+/).filter(Boolean).slice(0, 10);
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('SEVERITY');
    return res.send(reply('📏 請以 0～10 評分嚴重程度（0=不困擾，10=最嚴重）：'));
  }

  if (state === 'SEVERITY') {
    current = complaints[complaints.length - 1];
    const n = Math.max(0, Math.min(10, parseInt(text, 10)));
    current.severity_nrs = isNaN(n) ? null : n;
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('IMPACT');
    return res.send(reply('🏷️ 影響日常活動嗎？\n無｜輕微影響｜需要休息｜無法工作/上學'));
  }

  if (state === 'IMPACT') {
    current = complaints[complaints.length - 1];
    current.impact = text.slice(0, 20);
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('SAFETY_FLAGS');
    return res.send(reply('請確認是否有以下任一：\n胸口劇痛／呼吸很困難／單側無力或說話困難／大量吐血或黑便／>39℃ 高燒超過24小時\n（有/沒有；若有，請簡述）'));
  }

  if (state === 'SAFETY_FLAGS') {
    current = complaints[complaints.length - 1];
    current.safety_flags = [text];
    // 生成簡要摘要（可替換成更複雜模板）
    const summary = `主訴：${(current.loc_display||[]).join('+')} ${((current.sensation_display||[])[0]||'不適')}
起病：${current.onset}；病程：${current.course}
加重：${(current.aggravating||[]).join('、')||'未述'}；緩解：${(current.relieving||[]).join('、')||'未述'}
伴隨：${(current.associated||[]).join('、')||'無'}
嚴重度：${current.severity_nrs ?? '未評'}；影響：${current.impact||'未述'}
危險徵象：${(current.safety_flags||[]).join('、')}`;
    current.summary_text = summary;
    complaints[complaints.length - 1] = current;
    await ref.update({ complaints });
    await setState('REVIEW');
    return res.send(reply('✅ 我會把你剛才的回答整理給你核對。輸入「對」或輸入「要修改 + 欲修改項目名稱」。'));
  }

  if (state === 'REVIEW') {
    if (/^對$/.test(text)) {
      await setState('SUMMARY');
      current = complaints[complaints.length - 1];
      return res.send(reply(🧾 摘要：\n${current.summary_text}\n\n要「新增主訴」嗎？（是/否）));
    }
    // 簡化：若要修改，直接回到第一個問題
    await setState('MAIN_COMPLAINT_LOC');
    return res.send(reply('好的，請重新輸入主要部位（可多選）。'));
  }

  if (state === 'SUMMARY') {
    if (/^是$/.test(text)) {
      complaints.push({ id: 'cmp_' + Date.now(), loc_display: [] });
      await ref.update({ complaints });
      await setState('MAIN_COMPLAINT_LOC');
      return res.send(reply('❓第二個主訴：主要哪裡不舒服？'));
    }
    await setState('DONE');
    return res.send(reply('完成，感謝你！若情況加劇，請及早就醫或致電緊急服務。'));
  }

  // DONE 或其他
  return res.send(reply('你已完成預先問診。輸入「重來」可重新開始。'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('WhatsApp triage bot listening on ' + port));





