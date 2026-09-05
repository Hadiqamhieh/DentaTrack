// Powers receipt and day-sheet scanning. Tries a short list of free vision
// models on OpenRouter first, then falls back to Gemini if all of them are
// rate-limited, errored, or came back empty. Both are free tiers with no
// credit card required.
//
// OpenRouter's free-model lineup rotates without warning — one hardcoded
// model name already vanished from their catalog in production, which is
// exactly why this tries several in order instead of pinning one. Override
// with OPENROUTER_MODELS (comma-separated, tried in order) if this list
// goes stale again; check current free models at
// https://openrouter.ai/api/v1/models (no auth required) before picking new
// ones — filter for entries ending in ":free" with "image" in
// architecture.input_modalities.
//
// If OPENROUTER_API_KEY isn't set yet, this skips straight to Gemini —
// today's exact behavior — so it's safe to deploy before that env var
// exists.
//
// Kept to the exact same request/response shape the frontend already
// expects ({ imageBase64, mimeType, prompt } -> { text }) so ScanModal and
// ReceiptScanner didn't need any changes at all.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || 'google/gemma-4-31b-it:free,minimax/minimax-m3:free')
  .split(',').map(m => m.trim()).filter(Boolean);

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
      ? "Gemini is briefly at its free-tier limit."
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

// OpenRouter's OpenAI-compatible chat completions endpoint.
async function callOpenRouter(apiKey, model, { imageBase64, mimeType, prompt }, label) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } },
        ],
      }],
    }),
  });
  const data = await resp.json();

  console.log(`[scan:${label}] status=${resp.status} finishReason=${data?.choices?.[0]?.finish_reason} error=${data?.error?.message || ''}`);

  if (!resp.ok) {
    const message = resp.status === 429
      ? "OpenRouter is briefly at its free-tier limit."
      : (data?.error?.message || 'Could not reach the scanning service.');
    const err = new Error(message);
    err.status = resp.status >= 400 && resp.status < 600 ? resp.status : 500;
    throw err;
  }

  const finishReason = data?.choices?.[0]?.finish_reason;
  const text = data?.choices?.[0]?.message?.content;

  if (!text) {
    const err = new Error(finishReason ? `No result came back (reason: ${finishReason}).` : 'No result came back — try a clearer photo.');
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

// Two attempts against one provider before giving up on it — same
// retry-on-empty-result pattern regardless of which provider is calling in.
async function attemptWithRetry(callFn, apiKey, args, providerLabel) {
  const first = await callFn(apiKey, args, `${providerLabel}-attempt-1`);
  if (!looksEmpty(first.text)) return { ...first, stillEmpty: false };

  console.log(`[scan:${providerLabel}] attempt-1 looked empty (finishReason=${first.finishReason}), retrying`);
  const retry = await callFn(apiKey, args, `${providerLabel}-attempt-2`);
  return { ...retry, stillEmpty: looksEmpty(retry.text) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!openRouterKey && !geminiKey) {
    return res.status(500).json({ error: "Scanning is not configured on this deployment yet." });
  }

  const { imageBase64, mimeType, prompt } = req.body || {};
  if (!imageBase64 || !prompt) {
    return res.status(400).json({ error: 'Missing image or prompt.' });
  }
  const args = { imageBase64, mimeType, prompt };

  if (openRouterKey) {
    // One attempt per candidate model rather than a full retry-per-model —
    // several free models rotating in and out is common enough that trying
    // each once and moving on beats burning the daily quota retrying a model
    // that's simply gone.
    for (const model of OPENROUTER_MODELS) {
      try {
        const result = await callOpenRouter(openRouterKey, model, args, `openrouter:${model}`);
        if (!looksEmpty(result.text)) {
          console.log(`[scan] served by openrouter (${model})`);
          return res.status(200).json({ text: result.text });
        }
        console.log(`[scan] openrouter (${model}) came back empty, trying next option`);
      } catch (err) {
        console.log(`[scan] openrouter (${model}) failed (${err.message}), trying next option`);
      }
    }
    console.log(`[scan] all openrouter models exhausted, falling back${geminiKey ? ' to gemini' : ' — no gemini key configured'}`);
  }

  if (!geminiKey) {
    // OpenRouter was tried and exhausted or failed, and there's no fallback configured.
    return res.status(500).json({ error: 'Scanning is temporarily unavailable — try again in a bit.' });
  }

  try {
    const result = await attemptWithRetry(callGemini, geminiKey, args, 'gemini');
    console.log(`[scan] served by gemini${openRouterKey ? ' (fallback)' : ''}`);
    if (result.stillEmpty) {
      return res.status(200).json({
        text: result.text,
        diagnostic: `Both attempts came back mostly blank (finish reason: ${result.finishReason || 'unknown'}). This has been logged — send this message if it keeps happening.`,
      });
    }
    return res.status(200).json({ text: result.text });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Could not process the image.' });
  }
}
