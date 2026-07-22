# DentaTrack — Beta

## What's in here
- `src/App.jsx` — the app, now reading/writing real data through Supabase instead of sample data
- `src/AuthGate.jsx` — sign in / sign up screen; nothing loads until a dentist is authenticated
- `src/data.js` — all the Supabase read/write functions
- `api/scan.js` — serverless function that powers receipt/daysheet scanning (optional — see below)
- `supabase/schema.sql` — already run this in your Supabase project

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
   - `ANTHROPIC_API_KEY` → optional, only needed if you want the receipt/daysheet scan feature to work in production (get one from console.anthropic.com — keep it here, server-side, never in frontend code)
4. Click **Deploy**. Vercel gives you a live URL like `dentatrack.vercel.app` — that's what you send to your beta testers.

## One thing to know about first-time signups
New accounts start completely empty — no seed practices or transactions. A dentist's first step after signing up should be **Settings → Practices → add their practice**, then they can start logging production. If that first-run gap feels confusing during testing, say so — there's an onboarding wizard already built in the code but not yet wired up to run on first login, and turning it on is a quick follow-up.

## Confirmation emails
By default, Supabase requires email confirmation before sign-in works. For a small beta this is fine, but if testers complain about it, you can turn it off in Supabase: **Authentication → Providers → Email → toggle off "Confirm email"**.
