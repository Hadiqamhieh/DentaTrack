// Sends in-app feedback straight to an email inbox via Resend. This is the
// "someone can actually tell us something broke, from inside the app,
// right now" channel that didn't exist before — previously the only way a
// bug ever surfaced was Hadi finding it himself.

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

async function getUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('NO_AUTH_TOKEN');
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error('INVALID_AUTH_TOKEN');
  return data.user;
}

const TYPE_LABELS = { bug: "🐞 Something's broken", idea: '💡 Feature idea', other: '💬 Something else' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let user;
  try {
    user = await getUser(req);
  } catch {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const { type, message, page } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Feedback message is empty.' });
  }

  const to = process.env.FEEDBACK_TO_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: "Feedback isn't configured on this deployment yet." });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM || 'DentaTrack <onboarding@resend.dev>',
      to: [to],
      subject: `DentaTrack feedback: ${TYPE_LABELS[type] || type || 'Feedback'}`,
      text: `From: ${user.email}\nPage: ${page || 'unknown'}\nType: ${TYPE_LABELS[type] || type || 'other'}\n\n${message}`,
      replyTo: user.email,
    });
    if (error) throw new Error(error.message || 'Resend rejected the request.');
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not send feedback.' });
  }
}
