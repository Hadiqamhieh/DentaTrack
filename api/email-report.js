// Generates a P&L summary PDF from the numbers the app already computed on
// the Home tab, and emails it via Resend. The financial figures themselves
// are trusted from the signed-in user's own request (same math the app
// already shows them on screen) — this endpoint's job is just turning that
// into a PDF and delivering it.

import PDFDocument from 'pdfkit';
import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

async function getUserId(req) {
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

const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function buildPdf({ corpName, period, expectedPay, totalExp, net, practiceBreakdown, expenseByCategory }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#0F6E56').text(corpName || 'DentaTrack P&L Summary', { align: 'left' });
    doc.fontSize(11).fillColor('#64748b').text(period, { align: 'left' });
    doc.moveDown(1.2);

    doc.fontSize(13).fillColor('#1e293b').text('Summary');
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#334155');
    doc.text(`Expected pay:  ${fmt(expectedPay)}`);
    doc.text(`Expenses:      ${fmt(totalExp)}`);
    doc.fontSize(12).fillColor('#0F6E56').text(`Net:           ${fmt(net)}`);
    doc.moveDown(1);

    if (practiceBreakdown?.length) {
      doc.fontSize(13).fillColor('#1e293b').text('By practice');
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#334155');
      practiceBreakdown.forEach((p) => {
        doc.text(`${p.name} — deposits ${fmt(p.deposits)}${p.labFees ? `, lab fees ${fmt(p.labFees)}` : ''}, pay ${fmt(p.pay)}`);
      });
      doc.moveDown(1);
    }

    const categories = Object.entries(expenseByCategory || {});
    if (categories.length) {
      doc.fontSize(13).fillColor('#1e293b').text('Expenses by category');
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#334155');
      categories.sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
        doc.text(`${cat}: ${fmt(amt)}`);
      });
    }

    doc.moveDown(1.5);
    doc.fontSize(9).fillColor('#94a3b8').text('Estimates based on information entered in DentaTrack. Not tax or financial advice — consult a qualified accountant.');

    doc.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let user;
  try {
    user = await getUserId(req);
  } catch {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const { to, corpName, period, expectedPay, totalExp, net, practiceBreakdown, expenseByCategory } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Missing recipient email.' });

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: "Email sending isn't configured on this deployment yet." });
  }

  try {
    const pdfBuffer = await buildPdf({ corpName, period, expectedPay, totalExp, net, practiceBreakdown, expenseByCategory });
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM || 'DentaTrack <onboarding@resend.dev>',
      to: [to],
      subject: `P&L Summary — ${period}`,
      text: `Attached is your P&L summary for ${period}.\n\nExpected pay: ${fmt(expectedPay)}\nExpenses: ${fmt(totalExp)}\nNet: ${fmt(net)}`,
      attachments: [{ filename: `pnl-${period.replace(/\s+/g, '-').toLowerCase()}.pdf`, content: pdfBuffer.toString('base64') }],
    });
    if (error) throw new Error(error.message || 'Resend rejected the request.');
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not send the report.' });
  }
}
