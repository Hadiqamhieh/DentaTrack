// Creates a short-lived link_token that the browser uses to open Plaid's
// real hosted bank-search-and-login widget. No bank credentials ever touch
// our server or our frontend — Plaid Link handles that directly.

import { getPlaidClient, getUserId } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let userId;
  try {
    userId = await getUserId(req);
  } catch {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  let plaid;
  try {
    plaid = getPlaidClient();
  } catch {
    return res.status(500).json({ error: 'Bank connections aren\'t configured on this deployment yet.' });
  }

  try {
    const appUrl = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'DentaTrack',
      products: ['transactions'],
      country_codes: ['US', 'CA'],
      language: 'en',
      ...(appUrl ? { webhook: `${appUrl}/api/plaid/webhook` } : {}),
    });
    return res.status(200).json({ link_token: response.data.link_token });
  } catch (err) {
    const message = err?.response?.data?.error_message || 'Could not start the bank connection.';
    return res.status(500).json({ error: message });
  }
}
