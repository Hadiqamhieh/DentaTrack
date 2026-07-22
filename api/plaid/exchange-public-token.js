// After the user picks their bank and logs in inside Plaid Link, the
// frontend sends us the temporary public_token here. We exchange it for a
// permanent access_token (the real credential that can pull transactions)
// and store it server-side only — it's never sent back to the browser.

import { getPlaidClient, getUserId, getServiceClient } from './_lib.js';

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

  const { public_token, institution, accounts } = req.body || {};
  if (!public_token) {
    return res.status(400).json({ error: 'Missing public_token.' });
  }

  let plaid;
  try {
    plaid = getPlaidClient();
  } catch {
    return res.status(500).json({ error: 'Bank connections aren\'t configured on this deployment yet.' });
  }

  try {
    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;

    const db = getServiceClient();
    const { data: itemRow, error: insertError } = await db
      .from('plaid_items')
      .insert({
        user_id: userId,
        item_id,
        access_token,
        institution_id: institution?.institution_id || null,
        institution_name: institution?.name || 'Connected bank',
      })
      .select()
      .single();
    if (insertError) throw insertError;

    const connectedAccounts = (accounts || []).map((a) => ({
      id: crypto.randomUUID(),
      name: a.name,
      mask: a.mask,
      type: a.type === 'credit' ? 'credit' : 'depository',
      institution: institution?.name || 'Connected bank',
      label: a.type === 'credit' ? 'Corp credit card' : 'Corp bank',
      lastSync: null,
      connected: true,
      plaidItemId: itemRow.id,
      plaidAccountId: a.id,
    }));

    return res.status(200).json({ accounts: connectedAccounts, plaidItemId: itemRow.id });
  } catch (err) {
    const message = err?.response?.data?.error_message || err.message || 'Could not connect that bank.';
    return res.status(500).json({ error: message });
  }
}
