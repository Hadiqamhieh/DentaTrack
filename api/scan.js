// Powers receipt and day-sheet scanning. Uses Google's Gemini API (free
// tier — no credit card required) instead of a paid API, since this
// beta doesn't have scanning volume that needs anything more yet.
//
// Kept to the exact same request/response shape the frontend already
// expects ({ imageBase64, mimeType, prompt } -> { text }) so ScanModal and
// ReceiptScanner didn't need any changes at all.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

async function callGemini(apiKey, { imageBase64, mimeType, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        // Zero temperature — this is a data-extraction task, not a creative
        // one, so we want the same receipt to read the same way every time
        // rather than the model taking a slightly different guess each call.
        temperature: 0,
      },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const message = data?.error?.message || 'Could not reach the scanning service.';
    const err = new Error(message);
    err.status = resp.status >= 400 && resp.status < 600 ? resp.status : 500;
    throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    const err = new Error(blockReason ? `Image couldn't be processed (${blockReason}).` : 'No result came back — try a clearer photo.');
    err.status = 500;
    throw err;
  }
  return text;
}

// A result that's entirely null/blank fields is almost always the model
// failing to read the image rather than a genuinely blank receipt — worth
// one silent retry before giving up and showing the person nothing.
function looksEmpty(text) {
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const values = Object.values(parsed);
    if (values.length === 0) return true;
    return values.every(v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
  } catch {
    return true; // unparseable is treated the same as empty — worth a retry
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Scanning is not configured on this deployment yet." });
  }

  const { imageBase64, mimeType, prompt } = req.body || {};
  if (!imageBase64 || !prompt) {
    return res.status(400).json({ error: 'Missing image or prompt.' });
  }

  try {
    let text = await callGemini(apiKey, { imageBase64, mimeType, prompt });
    if (looksEmpty(text)) {
      // One automatic, silent retry — the person never sees this happen.
      text = await callGemini(apiKey, { imageBase64, mimeType, prompt });
    }
    // Match the shape the frontend already expects from the old provider.
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Could not process the image.' });
  }
}

