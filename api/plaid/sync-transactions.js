// Pulls the latest transactions for every bank the signed-in dentist has
// connected via Plaid, and stores them in bank_transactions. Called right
// after connecting a new bank, and again whenever the user hits "Sync now".

import { getPlaidClient, getUserId, getServiceClient } from './_lib.js';

// Plaid's amount sign is the opposite of ours: positive = money leaving the
// account. Our app treats positive as money coming in (a collection/deposit).
function toAppTransaction(t, userId) {
  const amount = -t.amount;
  return {
    user_id: userId,
    date: t.date,
    description: t.merchant_name || t.name || 'Transaction',
    amount,
    type: amount > 0 ? 'collection' : 'review',
    reviewed: false,
    user_tagged: false,
    auto_tagged: false,
    manual: false,
    plaid_transaction_id: t.transaction_id,
  };
}

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
      let cursor = item.cursor || undefined;
      let hasMore = true;
      while (hasMore) {
        const resp = await plaid.transactionsSync({
          access_token: item.access_token,
          cursor,
        });
        const { added, modified, removed, next_cursor, has_more } = resp.data;

        const upserts = [...added, ...modified].map((t) => toAppTransaction(t, userId));
        if (upserts.length > 0) {
          const { data: upserted, error: upsertError } = await db
            .from('bank_transactions')
            .upsert(upserts, { onConflict: 'plaid_transaction_id' })
            .select();
          if (upsertError) throw upsertError;
          allAdded.push(...upserted);
        }
        if (removed?.length) {
          const ids = removed.map((r) => r.transaction_id);
          await db.from('bank_transactions').delete().in('plaid_transaction_id', ids);
          allRemovedIds.push(...ids);
        }

        cursor = next_cursor;
        hasMore = has_more;
      }
      await db.from('plaid_items').update({ cursor }).eq('id', item.id);
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
    notes: b.notes, manual: b.manual,
  }));

  return res.status(200).json({ added: mapped, removedIds: allRemovedIds, itemErrors });
}
