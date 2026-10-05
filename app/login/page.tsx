'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    setLoading(false);

    if (res.ok) {
      // Full navigation (not router.push) so the browser performs a fresh
      // document load that is guaranteed to carry the newly-set session
      // cookie, rather than reusing cached app-router state from when we
      // were logged out.
      window.location.href = '/';
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Login failed');
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-graphite-950 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-graphite-700 bg-graphite-900 p-6"
      >
        <div className="mb-5">
          <div className="mb-1 h-1.5 w-8 rounded-full bg-signal" />
          <h1 className="text-lg font-semibold text-neutral-100">Network Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-500">Sign in to access your devices.</p>
        </div>

        <div className="space-y-3">
          <input
            required
            autoFocus
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded border border-graphite-600 bg-graphite-800 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-signal"
          />
          <input
            required
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-graphite-600 bg-graphite-800 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-signal"
          />
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="mt-4 w-full rounded bg-signal py-2 text-sm font-medium text-graphite-950 hover:bg-signal/90 disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
