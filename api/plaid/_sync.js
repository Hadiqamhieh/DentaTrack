// Shared by sync-transactions.js (manual "Sync now") and webhook.js
// (automatic sync triggered by Plaid). Pulls the latest transactions for a
// single Plaid Item and stores them in bank_transactions.

function toAppTransaction(t, userId, plaidItemId) {
  // Plaid's amount sign is the opposite of ours: positive = money leaving
  // the account. Our app treats positive as money coming in.
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
    plaid_item_id: plaidItemId,
  };
}

export async function syncOneItem(plaid, db, item) {
  const added = [];
  const removedIds = [];
  let cursor = item.cursor || undefined;
  let hasMore = true;

  while (hasMore) {
    const resp = await plaid.transactionsSync({ access_token: item.access_token, cursor });
    const { added: a, modified, removed, next_cursor, has_more } = resp.data;

    const upserts = [...a, ...modified].map((t) => toAppTransaction(t, item.user_id, item.id));

    // Defensive: Plaid can occasionally reissue a fresh transaction_id for
    // what's really the same transaction — most often a still-pending charge
    // being re-fetched before it settles. Our upsert only catches true
    // duplicates when the transaction_id matches exactly, so before
    // inserting, check whether a Plaid-sourced row with the same date,
    // amount, and description already exists. If so, reuse its
    // transaction_id so this becomes an update to that row instead of a
    // second copy.
    for (const u of upserts) {
      const { data: existing } = await db
        .from('bank_transactions')
        .select('plaid_transaction_id')
        .eq('user_id', u.user_id)
        .eq('date', u.date)
        .eq('amount', u.amount)
        .eq('description', u.description)
        .not('plaid_transaction_id', 'is', null)
        .neq('plaid_transaction_id', u.plaid_transaction_id)
        .limit(1)
        .maybeSingle();
      if (existing?.plaid_transaction_id) {
        u.plaid_transaction_id = existing.plaid_transaction_id;
      }
    }

    if (upserts.length > 0) {
      const { data: upserted, error } = await db
        .from('bank_transactions')
        .upsert(upserts, { onConflict: 'plaid_transaction_id' })
        .select();
      if (error) throw error;
      added.push(...upserted);
    }
    if (removed?.length) {
      const ids = removed.map((r) => r.transaction_id);
      await db.from('bank_transactions').delete().in('plaid_transaction_id', ids);
      removedIds.push(...ids);
    }

    cursor = next_cursor;
    hasMore = has_more;
  }

  const { error: cursorError } = await db.from('plaid_items').update({ cursor }).eq('id', item.id);
  if (cursorError) throw new Error(`Failed to save sync position: ${cursorError.message}`);

  return { added, removedIds };
}
