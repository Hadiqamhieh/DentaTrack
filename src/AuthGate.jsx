import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => listener.subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    if (mode === 'signup') {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      if (error) setError(error.message);
      else setMessage('Check your email to confirm your account, then sign in.');
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

  // Logged in — render the real app
  if (session) return children;

  // Logged out — show sign in / sign up
  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,-apple-system,sans-serif', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 380, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <div style={{ width: 30, height: 30, background: '#0F6E56', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 14 }}>D</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: '#1e293b' }}>DentaTrack</div>
        </div>

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
          {message && <div style={{ fontSize: 13, color: '#0F6E56' }}>{message}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{ background: '#0F6E56', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 0', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginTop: 4, opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setMessage(''); }}
          style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', marginTop: 16, textAlign: 'center', width: '100%' }}
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}

const inputStyle = {
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};
