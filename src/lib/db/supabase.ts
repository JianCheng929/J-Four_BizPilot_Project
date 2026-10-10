import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase connection (blueprint §15 — Business Database).
 * Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the project .env
 * (see SUPABASE_SETUP.md). BizPilot stores all business data here.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) client = createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}
