// Properly disconnects a bank: revokes it with Plaid AND deletes our stored
// access token, instead of just hiding it from the UI. Deleting the
// plaid_items row cascades to connected_accounts automatically (see the
// foreign key in the schema), so both clean up together.

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

  const { plaidItemId } = req.body || {};
  if (!plaidItemId) return res.status(400).json({ error: 'Missing plaidItemId.' });

  const db = getServiceClient();
  const { data: item, error: findError } = await db
    .from('plaid_items')
    .select('*')
    .eq('id', plaidItemId)
    .eq('user_id', userId) // never let someone remove another user's item
    .maybeSingle();
  if (findError) return res.status(500).json({ error: findError.message });
  if (!item) return res.status(404).json({ error: 'Connection not found.' });

  try {
    const plaid = getPlaidClient();
    await plaid.itemRemove({ access_token: item.access_token }).catch(() => {
      // If Plaid already considers it gone, that's fine — still clean up our side.
    });
  } catch {
    // Plaid not configured, or already-revoked token — still proceed to
    // remove our own record so it stops being used for syncing.
  }

  const { error: deleteError } = await db.from('plaid_items').delete().eq('id', plaidItemId);
  if (deleteError) return res.status(500).json({ error: deleteError.message });

  return res.status(200).json({ success: true });
}
