// Pulls the latest transactions for every bank the signed-in dentist has
// connected via Plaid, and stores them in bank_transactions. Called when
// the user hits "Sync now" (Plaid's webhook handles this automatically for
// new activity — this endpoint is the manual fallback / on-demand catch-up).

import { getPlaidClient, getUserId, getServiceClient } from './_lib.js';
import { syncOneItem } from './_sync.js';

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

  const db = getServiceClient();
  const { data: items, error: itemsError } = await db
    .from('plaid_items')
    .select('*')
    .eq('user_id', userId);
  if (itemsError) return res.status(500).json({ error: itemsError.message });
  if (!items || items.length === 0) {
    return res.status(200).json({ added: [], removedIds: [] });
  }

  const allAdded = [];
  const allRemovedIds = [];
  const itemErrors = [];

  for (const item of items) {
    try {
      const { added, removedIds } = await syncOneItem(plaid, db, item);
      allAdded.push(...added);
      allRemovedIds.push(...removedIds);
    } catch (err) {
      // Don't let one broken connection (e.g. a stale Sandbox item left over
      // from testing) block syncing for every other connected bank.
      const message = err?.response?.data?.error_message || err.message || 'Could not sync this connection.';
      itemErrors.push({ institution: item.institution_name || 'a bank', message });
    }
  }

  const mapped = allAdded.map((b) => ({
    id: b.id, date: b.date, description: b.description, amount: Number(b.amount), type: b.type,
    reviewed: b.reviewed, practiceId: b.practice_id, userTagged: b.user_tagged, autoTagged: b.auto_tagged,
    matchedRule: b.matched_rule, category: b.category, taxDeductible: b.tax_deductible,
    deductibleFraction: b.deductible_fraction, corpExpense: b.corp_expense, receipt: b.receipt,
    notes: b.notes, manual: b.manual, plaidItemId: b.plaid_item_id,
  }));

  return res.status(200).json({ added: mapped, removedIds: allRemovedIds, itemErrors });
}
