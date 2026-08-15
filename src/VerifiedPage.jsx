import { useState } from 'react';
import { supabase } from './supabaseClient';

// Confirmation emails link here with ?token_hash=...&type=signup instead of
// straight to Supabase's own confirm endpoint.
//
// IMPORTANT: verification only happens on an explicit button click, never
// automatically on page load. Email providers and corporate security tools
// (Gmail's link scanning, Outlook Safe Links, Mimecast, etc.) commonly
// pre-visit links in emails using a real browser to check they're safe —
// and critically, many of these run the page's JavaScript too, not just
// the network request. An effect that verifies on mount would get silently
// triggered by that scan, burning the one-time token before the person
// ever clicks it — they'd land on "link didn't work" even though the
// account was already (invisibly) verified. Scanners load and inspect
// pages; they essentially never click buttons. Gating verification behind
// a real click is what actually tells a person apart from a scanner.
export default function VerifiedPage() {
  const [status, setStatus] = useState('ready'); // ready | checking | success | error
  const [error, setError] = useState('');

  const params = new URLSearchParams(window.location.search);
  const token_hash = params.get('token_hash');
  const type = params.get('type') || 'signup';

  const confirm = () => {
    if (!token_hash) {
      setStatus('error');
      setError('This link is missing some information — try signing up again for a fresh email.');
      return;
    }
    setStatus('checking');
    supabase.auth.verifyOtp({ token_hash, type }).then(({ error }) => {
      if (error) {
        setStatus('error');
        setError(error.message);
      } else {
        setStatus('success');
        // Don't leave this tab silently signed in — the person should sign
        // in properly from where they started.
        supabase.auth.signOut().catch(() => {});
      }
    });
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 380, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 32, textAlign: 'center' }}>
        {status === 'ready' && (
          <>
            <div style={{ fontSize: 44, marginBottom: 14 }}>📬</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 8 }}>Confirm your account</div>
            <div style={{ fontSize: 14, color: '#64748b', lineHeight: 1.5, marginBottom: 22 }}>
              Tap below to verify your email and finish setting up your account.
            </div>
            <button
              onClick={confirm}
              style={{ width: '100%', padding: '12px 0', background: '#0F6E56', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}
            >
              Confirm my account
            </button>
          </>
        )}
        {status === 'checking' && (
          <div style={{ fontSize: 14, color: '#94a3b8' }}>Verifying…</div>
        )}
        {status === 'success' && (
          <>
            <div style={{ fontSize: 44, marginBottom: 14 }}>✅</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 8 }}>You're verified!</div>
            <div style={{ fontSize: 14, color: '#64748b', lineHeight: 1.5 }}>
              Your email is confirmed and your account is ready.<br />
              You can close this tab and sign in from where you started.
            </div>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={{ fontSize: 44, marginBottom: 14 }}>⚠️</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 8 }}>Link didn't work</div>
            <div style={{ fontSize: 14, color: '#64748b', lineHeight: 1.5, marginBottom: 18 }}>{error}</div>
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' }}>
              This can happen if your email provider's security scanner already opened the link on its own before you clicked it — in that case your account may actually already be verified. Try going back and signing in before requesting a new email.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
