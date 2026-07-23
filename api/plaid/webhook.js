// Plaid calls this URL automatically whenever something changes on a
// connected bank (a new transaction, a pending charge posting, etc.) — this
// is what makes the feed update itself instead of needing "Sync now".
//
// Signature verification follows Plaid's documented method exactly:
// https://plaid.com/docs/api/webhooks/webhook-verification/
// We deliberately do NOT skip this step — an unverified webhook endpoint
// would let anyone POST fake "new transaction" events for any item_id.

import { jwtDecode } from 'jwt-decode';
import * as jose from 'jose';
import crypto from 'crypto';
import { getPlaidClient, getServiceClient } from './_lib.js';
import { syncOneItem } from './_sync.js';

// Vercel parses JSON bodies by default, which loses the exact raw bytes we
// need for hash verification — so we turn that off and read the raw body
// ourselves.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Cached per warm serverless instance — cheap win, and the key rarely rotates.
let cachedKey = null;
let cachedKeyId = null;

async function verifyWebhook(rawBody, signedJwt, plaid) {
  if (!signedJwt) return false;

  const header = jwtDecode(signedJwt, { header: true });
  if (header.alg !== 'ES256') return false;

  if (!cachedKey || cachedKeyId !== header.kid) {
    const response = await plaid.webhookVerificationKeyGet({ key_id: header.kid });
    cachedKey = response.data.key;
    cachedKeyId = header.kid;
  }
  if (!cachedKey) return false;

  let payload;
  try {
    const keyLike = await jose.importJWK(cachedKey, 'ES256');
    ({ payload } = await jose.jwtVerify(signedJwt, keyLike, { maxTokenAge: '5 min' }));
  } catch {
    return false; // bad signature, or older than 5 minutes (anti-replay)
  }

  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const claimed = payload.request_body_sha256 || '';
  if (bodyHash.length !== claimed.length) return false;
  return crypto.timingSafeEqual(Buffer.from(bodyHash), Buffer.from(claimed));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  let plaid;
  try {
    plaid = getPlaidClient();
  } catch {
    return res.status(200).json({ received: true }); // not configured — ack quietly
  }

  const verified = await verifyWebhook(rawBody, req.headers['plaid-verification'], plaid).catch(() => false);
  if (!verified) {
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  const { webhook_type, webhook_code, item_id } = payload;

  // Always acknowledge quickly so Plaid doesn't retry — but still try the
  // actual sync, and don't let a failure here surface as a webhook error.
  try {
    const transactionCodes = ['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'];
    if (webhook_type === 'TRANSACTIONS' && transactionCodes.includes(webhook_code)) {
      const db = getServiceClient();
      const { data: item } = await db.from('plaid_items').select('*').eq('item_id', item_id).maybeSingle();
      if (item) await syncOneItem(plaid, db, item);
    }
  } catch {
    // Swallow — Plaid will retry on its own schedule if needed; the next
    // manual "Sync now" will also pick up anything missed here.
  }

  return res.status(200).json({ received: true });
}
