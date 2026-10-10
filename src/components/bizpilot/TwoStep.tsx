import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import { getSupabase } from '@/lib/db/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard, primaryBtn } from './common';

/** Second login step: the 6-digit code from Google Authenticator, Microsoft Authenticator, Authy… */
export function TwoStepPrompt({ onDone }: { onDone: () => void }) {
  const supa = getSupabase()!;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data: f, error: e1 } = await supa.auth.mfa.listFactors();
      if (e1) throw e1;
      const factor = f?.totp?.[0];
      if (!factor) throw new Error('No authenticator app is set up for this account.');
      const { error: e2 } = await supa.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
      if (e2) throw e2;
      onDone();
    } catch (e) {
      setError((e as Error).message.includes('Invalid') ? 'That code is wrong or expired. Use the newest code in the app.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#f7f8f7] px-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-teal-700" /><div className="font-semibold">Two-step login</div></div>
        <p className="text-sm text-slate-600">Open your authenticator app and enter the 6-digit code for BizPilot.</p>
        <Input inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} placeholder="123456" value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && void verify()} />
        {error && <div className="text-xs text-red-600">{error}</div>}
        <Button className={`w-full ${primaryBtn}`} disabled={code.length !== 6 || busy} onClick={() => void verify()}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Verify</Button>
        <button className="w-full text-center text-xs text-slate-500 hover:underline" onClick={() => void supa.auth.signOut()}>Sign out</button>
      </div>
    </div>
  );
}

/** Settings → Security: turn two-step login on or off for the signed-in user. */
export function TwoStepCard() {
  const supa = getSupabase()!;
  const [factorId, setFactorId] = useState<string | null | undefined>(undefined);
  const [enrol, setEnrol] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const { data } = await supa.auth.mfa.listFactors();
    setFactorId(data?.totp?.[0]?.id ?? null);
  };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    try {
      // Remove any half-finished setup first.
      const { data: all } = await supa.auth.mfa.listFactors();
      for (const f of all?.all ?? []) if (f.status !== 'verified') await supa.auth.mfa.unenroll({ factorId: f.id });
      const { data, error } = await supa.auth.mfa.enroll({ factorType: 'totp', friendlyName: `BizPilot ${new Date().toISOString().slice(0, 10)}` });
      if (error) throw error;
      setEnrol({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } catch (e) {
      toast.error((e as Error).message.includes('disabled') ? 'Two-step login is off in Supabase: Authentication → Multi-Factor → enable TOTP.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!enrol) return;
    setBusy(true);
    try {
      const { error } = await supa.auth.mfa.challengeAndVerify({ factorId: enrol.id, code });
      if (error) throw error;
      setEnrol(null);
      setCode('');
      toast.success('Two-step login is on. You will be asked for a code each time you sign in.');
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    if (!factorId || !window.confirm('Turn off two-step login for your account?')) return;
    const { error } = await supa.auth.mfa.unenroll({ factorId });
    if (error) return toast.error(error.message);
    toast.success('Two-step login turned off');
    await refresh();
  };

  return (
    <SectionCard title="Two-step login" description="Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) as well as your password. Each team member turns it on for their own account.">
      {factorId === undefined ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : factorId ? (
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-teal-700" /><span className="text-sm font-medium">On for your account</span>
          <Button size="sm" variant="outline" onClick={() => void turnOff()}><ShieldOff className="mr-1 h-4 w-4" /> Turn off</Button>
        </div>
      ) : enrol ? (
        <div className="flex flex-wrap items-start gap-4">
          <img src={enrol.qr} alt="QR code for the authenticator app" className="h-40 w-40 rounded border bg-white p-1" />
          <div className="max-w-sm space-y-2 text-sm">
            <p>1. Scan this QR code with your authenticator app. Can't scan? Enter this key: <code className="break-all rounded bg-slate-100 px-1 text-xs">{enrol.secret}</code></p>
            <p>2. Enter the 6-digit code it shows:</p>
            <div className="flex gap-2">
              <Input className="w-32" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <Button className={primaryBtn} disabled={code.length !== 6 || busy} onClick={() => void confirm()}>Turn on</Button>
            </div>
          </div>
        </div>
      ) : (
        <Button className={primaryBtn} disabled={busy} onClick={() => void start()}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Set up two-step login</Button>
      )}
    </SectionCard>
  );
}
