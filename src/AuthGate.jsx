import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

const inputStyle = {
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};

const CardShell = ({ children }) => (
  <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', padding: 20 }}>
    <div style={{ width: '100%', maxWidth: 380, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 32, textAlign: 'center' }}>
      {children}
    </div>
  </div>
);

const Logo = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
    <div style={{ width: 30, height: 30, background: '#0F6E56', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 14 }}>D</div>
    <div style={{ fontWeight: 800, fontSize: 16, color: '#1e293b' }}>DentaTrack</div>
  </div>
);

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'check-email'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // ── MFA (mandatory TOTP two-factor) ──────────────────────────────────
  const [mfaStep, setMfaStep] = useState('checking'); // checking | setup | verify | done
  const [factorId, setFactorId] = useState(null);
  const [challengeId, setChallengeId] = useState(null);
  const [qr, setQr] = useState(null);
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => listener.subscription.unsubscribe();
  }, []);

  // Whenever we get a session, figure out where this user stands on 2FA.
  useEffect(() => {
    if (!session) { setMfaStep('checking'); return; }
    let cancelled = false;
    (async () => {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (cancelled) return;
      if (aal?.currentLevel === 'aal2') { setMfaStep('done'); return; }

      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      const existing = factorsData?.totp?.[0];

      if (existing) {
        const { data: ch, error } = await supabase.auth.mfa.challenge({ factorId: existing.id });
        if (cancelled) return;
        if (error) { setMfaError(error.message); return; }
        setFactorId(existing.id);
        setChallengeId(ch.id);
        setMfaStep('verify');
      } else {
        const { data: enrolled, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'DentaTrack' });
        if (cancelled) return;
        if (error) { setMfaError(error.message); return; }
        const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: enrolled.id });
        if (cancelled) return;
        if (chErr) { setMfaError(chErr.message); return; }
        setFactorId(enrolled.id);
        setChallengeId(ch.id);
        setQr(enrolled.totp.qr_code);
        setSecret(enrolled.totp.secret);
        setMfaStep('setup');
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  const submitMfaCode = async (e) => {
    e.preventDefault();
    setMfaError('');
    setMfaLoading(true);
    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId, code });
    if (error) {
      setMfaError(error.message);
    } else {
      setMfaStep('done');
    }
    setMfaLoading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    if (mode === 'signup') {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { name },
          emailRedirectTo: `${window.location.origin}/verified`,
        },
      });
      if (error) setError(error.message);
      else setMode('check-email');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    }
    setLoading(false);
  };

  // Still checking for an existing session
  if (session === undefined) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', color: '#94a3b8' }}>
        Loading…
      </div>
    );
  }

  // Logged in, but still need to complete or set up 2FA before seeing the app
  if (session && mfaStep !== 'done') {
    if (mfaStep === 'checking') {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', color: '#94a3b8' }}>
          Loading…
        </div>
      );
    }
    return (
      <CardShell>
        <div style={{ textAlign: 'left' }}>
          <Logo />
          <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 4 }}>
            {mfaStep === 'setup' ? 'Set up two-factor login' : 'Enter your 6-digit code'}
          </div>
          <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 20 }}>
            {mfaStep === 'setup'
              ? 'Your account holds real bank and financial data, so we require an authenticator app for every sign-in.'
              : 'Open your authenticator app to get your current code.'}
          </div>

          {mfaStep === 'setup' && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: '#334155', marginBottom: 10 }}>
                1. Scan this with Google Authenticator, Authy, or any TOTP app:
              </div>
              {qr && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
                  <img src={qr} alt="Scan with your authenticator app" style={{ width: 180, height: 180 }} />
                </div>
              )}
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Can't scan? Enter this code manually:</div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', wordBreak: 'break-all', marginBottom: 14 }}>{secret}</div>
              <div style={{ fontSize: 13, color: '#334155', marginBottom: 10 }}>2. Enter the 6-digit code it shows:</div>
            </div>
          )}

          <form onSubmit={submitMfaCode} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              style={{ ...inputStyle, textAlign: 'center', fontSize: 20, letterSpacing: 4 }}
            />
            {mfaError && <div style={{ fontSize: 13, color: '#dc2626' }}>{mfaError}</div>}
            <button
              type="submit"
              disabled={mfaLoading || code.length !== 6}
              style={{ background: '#0F6E56', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 0', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: (mfaLoading || code.length !== 6) ? 0.6 : 1 }}
            >
              {mfaLoading ? 'Verifying…' : mfaStep === 'setup' ? 'Confirm & finish setup' : 'Verify'}
            </button>
          </form>

          <button
            onClick={() => supabase.auth.signOut()}
            style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 12, cursor: 'pointer', marginTop: 16, textAlign: 'center', width: '100%' }}
          >
            Sign out
          </button>
        </div>
      </CardShell>
    );
  }

  // Fully logged in and 2FA-verified — render the real app
  if (session && mfaStep === 'done') return children;

  // Logged out — show sign in / sign up / check-your-email
  if (mode === 'check-email') {
    return (
      <CardShell>
        <Logo />
        <div style={{ fontSize: 40, marginBottom: 12 }}>📬</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 8 }}>Check your email</div>
        <div style={{ fontSize: 14, color: '#64748b', marginBottom: 24, lineHeight: 1.5 }}>
          We sent a confirmation link to<br /><strong style={{ color: '#1e293b' }}>{email}</strong>.<br />
          Click it to verify your account.
        </div>
        <button
          onClick={() => { setMode('signin'); setError(''); }}
          style={{ background: 'none', border: 'none', color: '#0F6E56', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          Back to sign in
        </button>
      </CardShell>
    );
  }

  return (
    <CardShell>
      <div style={{ textAlign: 'left' }}>
        <Logo />

        <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 4 }}>
          {mode === 'signin' ? 'Sign in' : 'Create your account'}
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 20 }}>
          {mode === 'signin' ? 'Welcome back.' : "You're testing an early beta — thanks for trying it."}
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'signup' && (
            <input
              placeholder="Your name (e.g. Dr. Jane Smith)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            style={inputStyle}
          />

          {error && <div style={{ fontSize: 13, color: '#dc2626' }}>{error}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{ background: '#0F6E56', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 0', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginTop: 4, opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}
          style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', marginTop: 16, textAlign: 'center', width: '100%' }}
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </div>
    </CardShell>
  );
}
