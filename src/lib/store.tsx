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
import type { ApprovalRequest, BizPilotDB, BusinessSettings, TeamRole } from './db/types';
import { getSupabase } from './db/supabase';
import { commitDiff, ConflictError, loadSnapshot, type BusinessRow, type Versions } from './db/remote';
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
  /** The signed-in user's role in this business. */
  role: TeamRole;
  /** What the role allows: write records, decide approvals / manage settings, manage the team. */
  can: { write: boolean; manage: boolean; owner: boolean };
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
  const versions = useRef<Versions>(new Map());
  const versionsReady = useRef(false);
  const actor = session.user.email ?? 'owner';
  const role: TeamRole = business.role ?? 'owner';
  const can = useMemo(
    () => ({ write: role !== 'viewer', manage: role === 'owner' || role === 'manager', owner: role === 'owner' }),
    [role],
  );

  const replace = (next: BizPilotDB) => {
    dbRef.current = next;
    setDb(next);
  };

  const reload = useCallback(async () => {
    if (pending.current > 0) return; // don't clobber unsaved local changes
    setSyncing(true);
    try {
      const v: Versions = new Map();
      const fresh = await loadSnapshot(supa, business, v);
      if (pending.current === 0) {
        versions.current = v;
        versionsReady.current = true;
        replace(fresh);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }, [supa, business]);

  /**
   * Save prev→draft in one transaction. If someone else saved a newer version of a
   * touched record meanwhile, reload and redo the same change on the fresh data
   * (so stock is never double-counted), up to 3 times.
   */
  const commit = useCallback(
    async <T,>(prev: BizPilotDB, draft: BizPilotDB, fn: (draft: BizPilotDB, actor: string) => T) => {
      if (!versionsReady.current) {
        // First save before any versioned load: get the current versions first.
        const v: Versions = new Map();
        await loadSnapshot(supa, business, v);
        versions.current = v;
        versionsReady.current = true;
      }
      let base = prev;
      let next = draft;
      for (let attempt = 1; ; attempt++) {
        try {
          await commitDiff(supa, business.id, base, next, versions.current);
          return;
        } catch (e) {
          if (!(e instanceof ConflictError) || attempt >= 4) throw e;
          const v: Versions = new Map();
          base = await loadSnapshot(supa, business, v);
          versions.current = v;
          next = structuredClone(base);
          fn(next, actor); // a real business rule (e.g. not enough stock now) throws here
        }
      }
    },
    [supa, business, actor],
  );

  const run = useCallback(
    <T,>(fn: (draft: BizPilotDB, actor: string) => T, success?: string): T | undefined => {
      if (role === 'viewer') {
        toast.error('You have view-only access. Ask the owner for staff access to make changes.');
        return undefined;
      }
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
        .then(() => commit(prev, draft, fn))
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
    [actor, reload, commit, role],
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
      role,
      can,
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
    [db, business, session, actor, role, can, run, callServer, reload, syncing, supa],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBizPilot(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useBizPilot must be used inside BizPilotProvider');
  return ctx;
}

// ------------------------------------------------------------------ bootstrapping

/** Every business this user owns or was invited to (accepting pending invites first), owned ones first. */
export async function listBusinesses(userId: string): Promise<BusinessRow[]> {
  const supa = getSupabase()!;
  const { data, error } = await supa.from('businesses').select('*').eq('owner_id', userId).order('created_at');
  if (error) throw new Error(error.message.includes('does not exist')
    ? 'The database tables are missing. Run supabase/schema.sql in the Supabase SQL Editor (see SUPABASE_SETUP.md).'
    : error.message);
  const owned = (data ?? []).map((b) => ({ ...(b as BusinessRow), role: 'owner' as TeamRole }));

  // Team member: link pending invites for this email, then load those businesses.
  const accepted = await supa.rpc('accept_business_invite');
  if (accepted.error) return owned; // team roles not installed yet (supabase/industrial.sql)
  const { data: ms } = await supa.from('business_members').select('business_id, role').eq('user_id', userId);
  const ids = (ms ?? []).map((m) => m.business_id as string).filter((id) => !owned.some((b) => b.id === id));
  if (!ids.length) return owned;
  const { data: bs, error: bErr } = await supa.from('businesses').select('*').in('id', ids).order('created_at');
  if (bErr) throw new Error(bErr.message);
  const role = (id: string) => (ms ?? []).find((m) => m.business_id === id)?.role as TeamRole;
  return [...owned, ...(bs ?? []).map((b) => ({ ...(b as BusinessRow), role: role((b as BusinessRow).id) }))];
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
  if (error) throw new Error(/duplicate key|businesses_owner/.test(error.message)
    ? 'Your database allows only one business per login. Run supabase/industrial.sql again in the Supabase SQL Editor, then try again.'
    : error.message);
  return { ...(data as BusinessRow), role: 'owner' };
}

export async function loadBusinessDb(business: BusinessRow): Promise<BizPilotDB> {
  return loadSnapshot(getSupabase()!, business);
}

export { emptyDB, api };
