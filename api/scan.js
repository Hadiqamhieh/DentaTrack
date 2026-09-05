// Powers receipt and day-sheet scanning. Uses Google's Gemini API (free
// tier — no credit card required) instead of a paid API, since this
// beta doesn't have scanning volume that needs anything more yet.
//
// Kept to the exact same request/response shape the frontend already
// expects ({ imageBase64, mimeType, prompt } -> { text }) so ScanModal and
// ReceiptScanner didn't need any changes at all.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

async function callGemini(apiKey, { imageBase64, mimeType, prompt }, label) {
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
        temperature: 0,
      },
    }),
  });
  const data = await resp.json();

  // Log everything to Vercel's function logs regardless of outcome — this is
  // the actual ground truth we've been missing, not another guess.
  console.log(`[scan:${label}] status=${resp.status} finishReason=${data?.candidates?.[0]?.finishReason} blockReason=${data?.promptFeedback?.blockReason} safety=${JSON.stringify(data?.candidates?.[0]?.safetyRatings || data?.promptFeedback?.safetyRatings || [])}`);

  if (!resp.ok) {
    const message = resp.status === 429
      ? "Scanning is briefly at its free-tier limit — wait about a minute and try again."
      : (data?.error?.message || 'Could not reach the scanning service.');
    const err = new Error(message);
    err.status = resp.status >= 400 && resp.status < 600 ? resp.status : 500;
    throw err;
  }

  const finishReason = data?.candidates?.[0]?.finishReason;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    const err = new Error(
      blockReason ? `Image couldn't be processed (blocked: ${blockReason}).`
      : finishReason ? `No result came back (reason: ${finishReason}).`
      : 'No result came back — try a clearer photo.'
    );
    err.status = 500;
    throw err;
  }
  return { text, finishReason };
}

// A result where most fields came back null/blank is almost always the
// model failing to read the image rather than a genuinely sparse receipt —
// worth retrying before giving up and showing the person an incomplete scan.
// (A single legitimately-blank optional field, like "lab fees" on a day
// sheet that had none, shouldn't trigger this — only a majority-blank result.)
function looksEmpty(text) {
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const values = Object.values(parsed);
    if (values.length === 0) return true;
    const emptyCount = values.filter(v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)).length;
    return emptyCount / values.length > 0.5;
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
    let { text, finishReason } = await callGemini(apiKey, { imageBase64, mimeType, prompt }, 'attempt-1');

    if (looksEmpty(text)) {
      console.log(`[scan] attempt-1 looked empty (finishReason=${finishReason}), retrying`);
      const retry = await callGemini(apiKey, { imageBase64, mimeType, prompt }, 'attempt-2');
      // If the retry is still empty, surface exactly why instead of silently
      // returning a blank result the person can't do anything about.
      if (looksEmpty(retry.text)) {
        console.log(`[scan] attempt-2 also looked empty (finishReason=${retry.finishReason}). Raw: ${retry.text.slice(0,300)}`);
        return res.status(200).json({
          text: retry.text,
          diagnostic: `Both attempts came back mostly blank (finish reason: ${retry.finishReason || 'unknown'}). This has been logged — send this message if it keeps happening.`,
        });
      }
      text = retry.text;
    }

    // Match the shape the frontend already expects from the old provider.
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Could not process the image.' });
  }
}
