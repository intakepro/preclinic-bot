// modules/interview.js
// Version: v2.0.1

const handleLocation = require('.module/interview/location');

async function handle({ from, msg, session }) {
  const step = session?.step || 1;

  if (step === 1) {
    const out = await handleLocation({ from, msg });
    const isDone = out.done || false;
    return {
      texts: Array.isArray(out.texts) ? out.texts : [out.text],
      sessionPatch: isDone ? { step: 2 } : {}
    };
  }

  return {
    texts: ['📌 尚未實作此步驟，請按 z 返回或等待功能上線。'],
    done: false
  };
}

module.exports = { handle };