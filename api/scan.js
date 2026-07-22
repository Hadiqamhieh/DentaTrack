// Vercel serverless function. Keeps the Anthropic API key server-side —
// the browser only ever talks to /api/scan, never to api.anthropic.com directly.
// Requires an ANTHROPIC_API_KEY environment variable set in the Vercel project.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Scanning is not configured on this deployment yet.' });
  }

  const { imageBase64, mimeType, prompt } = req.body || {};
  if (!imageBase64 || !prompt) {
    return res.status(400).json({ error: 'Missing image or prompt.' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data?.error?.message || 'Upstream error' });
    }
    const text = (data.content || []).map((c) => c.text || '').join('');
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'Scan request failed.' });
  }
}
