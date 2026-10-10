import { TwoStepPrompt } from '@/components/bizpilot/TwoStep';
import { needsTwoStepCode } from '@/lib/twoStep';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Loader2 } from 'lucide-react';
import { BizPilotProvider, createBusiness, listBusinesses, loadBusinessDb, useBizPilot } from '@/lib/store';
import { AccountCtx, type Account } from '@/lib/account';
import { getCurrentBusinessId, setCurrentBusinessId } from '@/lib/currentBusiness';
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
  const [businesses, setBusinesses] = useState<BusinessRow[]>([]);
  const [adding, setAdding] = useState(false);
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
    listBusinesses(userId)
      .then(async (list) => {
        setBusinesses(list);
        // Reopen the business used last on this browser, else the first one.
        const b = list.find((x) => x.id === getCurrentBusinessId()) ?? list[0] ?? null;
        setCurrentBusinessId(b?.id ?? null);
        setBusiness(b);
        if (b) setDb(await loadBusinessDb(b));
      })
      .catch((e: Error) => setError(e.message));
  }, [userId]);

  const switchBusiness = useCallback((id: string) => {
    const b = businesses.find((x) => x.id === id);
    if (!b || b.id === business?.id) return;
    setCurrentBusinessId(b.id);
    setDb(null);
    setBusiness(b);
    loadBusinessDb(b).then(setDb).catch((e: Error) => setError(e.message));
  }, [businesses, business]);
  const account = useMemo<Account>(() => ({ businesses, switchBusiness, addBusiness: () => setAdding(true) }), [businesses, switchBusiness]);

  if (error) return <FullScreen><p className="font-semibold text-red-700">Can't load your business</p><p>{error}</p></FullScreen>;
  if (session === undefined) return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /></FullScreen>;
  if (!session) return <Login />;
  if (step === 'ask') return <TwoStepPrompt onDone={() => setTwoStep({ user: session.user.id, state: 'ok' })} />;
  if (step === 'checking') return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /></FullScreen>;
  if (business === undefined) return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /></FullScreen>;
  if (business === null || adding) {
    return (
      <Onboarding
        onCancel={business ? () => setAdding(false) : undefined}
        onCreate={async (settings: Partial<BusinessSettings>) => {
          const b = await createBusiness(session.user.id, settings);
          setBusinesses((list) => [...list, b]);
          setCurrentBusinessId(b.id);
          setDb(await loadBusinessDb(b));
          setBusiness(b);
          setAdding(false);
        }}
      />
    );
  }
  if (!db) return <FullScreen><Loader2 className="mx-auto h-5 w-5 animate-spin" /><p>Opening {business.name}…</p></FullScreen>;
  return (
    <AccountCtx.Provider value={account}>
      {/* A new key per business: switching starts every page fresh on the other business's data. */}
      <BizPilotProvider key={business.id} session={session} business={business} initialDb={db}>
        <Shell />
      </BizPilotProvider>
    </AccountCtx.Provider>
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
