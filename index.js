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






