// Powers receipt and day-sheet scanning. Uses Google's Gemini API (free
// tier — no credit card required) instead of a paid API, since this
// beta doesn't have scanning volume that needs anything more yet.
//
// Kept to the exact same request/response shape the frontend already
// expects ({ imageBase64, mimeType, prompt } -> { text }) so ScanModal and
// ReceiptScanner didn't need any changes at all.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

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
        },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      const message = data?.error?.message || 'Could not reach the scanning service.';
      return res.status(resp.status >= 400 && resp.status < 600 ? resp.status : 500).json({ error: message });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const blockReason = data?.promptFeedback?.blockReason;
      return res.status(500).json({ error: blockReason ? `Image couldn't be processed (${blockReason}).` : 'No result came back — try a clearer photo.' });
    }

    // Match the shape the frontend already expects from the old provider.
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not process the image.' });
  }
}
