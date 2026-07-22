// Shared helpers for the Plaid serverless functions.
// Nothing in this file ever runs in the browser — it's server-only code.

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createClient } from '@supabase/supabase-js';

export function getPlaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || 'sandbox';
  if (!clientId || !secret) {
    throw new Error('PLAID_NOT_CONFIGURED');
  }
  const configuration = new Configuration({
    basePath: PlaidEnvironments[env] || PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });
  return new PlaidApi(configuration);
}

// Verifies the Supabase access token sent by the browser and returns the
// authenticated user's id. Throws if missing/invalid — callers should catch
// and respond 401.
export async function getUserId(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('NO_AUTH_TOKEN');

  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error('INVALID_AUTH_TOKEN');
  return data.user.id;
}

// A Supabase client using the SERVICE ROLE key — bypasses RLS entirely.
// Only ever used server-side, and every query below still explicitly
// filters by user_id as defense in depth.
export function getServiceClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_NOT_CONFIGURED');
  return createClient(url, serviceKey);
}
