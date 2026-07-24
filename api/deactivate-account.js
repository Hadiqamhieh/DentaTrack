// Deactivating an account revokes every connected bank with Plaid and
// deletes the transaction data tied to those connections (the cascade
// delete on plaid_items handles bank_transactions and connected_accounts
// automatically — see migration_cascade_delete.sql). Everything the dentist
// entered by hand — practices, production, manual expenses — is left alone,
// so reactivating is simple and nothing they typed in is lost.

import { getPlaidClient, getUserId, getServiceClient } from './plaid/_lib.js';

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

  const db = getServiceClient();

  const { data: items } = await db.from('plaid_items').select('*').eq('user_id', userId);
  if (items?.length) {
    let plaid;
    try { plaid = getPlaidClient(); } catch { plaid = null; }
    for (const item of items) {
      if (plaid) {
        await plaid.itemRemove({ access_token: item.access_token }).catch(() => {});
      }
      await db.from('plaid_items').delete().eq('id', item.id);
    }
  }

  const { error } = await db.from('profiles').update({ deactivated: true }).eq('id', userId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ success: true });
}
