# DentaTrack — Beta

## What's in here
- `src/App.jsx` — the app, now reading/writing real data through Supabase instead of sample data
- `src/AuthGate.jsx` — sign in / sign up screen; nothing loads until a dentist is authenticated
- `src/data.js` — all the Supabase read/write functions
- `api/scan.js` — serverless function that powers receipt/daysheet scanning (currently disabled in the UI — see below)
- `api/plaid/` — serverless functions that power real bank connections (Plaid)
- `supabase/schema.sql` — full schema, for a brand-new Supabase project
- `supabase/migration_plaid.sql` — run this instead if you already ran schema.sql before and just need the new bank-connection tables/columns

## Local test run (optional, before deploying)
```
npm install
npm run dev
```
Opens at http://localhost:5173. Sign up with a real email — Supabase will send a confirmation link.

## Deploy to the internet

1. **Push this folder to a GitHub repo** (create a new repo on GitHub, then from this folder:
   `git init && git add . && git commit -m "beta" && git remote add origin <your repo URL> && git push -u origin main`)
2. **Go to vercel.com → New Project → import that GitHub repo.** Vercel auto-detects Vite — no config needed.
3. **Before deploying**, add environment variables in Vercel's project settings:
   - `VITE_SUPABASE_URL` → your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` → your Supabase anon public key
   - `SUPABASE_SERVICE_ROLE_KEY` → from Supabase Project Settings → API → "service_role" key. **Keep this secret** — never prefix it with `VITE_`, or it would get bundled into the browser. It's only read by the serverless functions in `api/`.
   - `ANTHROPIC_API_KEY` → optional, only needed once you re-enable the receipt/daysheet scan feature (get one from console.anthropic.com)
   - `PLAID_CLIENT_ID`, `PLAID_SECRET` → from your Plaid dashboard (dashboard.plaid.com). Start with the **Sandbox** keys — they're free and instant, no approval wait, and let you test the entire real bank-connection flow with fake test banks before applying for Production access to connect real accounts.
   - `PLAID_ENV` → `sandbox` (or `production` once you've been approved and switch to live keys)
4. Click **Deploy**. Vercel gives you a live URL like `dentatrack.vercel.app` — that's what you send to your beta testers.

## Connecting a real bank (Plaid)
This app uses Plaid Link — the same widget most fintech apps use — to search and connect any of thousands of real banks and credit unions, not a fixed list. When someone clicks "Connect your bank," they search for their institution and log in on their bank's own secure screen; DentaTrack never sees or stores their bank password. Bank access tokens are stored server-side only, in a `plaid_items` table with no client access at all — only the serverless functions in `api/plaid/` (using the Supabase service role key) can read them.

There's no webhook configured yet, so new transactions won't appear automatically — use the "🔄 Sync now" button next to Connected Accounts in Settings to pull the latest.

## One thing to know about first-time signups
New accounts start completely empty — no seed practices or transactions. A dentist's first step after signing up should be **Settings → Practices → add their practice**, then they can start logging production. If that first-run gap feels confusing during testing, say so — there's an onboarding wizard already built in the code but not yet wired up to run on first login, and turning it on is a quick follow-up.

## Confirmation emails
By default, Supabase requires email confirmation before sign-in works. For a small beta this is fine, but if testers complain about it, you can turn it off in Supabase: **Authentication → Providers → Email → toggle off "Confirm email"**.
