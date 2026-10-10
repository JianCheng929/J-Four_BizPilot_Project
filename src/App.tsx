import { TwoStepPrompt } from '@/components/bizpilot/TwoStep';
import { needsTwoStepCode } from '@/lib/twoStep';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Loader2 } from 'lucide-react';
import { BizPilotProvider, createBusiness, fetchBusiness, loadBusinessDb, useBizPilot } from '@/lib/store';
import { getSupabase, isSupabaseConfigured } from '@/lib/db/supabase';
import type { BusinessRow } from '@/lib/db/remote';
import type { BizPilotDB, BusinessSettings } from '@/lib/db/types';
import { AppShell, type PageKey } from '@/components/layout/AppShell';
import { Toaster } from '@/components/ui/sonner';
import { Dashboard } from '@/pages/Dashboard';
import { CommandCentre } from '@/pages/CommandCentre';
import { Inventory } from '@/pages/Inventory';
import { SupplyChain } from '@/pages/SupplyChain';
import { Marketing } from '@/pages/Marketing';
import { Finance } from '@/pages/Finance';
import { Customers } from '@/pages/Customers';
import { Approvals } from '@/pages/Approvals';
import { Settings } from '@/pages/Settings';
import { Reports } from '@/pages/Reports';
import { Onboarding } from '@/pages/Onboarding';
import { Login } from '@/pages/Login';

function Shell() {
  const [page, setPage] = useState<PageKey>(() => (new URLSearchParams(window.location.search).get('page') as PageKey) || 'dashboard');
  useBizPilot();
  // "BizPilot noticed" panels and the working indicator open a chat in Command Centre.
  useEffect(() => {
    const go = () => setPage('command');
    window.addEventListener('bizpilot:open-chat', go);
    return () => window.removeEventListener('bizpilot:open-chat', go);
  }, []);
  return (
    <AppShell page={page} onNavigate={setPage}>
      {page === 'dashboard' && <Dashboard onNavigate={setPage} />}
      {page === 'command' && <CommandCentre onNavigate={setPage} />}
      {page === 'inventory' && <Inventory />}
      {page === 'supplychain' && <SupplyChain />}
      {page === 'marketing' && <Marketing onNavigate={setPage} />}
      {page === 'finance' && <Finance />}
      {page === 'customers' && <Customers />}
      {page === 'approvals' && <Approvals />}
      {page === 'reports' && <Reports onNavigate={setPage} />}
      {page === 'settings' && <Settings />}
    </AppShell>
  );
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#f7f8f7] px-4 text-center text-sm text-slate-600">
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  );
}

function Gate() {
  const supa = getSupabase()!;
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [business, setBusiness] = useState<BusinessRow | null | undefined>(undefined);
  const [db, setDb] = useState<BizPilotDB | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two-step login: 'ask' shows the code screen before any business data loads.
  const [twoStep, setTwoStep] = useState<{ user: string; state: 'ask' | 'ok' } | null>(null);

  useEffect(() => {
    supa.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supa.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [supa]);

  const sessionUser = session?.user.id;
  useEffect(() => {
    if (!sessionUser) return;
    let live = true;
    needsTwoStepCode()
      .then((need) => live && setTwoStep({ user: sessionUser, state: need ? 'ask' : 'ok' }))
      .catch(() => live && setTwoStep({ user: sessionUser, state: 'ok' }));
    return () => { live = false; };
  }, [sessionUser]);
  const step = twoStep && twoStep.user === sessionUser ? twoStep.state : 'checking';

  const userId = step === 'ok' ? sessionUser : undefined;
  useEffect(() => {
    if (!userId) {
      setBusiness(undefined);
      setDb(null);
      return;
    }
    setError(null);
    fetchBusiness(userId)
      .then(async (b) => {
        setBusiness(b);
        if (b) setDb(await loadBusinessDb(b));
      })
      .catch((e: Error) => setError(e.message));
  }, [userId]);

  if (error) return <FullScreen><p className="font-semibold text-red-700">Can't load your business</p><p>{error}</p></FullScreen>;
  if (session === undefined) return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /></FullScreen>;
  if (!session) return <Login />;
  if (step === 'ask') return <TwoStepPrompt onDone={() => setTwoStep({ user: session.user.id, state: 'ok' })} />;
  if (step === 'checking') return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /></FullScreen>;
  if (business === undefined) return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /></FullScreen>;
  if (business === null) {
    return (
      <Onboarding
        onCreate={async (settings: Partial<BusinessSettings>) => {
          const b = await createBusiness(session.user.id, settings);
          setDb(await loadBusinessDb(b));
          setBusiness(b);
        }}
      />
    );
  }
  if (!db) return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /></FullScreen>;
  return (
    <BizPilotProvider session={session} business={business} initialDb={db}>
      <Shell />
    </BizPilotProvider>
  );
}

export default function App() {
  return (
    <>
      {isSupabaseConfigured ? (
        <Gate />
      ) : (
        <FullScreen>
          <p className="font-semibold">BizPilot needs its database</p>
          <p>
            Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to the <code>.env</code> file in the
            project folder, then restart <code>npm run dev</code>. See SUPABASE_SETUP.md.
          </p>
        </FullScreen>
      )}
      <Toaster richColors position="top-right" />
    </>
  );
}
