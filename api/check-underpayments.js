// Runs once a day (see vercel.json) and checks every dentist's practices
// for a collection rate below 70% — the exact same threshold the Home tab
// already uses to show its ⚠️ warning icon, just run proactively here so
// nobody has to remember to open the app and notice it themselves.
//
// Protected by Vercel's own CRON_SECRET (auto-provisioned, no setup
// needed) so this can't be triggered by anyone hitting the URL directly.

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

function getServiceClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_NOT_CONFIGURED');
  return createClient(url, serviceKey);
}

const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = getServiceClient();
  const results = { checked: 0, alerted: 0, errors: [] };

  try {
    // Every user who has at least one practice set up is worth checking.
    const { data: practices, error: prErr } = await db.from('practices').select('*');
    if (prErr) throw prErr;
    if (!practices?.length) return res.status(200).json(results);

    const userIds = [...new Set(practices.map((p) => p.user_id))];

    for (const userId of userIds) {
      try {
        const userPractices = practices.filter((p) => p.user_id === userId);

        const [{ data: production }, { data: banks }] = await Promise.all([
          db.from('production').select('*').eq('user_id', userId),
          db.from('bank_transactions').select('*').eq('user_id', userId),
        ]);

        for (const pr of userPractices) {
          results.checked++;
          const prDeposits = (banks || [])
            .filter((b) => b.type === 'collection' && b.practice_id === pr.id)
            .reduce((s, b) => s + Number(b.amount), 0);
          const prProd = (production || [])
            .filter((r) => r.practice_id === pr.id)
            .reduce((s, r) => s + Number(r.production), 0);
          const rate = prProd > 0 ? (prDeposits / prProd) * 100 : null;

          if (rate === null || rate >= 70) continue;

          // Skip if we already alerted on this practice in the last 7 days.
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data: recent } = await db
            .from('underpayment_alerts')
            .select('id')
            .eq('user_id', userId)
            .eq('practice_id', pr.id)
            .gte('alerted_at', weekAgo)
            .limit(1);
          if (recent?.length) continue;

          const { data: userData } = await db.auth.admin.getUserById(userId);
          const email = userData?.user?.email;
          if (!email || !process.env.RESEND_API_KEY) continue;

          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: process.env.RESEND_FROM || 'DentaTrack <onboarding@resend.dev>',
            to: [email],
            subject: `Heads up — ${pr.name}'s collection rate looks low`,
            text: `Your deposits from ${pr.name} are tracking at ${rate.toFixed(0)}% of your logged production — below the 70% that usually signals everything's been paid out correctly.\n\nProduction: ${fmt(prProd)}\nDeposits: ${fmt(prDeposits)}\n\nThis can be normal if recent production hasn't been paid out yet, but it's worth a look. Open DentaTrack to review, or request a collections statement from the practice.\n\n— DentaTrack`,
          });

          await db.from('underpayment_alerts').insert({ user_id: userId, practice_id: pr.id, rate });
          results.alerted++;
        }
      } catch (err) {
        results.errors.push({ userId, message: err.message });
      }
    }

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
