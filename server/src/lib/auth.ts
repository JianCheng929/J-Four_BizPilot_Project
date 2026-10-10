import type { NextFunction, Request, Response } from 'express';
import type { BusinessRow } from '../../../src/lib/db/remote.ts';
import type { TeamRole } from '../../../src/lib/db/types.ts';
import { supabaseAdmin } from './supabase.ts';

export interface AuthContext {
  userId: string;
  email: string;
  role: TeamRole;
  business: BusinessRow;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: AuthContext;
  }
}

/**
 * The business this request works on, with the user's role in it. One login can own or
 * join several businesses: the web app names the open one in the X-Business-Id header.
 * Without it (or if the user can't open that one) it falls back to their first own business,
 * then their first team membership.
 */
export async function businessForUser(userId: string, wantedId?: string): Promise<(BusinessRow & { role: TeamRole }) | null> {
  const admin = supabaseAdmin();
  const one = async (id: string) => {
    const b = await admin.from('businesses').select('*').eq('id', id).maybeSingle();
    if (b.error) throw new Error(b.error.message);
    return (b.data as BusinessRow | null) ?? null;
  };
  const memberships = async () => {
    const m = await admin.from('business_members').select('business_id, role').eq('user_id', userId).order('invited_at');
    return m.error ? [] : ((m.data ?? []) as { business_id: string; role: TeamRole }[]); // no team table yet
  };

  if (wantedId && /^[0-9a-f-]{36}$/i.test(wantedId)) {
    const b = await one(wantedId);
    if (b && b.owner_id === userId) return { ...b, role: 'owner' };
    const m = (await memberships()).find((x) => x.business_id === wantedId);
    if (b && m) return { ...b, role: m.role };
  }

  const { data, error } = await admin.from('businesses').select('*').eq('owner_id', userId).order('created_at').limit(1);
  if (error) throw new Error(error.message);
  if (data?.[0]) return { ...(data[0] as BusinessRow), role: 'owner' };
  for (const m of await memberships()) {
    const b = await one(m.business_id);
    if (b) return { ...b, role: m.role };
  }
  return null;
}

/** Assurance level in a Supabase access token: aal1 = password only, aal2 = password + two-step code. */
function tokenAal(token: string): string {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).aal ?? 'aal1';
  } catch {
    return 'aal1';
  }
}

/** Verifies the Supabase access token sent by the web app and loads the user's business. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in first.' });
    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Your session expired. Sign in again.' });
    // Two-step login: once turned on, the session must have passed the code check (aal2).
    if (data.user.factors?.some((f) => f.status === 'verified') && tokenAal(token) !== 'aal2') {
      return res.status(401).json({ error: 'Enter your two-step login code first.' });
    }
    const business = await businessForUser(data.user.id, req.header('x-business-id') ?? undefined);
    if (!business) return res.status(400).json({ error: 'Finish onboarding first.' });
    req.ctx = { userId: data.user.id, email: data.user.email ?? data.user.id, role: business.role, business };
    next();
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}

export function ctx(req: Request): AuthContext {
  if (!req.ctx) throw new Error('Not authenticated');
  return req.ctx;
}

const RANK: Record<TeamRole, number> = { viewer: 0, staff: 1, manager: 2, owner: 3 };

/** Blueprint §17 role-based access. Use after requireUser. */
export function requireRole(min: TeamRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.ctx?.role ?? 'viewer';
    if (RANK[role] >= RANK[min]) return next();
    const need = min === 'manager' ? 'the owner or a manager' : min === 'owner' ? 'the owner' : 'staff access or higher';
    res.status(403).json({ error: `Your role (${role}) can't do this. It needs ${need}.` });
  };
}
