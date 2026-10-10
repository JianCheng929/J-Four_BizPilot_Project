import type { NextFunction, Request, Response } from 'express';
import type { BusinessRow } from '../../../src/lib/db/remote.ts';
import { supabaseAdmin } from './supabase.ts';

export interface AuthContext {
  userId: string;
  email: string;
  business: BusinessRow;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: AuthContext;
  }
}

export async function businessForUser(userId: string): Promise<BusinessRow | null> {
  const { data, error } = await supabaseAdmin().from('businesses').select('*').eq('owner_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as BusinessRow | null) ?? null;
}

/** Verifies the Supabase access token sent by the web app and loads the user's business. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in first.' });
    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Your session expired. Sign in again.' });
    const business = await businessForUser(data.user.id);
    if (!business) return res.status(400).json({ error: 'Finish onboarding first.' });
    req.ctx = { userId: data.user.id, email: data.user.email ?? data.user.id, business };
    next();
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}

export function ctx(req: Request): AuthContext {
  if (!req.ctx) throw new Error('Not authenticated');
  return req.ctx;
}
