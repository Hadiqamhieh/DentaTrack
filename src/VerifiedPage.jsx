import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

// Confirmation emails link here with ?token_hash=...&type=signup instead of
// straight to Supabase's own confirm endpoint. That matters: if the link
// itself verified the token, an email client or security scanner silently
// pre-visiting the link (very common) would burn the one-time token before
// the person ever clicks it themselves, and they'd hit "expired" every time.
// Verifying here, from our own page's JS, means only a real click runs it.
export default function VerifiedPage() {
  const [status, setStatus] = useState('checking'); // checking | success | error
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token_hash = params.get('token_hash');
    const type = params.get('type') || 'signup';

    if (!token_hash) {
      setStatus('error');
      setError('This link is missing some information — try signing up again for a fresh email.');
      return;
    }

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
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 380, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 32, textAlign: 'center' }}>
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
            <div style={{ fontSize: 14, color: '#64748b', lineHeight: 1.5 }}>{error}</div>
          </>
        )}
      </div>
    </div>
  );
}
