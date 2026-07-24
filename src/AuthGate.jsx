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
  const [deactivated, setDeactivated] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [reactivating, setReactivating] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => listener.subscription.unsubscribe();
  }, []);

  // Whenever a session appears, check whether this account was deactivated.
  useEffect(() => {
    if (!session) { setCheckingStatus(false); return; }
    let cancelled = false;
    setCheckingStatus(true);
    supabase.from('profiles').select('deactivated').eq('id', session.user.id).maybeSingle().then(({ data }) => {
      if (cancelled) return;
      setDeactivated(!!data?.deactivated);
      setCheckingStatus(false);
    });
    return () => { cancelled = true; };
  }, [session]);

  const reactivate = async () => {
    setReactivating(true);
    await supabase.from('profiles').update({ deactivated: false }).eq('id', session.user.id);
    setDeactivated(false);
    setReactivating(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { name },
          emailRedirectTo: `${window.location.origin}/verified`,
        },
      });
      if (error) {
        setError(error.message);
      } else if (data?.user && data.user.identities && data.user.identities.length === 0) {
        // Supabase intentionally returns a fake success here instead of an
        // error, to avoid leaking which emails are registered to an
        // attacker probing signups. An empty identities array is the
        // documented way to tell this case apart from a real new signup.
        setError('An account with this email already exists. Try signing in instead.');
      } else {
        setMode('check-email');
      }
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

  // Logged in — check deactivation status before showing anything
  if (session && checkingStatus) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', color: '#94a3b8' }}>
        Loading…
      </div>
    );
  }

  if (session && deactivated) {
    return (
      <CardShell>
        <Logo />
        <div style={{ fontSize: 40, marginBottom: 12 }}>👋</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#1e293b', marginBottom: 8 }}>Welcome back</div>
        <div style={{ fontSize: 14, color: '#64748b', marginBottom: 20, lineHeight: 1.5 }}>
          Your account is currently deactivated. Your practices, production, and expense history are all still safely here — nothing was lost. Any bank connections were disconnected when you deactivated, so you'll just need to reconnect them if you'd like.
        </div>
        <button
          onClick={reactivate}
          disabled={reactivating}
          style={{ background: '#0F6E56', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%', opacity: reactivating ? 0.7 : 1, marginBottom: 12 }}
        >
          {reactivating ? 'Reactivating…' : 'Reactivate my account'}
        </button>
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 13, cursor: 'pointer', width: '100%' }}
        >
          Sign out
        </button>
      </CardShell>
    );
  }

  // Logged in — render the real app
  if (session) return children;

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
