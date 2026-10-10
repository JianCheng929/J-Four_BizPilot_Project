import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { toast } from 'sonner';
import type { ApprovalRequest, BizPilotDB, BusinessSettings } from './db/types';
import { getSupabase } from './db/supabase';
import { loadSnapshot, persistDiff, type BusinessRow } from './db/remote';
import { defaultSettings, emptyDB } from './db/defaults';
import * as ops from './ops';
import { api, post } from './api';

/**
 * App state backed by Supabase. All reads come from the business's tables;
 * every change goes through the deterministic operations in ops.ts and is
 * written back to the database. Actions with real-world effects go to the
 * BizPilot server (approvals, integrations, the WorkBuddy agent).
 */

interface Store {
  db: BizPilotDB;
  business: BusinessRow;
  session: Session;
  actor: string;
  /** Apply a deterministic change and save it. Shows a toast and returns undefined on failure. */
  run: <T>(fn: (draft: BizPilotDB, actor: string) => T, success?: string) => T | undefined;
  /** Call the BizPilot server, then refresh data. */
  callServer: <T = unknown>(path: string, body?: unknown, success?: string) => Promise<T | undefined>;
  reload: () => Promise<void>;
  syncing: boolean;
  requestApproval: (input: ops.ApprovalInput) => ApprovalRequest | undefined;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  updateSettings: (patch: Partial<BusinessSettings>) => void;
  markAllNotificationsRead: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function BizPilotProvider({
  session,
  business,
  initialDb,
  children,
}: {
  session: Session;
  business: BusinessRow;
  initialDb: BizPilotDB;
  children: ReactNode;
}) {
  const supa = getSupabase()!;
  const [db, setDb] = useState<BizPilotDB>(initialDb);
  const [syncing, setSyncing] = useState(false);
  const dbRef = useRef(db);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const actor = session.user.email ?? 'owner';

  const replace = (next: BizPilotDB) => {
    dbRef.current = next;
    setDb(next);
  };

  const reload = useCallback(async () => {
    if (pending.current > 0) return; // don't clobber unsaved local changes
    setSyncing(true);
    try {
      const fresh = await loadSnapshot(supa, business);
      if (pending.current === 0) replace(fresh);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }, [supa, business]);

  const run = useCallback(
    <T,>(fn: (draft: BizPilotDB, actor: string) => T, success?: string): T | undefined => {
      const prev = dbRef.current;
      const draft = structuredClone(prev);
      let result: T;
      try {
        result = fn(draft, actor);
      } catch (e) {
        toast.error((e as Error).message);
        return undefined;
      }
      replace(draft);
      pending.current += 1;
      saveChain.current = saveChain.current
        .then(() => persistDiff(supa, business.id, prev, draft))
        .then(() => {
          if (success) toast.success(success);
        })
        .catch((e) => {
          toast.error(`Not saved: ${(e as Error).message}`);
        })
        .finally(() => {
          pending.current -= 1;
          if (pending.current === 0) void reload();
        });
      return result;
    },
    [supa, business.id, actor, reload],
  );

  const callServer = useCallback(
    async <T,>(path: string, body?: unknown, success?: string): Promise<T | undefined> => {
      try {
        await saveChain.current; // make sure the server sees our latest writes
        const res = await post<T>(path, body);
        if (success) toast.success(success);
        await reload();
        return res;
      } catch (e) {
        toast.error((e as Error).message);
        await reload();
        return undefined;
      }
    },
    [reload],
  );

  // Pick up changes made by the server, WorkBuddy and integrations.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 15000);
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);

  const value = useMemo<Store>(
    () => ({
      db,
      business,
      session,
      actor,
      run,
      callServer,
      reload,
      syncing,
      requestApproval: (input) => run((d, a) => ops.requestApproval(d, input, a), 'Sent to Approvals'),
      approve: async (id) => {
        await callServer(`/api/approvals/${id}/approve`);
      },
      reject: async (id) => {
        await callServer(`/api/approvals/${id}/reject`, undefined, 'Rejected');
      },
      updateSettings: (patch) =>
        run((d, a) => {
          d.settings = { ...d.settings, ...patch };
          ops.audit(d, a, 'update', 'settings', 'business', `Settings updated: ${Object.keys(patch).join(', ')}`);
        }, 'Settings saved'),
      markAllNotificationsRead: () =>
        run((d) => {
          d.notifications.forEach((n) => (n.read = true));
        }),
      signOut: async () => {
        await supa.auth.signOut();
      },
    }),
    [db, business, session, actor, run, callServer, reload, syncing, supa],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBizPilot(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useBizPilot must be used inside BizPilotProvider');
  return ctx;
}

// ------------------------------------------------------------------ bootstrapping

export async function fetchBusiness(userId: string): Promise<BusinessRow | null> {
  const supa = getSupabase()!;
  const { data, error } = await supa.from('businesses').select('*').eq('owner_id', userId).maybeSingle();
  if (error) throw new Error(error.message.includes('does not exist')
    ? 'The database tables are missing. Run supabase/schema.sql in the Supabase SQL Editor (see SUPABASE_SETUP.md).'
    : error.message);
  return (data as BusinessRow | null) ?? null;
}

export async function createBusiness(userId: string, settings: Partial<BusinessSettings>): Promise<BusinessRow> {
  const supa = getSupabase()!;
  const merged = { ...defaultSettings, ...settings };
  const { name, mode, ...rest } = merged;
  const { data, error } = await supa
    .from('businesses')
    .insert({ owner_id: userId, name, mode, settings: rest })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as BusinessRow;
}

export async function loadBusinessDb(business: BusinessRow): Promise<BizPilotDB> {
  return loadSnapshot(getSupabase()!, business);
}

export { emptyDB, api };
