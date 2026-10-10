import type { Provider, ProviderContext } from '../providers/types.ts';
import { supabaseAdmin } from './supabase.ts';

export interface IntegrationRow {
  business_id: string;
  provider_id: string;
  credentials: Record<string, string>;
  tokens: Record<string, any>;
  status: 'unconfigured' | 'configured' | 'connected' | 'error' | 'disconnected';
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_sync_at: string | null;
  account: Record<string, unknown> | null;
  error: string | null;
}

export function serverUrl(): string {
  return (process.env.PUBLIC_SERVER_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
}

export async function getIntegrationRow(businessId: string, providerId: string): Promise<IntegrationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('integrations')
    .select('*')
    .eq('business_id', businessId)
    .eq('provider_id', providerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as IntegrationRow | null) ?? null;
}

export async function upsertIntegration(businessId: string, providerId: string, patch: Partial<IntegrationRow>) {
  const { error } = await supabaseAdmin()
    .from('integrations')
    .upsert(
      { business_id: businessId, provider_id: providerId, updated_at: new Date().toISOString(), ...patch },
      { onConflict: 'business_id,provider_id' },
    );
  if (error) throw new Error(error.message);
}

/** Credentials saved in BizPilot override values from server/.env. */
export async function providerContext(businessId: string, provider: Provider): Promise<ProviderContext> {
  const row = await getIntegrationRow(businessId, provider.id);
  const creds: Record<string, string> = {};
  for (const f of provider.fields) if (process.env[f.env]) creds[f.key] = process.env[f.env]!;
  Object.assign(creds, row?.credentials ?? {});
  const tokens = { ...(row?.tokens ?? {}) };
  return {
    businessId,
    creds,
    tokens,
    serverUrl: serverUrl(),
    saveTokens: async (t) => {
      Object.assign(tokens, t);
      await upsertIntegration(businessId, provider.id, { tokens });
    },
  };
}

export function isConfigured(provider: Provider, ctx: ProviderContext) {
  return provider.fields.filter((f) => !f.help?.startsWith('Optional')).every((f) => Boolean(ctx.creds[f.key]));
}
