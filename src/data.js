import { supabase } from './supabaseClient';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const newId = () => crypto.randomUUID();

// Any row whose id isn't already a real UUID (e.g. leftover demo data using
// simple numbers) gets a fresh one before it's ever sent to Supabase, since
// the id columns are typed uuid.
export function normalizeIds(rows) {
  let changed = false;
  const out = rows.map((r) => {
    if (isUuid(r.id)) return r;
    changed = true;
    return { ...r, id: newId() };
  });
  return { rows: out, changed };
}

// Upserts every row currently in local state, then deletes any row still in
// the database for this user that's no longer present locally (covers
// deletes made in the UI). Simple full-sync approach — fine at beta scale.
async function replaceAll(table, userId, rows) {
  if (rows.length > 0) {
    const { error } = await supabase.from(table).upsert(rows);
    if (error) console.error(`${table} upsert failed:`, error.message);
  }
  let del = supabase.from(table).delete().eq('user_id', userId);
  if (rows.length > 0) {
    del = del.not('id', 'in', `(${rows.map((r) => r.id).join(',')})`);
  }
  const { error } = await del;
  if (error) console.error(`${table} cleanup failed:`, error.message);
}

// ── Profile / agreement (single row per user) ───────────────────────
export async function loadProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    name: data.name || '',
    corpName: data.corp_name || '',
    isCorp: data.is_corp || false,
    salary: data.salary || 0,
    dividends: data.dividends || 0,
    province: data.province || '',
    licenseNumber: data.license_number || '',
    school: data.school || '',
    graduatingYear: data.graduating_year || '',
    tourCompleted: data.tour_completed ?? true,
  };
}

export async function saveProfile(userId, agreement) {
  const { error } = await supabase.from('profiles').upsert({
    id: userId,
    name: agreement.name,
    corp_name: agreement.corpName,
    is_corp: agreement.isCorp,
    salary: agreement.salary,
    dividends: agreement.dividends,
    province: agreement.province || null,
    license_number: agreement.licenseNumber || null,
    school: agreement.school || null,
    graduating_year: agreement.graduatingYear || null,
    tour_completed: agreement.tourCompleted ?? true,
  });
  if (error) console.error('profile save failed:', error.message);
}

// ── Practices ────────────────────────────────────────────────────────
export async function loadPractices(userId) {
  const { data, error } = await supabase.from('practices').select('*').eq('user_id', userId);
  if (error) throw error;
  return data.map((p) => ({
    id: p.id, name: p.name, address: p.address, city: p.city, province: p.province,
    postalCode: p.postal_code, pct: p.pct, basis: p.basis, deductsLabFees: p.deducts_lab_fees,
    guarantee: p.guarantee, color: p.color,
  }));
}

export async function syncPractices(userId, practices) {
  const rows = practices.map((p) => ({
    id: p.id, user_id: userId, name: p.name, address: p.address, city: p.city, province: p.province,
    postal_code: p.postalCode, pct: p.pct, basis: p.basis, deducts_lab_fees: p.deductsLabFees,
    guarantee: p.guarantee, color: p.color,
  }));
  await replaceAll('practices', userId, rows);
}

// ── Production ───────────────────────────────────────────────────────
export async function loadProduction(userId) {
  const { data, error } = await supabase.from('production').select('*').eq('user_id', userId);
  if (error) throw error;
  return data.map((r) => ({
    id: r.id, date: r.date, production: Number(r.production), labFees: Number(r.lab_fees),
    source: r.source, practiceId: r.practice_id,
  }));
}

export async function syncProduction(userId, production) {
  const rows = production.map((r) => ({
    id: r.id, user_id: userId, date: r.date, production: r.production, lab_fees: r.labFees,
    source: r.source, practice_id: r.practiceId,
  }));
  await replaceAll('production', userId, rows);
}

// ── Expenses ─────────────────────────────────────────────────────────
export async function loadExpenses(userId) {
  const { data, error } = await supabase.from('expenses').select('*').eq('user_id', userId);
  if (error) throw error;
  return data.map((e) => ({
    id: e.id, date: e.date, vendor: e.vendor, category: e.category, amount: Number(e.amount),
    taxDeductible: e.tax_deductible, corpExpense: e.corp_expense, receipt: e.receipt,
  }));
}

export async function syncExpenses(userId, expenses) {
  const rows = expenses.map((e) => ({
    id: e.id, user_id: userId, date: e.date, vendor: e.vendor, category: e.category, amount: e.amount,
    tax_deductible: e.taxDeductible, corp_expense: e.corpExpense, receipt: e.receipt,
  }));
  await replaceAll('expenses', userId, rows);
}

// ── Bank transactions ────────────────────────────────────────────────
export async function loadBanks(userId) {
  const { data, error } = await supabase.from('bank_transactions').select('*').eq('user_id', userId);
  if (error) throw error;
  return data.map((b) => ({
    id: b.id, date: b.date, description: b.description, amount: Number(b.amount), type: b.type,
    reviewed: b.reviewed, practiceId: b.practice_id, userTagged: b.user_tagged, autoTagged: b.auto_tagged,
    matchedRule: b.matched_rule, category: b.category, taxDeductible: b.tax_deductible,
    deductibleFraction: b.deductible_fraction, corpExpense: b.corp_expense, receipt: b.receipt,
    notes: b.notes, manual: b.manual, plaidTransactionId: b.plaid_transaction_id, plaidItemId: b.plaid_item_id,
    plaidAccountId: b.plaid_account_id, splits: b.splits,
  }));
}

export async function syncBanks(userId, banks) {
  const rows = banks.map((b) => ({
    id: b.id, user_id: userId, date: b.date, description: b.description, amount: b.amount, type: b.type,
    reviewed: b.reviewed, practice_id: b.practiceId, user_tagged: b.userTagged, auto_tagged: b.autoTagged,
    matched_rule: isUuid(b.matchedRule) ? b.matchedRule : null, category: b.category,
    tax_deductible: b.taxDeductible, deductible_fraction: b.deductibleFraction,
    corp_expense: b.corpExpense, receipt: b.receipt, notes: b.notes, manual: b.manual || false,
    plaid_transaction_id: b.plaidTransactionId || null, plaid_item_id: b.plaidItemId || null,
    plaid_account_id: b.plaidAccountId || null, splits: b.splits || null,
  }));
  await replaceAll('bank_transactions', userId, rows);
}

// ── Bank rules ───────────────────────────────────────────────────────
export async function loadBankRules(userId) {
  const { data, error } = await supabase.from('bank_rules').select('*').eq('user_id', userId);
  if (error) throw error;
  return data.map((r) => ({
    id: r.id, matchText: r.match_text, matchType: r.match_type, type: r.type, practiceId: r.practice_id,
    category: r.category, taxDeductible: r.tax_deductible, deductibleFraction: r.deductible_fraction,
    corpExpense: r.corp_expense, appliedCount: r.applied_count, createdFrom: r.created_from,
  }));
}

export async function syncBankRules(userId, rules) {
  const rows = rules.map((r) => ({
    id: r.id, user_id: userId, match_text: r.matchText, match_type: r.matchType, type: r.type,
    practice_id: r.practiceId, category: r.category, tax_deductible: r.taxDeductible,
    deductible_fraction: r.deductibleFraction, corp_expense: r.corpExpense,
    applied_count: r.appliedCount, created_from: r.createdFrom,
  }));
  await replaceAll('bank_rules', userId, rows);
}

// ── Connected accounts ───────────────────────────────────────────────
export async function loadConnectedAccounts(userId) {
  const { data, error } = await supabase.from('connected_accounts').select('*').eq('user_id', userId);
  if (error) throw error;
  return data.map((a) => ({
    id: a.id, name: a.name, mask: a.mask, type: a.type, institution: a.institution,
    label: a.label, lastSync: a.last_sync, connected: a.connected,
    plaidItemId: a.plaid_item_id, plaidAccountId: a.plaid_account_id,
  }));
}

export async function syncConnectedAccounts(userId, accounts) {
  const rows = accounts.map((a) => ({
    id: a.id, user_id: userId, name: a.name, mask: a.mask, type: a.type, institution: a.institution,
    label: a.label, last_sync: a.lastSync, connected: a.connected,
    plaid_item_id: a.plaidItemId || null, plaid_account_id: a.plaidAccountId || null,
  }));
  await replaceAll('connected_accounts', userId, rows);
}
