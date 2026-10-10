import { getSupabase } from './db/supabase';
import { getCurrentBusinessId } from './currentBusiness';

/**
 * Client for the BizPilot server (server/). The server holds integration
 * credentials, runs the WorkBuddy agent and executes approved actions.
 */
export const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  (import.meta.env.VITE_INTEGRATIONS_API_URL as string | undefined) ||
  'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function authHeader(): Promise<Record<string, string>> {
  const supa = getSupabase();
  const { data } = (await supa?.auth.getSession()) ?? { data: { session: null } };
  const token = data.session?.access_token;
  const business = getCurrentBusinessId();
  return token ? { Authorization: `Bearer ${token}`, ...(business ? { 'X-Business-Id': business } : {}) } : {};
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeader()),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new ApiError(
      `Can't reach the BizPilot server at ${API_BASE}. If it was asleep, wait a moment and try again; otherwise check the server is running and allows this site (APP_URL).`,
      0,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Server returned ${res.status}`, res.status);
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
