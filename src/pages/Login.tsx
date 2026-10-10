import { useState } from 'react';
import { Compass, Loader2 } from 'lucide-react';
import { getSupabase } from '@/lib/db/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';

export function Login() {
  const supa = getSupabase()!;
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const res =
      mode === 'signin'
        ? await supa.auth.signInWithPassword({ email, password })
        : await supa.auth.signUp({ email, password });
    setBusy(false);
    if (res.error) return setError(res.error.message);
    if (mode === 'signup' && !res.data.session) {
      setInfo('Check your inbox to confirm your email, then sign in.');
      setMode('signin');
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#f7f8f7] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 text-white">
            <Compass className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">BizPilot</div>
            <div className="text-xs text-slate-500">AI business operations, powered by WorkBuddy</div>
          </div>
        </div>
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-6">
            <h1 className="mb-4 text-lg font-semibold">{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
            <form onSubmit={submit} className="space-y-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">Email</Label>
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Password</Label>
                <Input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              {info && <p className="text-xs text-teal-700">{info}</p>}
              <Button type="submit" disabled={busy} className="w-full bg-teal-700 hover:bg-teal-800">
                {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {mode === 'signin' ? 'Sign in' : 'Sign up'}
              </Button>
            </form>
            <button
              className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-800"
              onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            >
              {mode === 'signin' ? "New to BizPilot? Create an account" : 'Already have an account? Sign in'}
            </button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
