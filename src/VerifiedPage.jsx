import { useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function VerifiedPage() {
  useEffect(() => {
    // This tab shouldn't stay silently signed in — send the person back to
    // sign in properly (with 2FA setup) from where they started.
    supabase.auth.signOut().catch(() => {});
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 380, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 14 }}>✅</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 8 }}>You're verified!</div>
        <div style={{ fontSize: 14, color: '#64748b', lineHeight: 1.5 }}>
          Your email is confirmed and your account is ready.<br />
          You can close this tab and sign in from where you started.
        </div>
      </div>
    </div>
  );
}
