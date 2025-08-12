// index.js
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











// index.js
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const admin = require('firebase-admin');
const bodyParser = require('body-parser');

// --- Firestore 初始化（兩種方式擇一） ---
// 方式 A：用 GOOGLE_APPLICATION_CREDENTIALS 指向 service account JSON 檔
// admin.initializeApp();

// 方式 B：用環境變數 FIREBASE_SERVICE_ACCOUNT（Render/雲端常用）
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  // 本機開發：讀檔或用 ADC
  admin.initializeApp();
}


const db = admin.firestore();

db.collection('test').doc('ping').set({ t: new Date() })
  .then(() => console.log('✅ Firestore 寫入成功'))
  .catch(err => console.error('❌ Firestore 連線失敗', err));




const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 小工具：正規化電話（Twilio From: 'whatsapp:+8869xxxxxxx'）
function normalizePhone(from) {
  if (!from) return '';
  return from.replace(/^whatsapp:/, '');
}

// 取得或建立 session
async function getOrCreateSession(phone) {
  const ref = db.collection('sessions').doc(phone);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ state: 'init', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { state: 'init' };
  }
  return snap.data();
}

// 更新 session
async function updateSession(phone, data) {
  const ref = db.collection('sessions').doc(phone);
  await ref.set({ ...data, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

// 讀取該電話底下的所有病人清單
async function listPatientsByPhone(phone) {
  const ref = db.collection('phones').doc(phone);
  const snap = await ref.get();
  if (!snap.exists) return [];
  const data = snap.data() || {};
  return data.patients || [];
}

// 將新病人掛到該電話
async function attachPatientToPhone(phone, patientId, name) {
  const ref = db.collection('phones').doc(phone);
  await ref.set({
    patients: admin.firestore.FieldValue.arrayUnion({ id: patientId, name }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

// 建立新病人檔
async function createPatient({ phone, name, gender, birthYear }) {
  const patientRef = db.collection('patients').doc();
  const patient = {
    phone,
    name,
    gender: gender || null,
    birthYear: birthYear || null,
    allergies: [],
    chronic: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await patientRef.set(patient);
  return { id: patientRef.id, ...patient };
}

// 問診第一題（你之後可換成你的正式流程）
function firstQuestion() {
  return '第1題：❓請先描述「哪裡不舒服？」（可輸入文字，例如：右上腹、左膝、胸口）';
}

// 產生病人清單文字
function patientsListMessage(patients) {
  const lines = patients.map((p, idx) => `${idx + 1}. ${p.name}`);
  lines.push('0. ➕ 新增病人');
  return `我們找到以下曾經登記的病人，請回覆序號或姓名：\n` + lines.join('\n');
}

// 解析使用者選擇（數字或姓名）
function resolvePatientSelection(input, patients) {
  const trimmed = input.trim();
  // 數字
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (n === 0) return { type: 'new' };
    if (n >= 1 && n <= patients.length) {
      return { type: 'existing', patient: patients[n - 1] };
    }
  }
  // 姓名比對（全等忽略空白）
  const byName = patients.find(p => p.name.replace(/\s/g, '') === trimmed.replace(/\s/g, ''));
  if (byName) return { type: 'existing', patient: byName };
  return null;
}

// WhatsApp Webhook
app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  try {
    const body = (req.body.Body || '').trim();
    const from = normalizePhone(req.body.From); // e.g. '+8869xxxxxxx'

    if (!from) {
      twiml.message('無法取得您的電話號碼，請稍後再試。');
      return res.type('text/xml').send(twiml.toString());
    }

    let session = await getOrCreateSession(from);

    // 狀態機
    switch (session.state) {
      case 'init': {
        const patients = await listPatientsByPhone(from);
        if (patients.length > 0) {
          await updateSession(from, { state: 'awaiting_select_existing_patient' });
          twiml.message(patientsListMessage(patients));
        } else {
          await updateSession(from, { state: 'awaiting_new_name', tempNewPatient: {} });
          twiml.message('看起來您是第一次使用。請先輸入病人「姓名」。');
        }
        break;
      }

      case 'awaiting_select_existing_patient': {
        const patients = await listPatientsByPhone(from);
        const choice = resolvePatientSelection(body, patients);
        if (!choice) {
          twiml.message('抱歉我沒看懂您的選擇。請回覆序號（例如 1）或直接回覆姓名；若要新增，回覆 0。');
          break;
        }
        if (choice.type === 'new') {
          await updateSession(from, { state: 'awaiting_new_name', tempNewPatient: {} });
          twiml.message('請輸入新病人的「姓名」。');
        } else {
          const { id, name } = choice.patient;
          await updateSession(from, { state: 'triage_q1', currentPatientId: id });
          twiml.message(`已選擇：${name}\n${firstQuestion()}`);
        }
        break;
      }

      case 'awaiting_new_name': {
        const name = body;
        const temp = { ...(session.tempNewPatient || {}), name };
        await updateSession(from, { state: 'awaiting_new_gender', tempNewPatient: temp });
        twiml.message('請輸入性別（M/F/Other）。');
        break;
      }

      case 'awaiting_new_gender': {
        const g = body.toUpperCase();
        const gender = (g === 'M' || g === 'F') ? g : 'Other';
        const temp = { ...(session.tempNewPatient || {}), gender };
        await updateSession(from, { state: 'awaiting_new_birthYear', tempNewPatient: temp });
        twiml.message('請輸入出生年份（例如：1990）。');
        break;
      }

      case 'awaiting_new_birthYear': {
        const y = parseInt(body, 10);
        if (!/^\d{4}$/.test(String(y)) || y < 1900 || y > new Date().getFullYear()) {
          twiml.message('出生年份格式不正確，請以四位數年份輸入（例如：1990）。');
          break;
        }
        const temp = { ...(session.tempNewPatient || {}), birthYear: y };
        // 建立病人檔
        const newPatient = await createPatient({
          phone: from,
          name: temp.name,
          gender: temp.gender,
          birthYear: temp.birthYear
        });
        await attachPatientToPhone(from, newPatient.id, newPatient.name);
        await updateSession(from, { state: 'triage_q1', currentPatientId: newPatient.id, tempNewPatient: {} });
        twiml.message(`✅ 建檔完成，謝謝！\n${firstQuestion()}`);
        break;
      }

      case 'triage_q1': {
        // 這裡開始接你的問診流程邏輯（把 body 視為第1題的回答）
        // 範例：先存進 conversations（選擇性）
        await db.collection('conversations').add({
          phone: from,
          patientId: session.currentPatientId || null,
          step: 'q1_location',
          answer: body,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 下一題（示範）
        twiml.message('第2題：💢不舒服的感覺是什麼？（痛、麻、癢、刺、壓痛…可複選以逗號分隔）');
        // 你也可以在這裡 updateSession 進入下一個 state
        await updateSession(from, { state: 'triage_q2' });
        break;
      }

      default: {
        // 未覆蓋的狀態，回到 init
        await updateSession(from, { state: 'init' });
        twiml.message('我們繼續吧！請稍等重新確認您的資料…');
        break;
      }
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error(err);
    twiml.message('系統忙線或發生錯誤，請稍後再試。');
    res.type('text/xml').send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});


