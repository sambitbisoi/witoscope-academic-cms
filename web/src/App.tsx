import type { Session } from '@supabase/supabase-js';
import { useEffect, useState, type FormEvent } from 'react';
import { ImportDetail, ImportsList } from './Imports';
import { configError, isAdmin, supabase } from './supabase';

type Access = 'checking' | 'admin' | 'denied' | 'error';

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [access, setAccess] = useState<Access>('checking');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    setAccess('checking');
    isAdmin(session.user.id).then((ok) => setAccess(ok ? 'admin' : 'denied')).catch(() => setAccess('error'));
  }, [session?.user.id]);

  if (configError) return <Centered><h1>WitoScope CMS</h1><p className="error">{configError}</p></Centered>;
  if (session === undefined) return <Centered><p className="muted">Loading…</p></Centered>;
  if (!session) return <SignIn />;
  if (access === 'checking') return <Centered><p className="muted">Checking access…</p></Centered>;
  if (access === 'denied') return <NotAuthorised email={session.user.email} />;
  if (access === 'error') return <Centered><h1>WitoScope CMS</h1><p className="error">Couldn't check your access. Try again in a moment.</p><SignOut /></Centered>;
  return <Home email={session.user.email} />;
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'Email or password is wrong.' : error.message);
  }

  return (
    <Centered>
      <h1>WitoScope CMS</h1>
      <p className="muted">Question bank · internal</p>
      <form onSubmit={submit}>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </Centered>
  );
}

function NotAuthorised({ email }: { email?: string }) {
  return (
    <Centered>
      <h1>WitoScope CMS</h1>
      <p><strong>{email}</strong> can't use the CMS.</p>
      <p className="muted">Only the CMS admin account has access.</p>
      <SignOut />
    </Centered>
  );
}

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Home({ email }: { email?: string }) {
  const hash = useHashRoute();
  const detail = /^#\/imports\/(\d+)$/.exec(hash);
  const section = hash.startsWith('#/imports') ? 'imports' : 'home';
  return (
    <div className="page">
      <header>
        <nav>
          <span className="brand">WitoScope CMS</span>
          <a href="#/" className={section === 'home' ? 'active' : ''}>Home</a>
          <a href="#/imports" className={section === 'imports' ? 'active' : ''}>Imports</a>
        </nav>
        <span className="who"><span className="email">{email}</span> <SignOut small /></span>
      </header>
      <main>
        {detail ? <ImportDetail id={Number(detail[1])} /> : section === 'imports' ? <ImportsList /> : (
          <>
            <h2>Home</h2>
            <p className="muted">Browsing topics and questions arrives in Phase 3.</p>
          </>
        )}
      </main>
    </div>
  );
}

function SignOut({ small }: { small?: boolean }) {
  return <button className={small ? 'link' : 'secondary'} onClick={() => supabase.auth.signOut()}>Sign out</button>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered"><div className="card">{children}</div></div>;
}
