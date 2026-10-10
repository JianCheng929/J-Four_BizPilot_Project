import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { requireRole, requireUser, ctx } from '../lib/auth.ts';
import { handle, HttpError, contextFor } from '../lib/http.ts';
import { getIntegrationRow, isConfigured, providerContext, upsertIntegration, serverUrl } from '../lib/integrations.ts';
import { PROVIDERS } from '../providers/index.ts';
import { supabaseAdmin } from '../lib/supabase.ts';
import { WEBSITE_IMPORT_PROMPT } from '../providers/website.ts';
import { isBusinessBusy, startTask } from '../agent/runner.ts';

export const integrations = Router();

const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
const stateSecret = () => process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'bizpilot';

function signState(businessId: string, providerId: string) {
  const body = Buffer.from(JSON.stringify({ b: businessId, p: providerId, t: Date.now() })).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string, providerId: string): string {
  const [body, sig] = String(state ?? '').split('.');
  if (!body || !sig) throw new HttpError(400, 'Missing OAuth state.');
  const expect = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  if (expect.length !== sig.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) throw new HttpError(400, 'Invalid OAuth state.');
  const s = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (s.p !== providerId) throw new HttpError(400, 'OAuth state is for a different integration.');
  if (Date.now() - s.t > 30 * 60_000) throw new HttpError(400, 'The connection link expired. Click Connect again.');
  return s.b as string;
}

const callbackUrl = (id: string) => `${serverUrl()}/api/integrations/${id}/callback`;

/** List integrations. Secret values never leave the server; only whether they're set. */
integrations.get(
  '/',
  requireUser,
  handle(async (req) => {
    const businessId = ctx(req).business.id;
    const { data, error } = await supabaseAdmin().from('integrations').select('*').eq('business_id', businessId);
    if (error) throw new Error(error.message);
    return Promise.all(
      PROVIDERS.map(async (p) => {
        const row = (data ?? []).find((r: any) => r.provider_id === p.id);
        const pctx = await providerContext(businessId, p);
        const configured = isConfigured(p, pctx);
        const hasTokens = Boolean(pctx.tokens.access_token);
        return {
          id: p.id,
          label: p.label,
          category: p.category,
          description: p.description,
          docs: p.docs,
          oauth: Boolean(p.oauth),
          callbackUrl: p.oauth ? callbackUrl(p.id) : null,
          fields: p.fields.map((f) => ({
            key: f.key,
            label: f.label,
            secret: f.secret,
            placeholder: f.placeholder ?? '',
            help: f.help ?? '',
            value: f.secret ? '' : pctx.creds[f.key] ?? '',
            isSet: Boolean(pctx.creds[f.key]),
            fromEnv: !row?.credentials?.[f.key] && Boolean(process.env[f.env]),
          })),
          configured,
          connected: p.oauth ? configured && hasTokens : configured && row?.last_test_ok === true,
          status: row?.status ?? (configured ? 'configured' : 'unconfigured'),
          account: row?.account ?? null,
          lastTestedAt: row?.last_tested_at ?? null,
          lastTestOk: row?.last_test_ok ?? null,
          lastSyncAt: row?.last_sync_at ?? null,
          error: row?.error ?? null,
        };
      }),
    );
  }),
);

/** Save credentials. Blank secret fields keep their current value. */
integrations.put(
  '/:id',
  requireUser,
  requireRole('manager'),
  handle(async (req) => {
    const businessId = ctx(req).business.id;
    const { provider } = await contextFor(businessId, String(req.params.id));
    const incoming = (req.body?.credentials ?? {}) as Record<string, unknown>;
    const row = await getIntegrationRow(businessId, provider.id);
    const creds: Record<string, string> = { ...(row?.credentials ?? {}) };
    for (const f of provider.fields) {
      if (!(f.key in incoming)) continue;
      const val = String(incoming[f.key] ?? '').trim();
      if (f.secret && !val) continue;
      if (val) creds[f.key] = val;
      else delete creds[f.key];
    }
    await upsertIntegration(businessId, provider.id, { credentials: creds, status: 'configured', error: null });
    return { ok: true };
  }),
);

integrations.post(
  '/:id/test',
  requireUser,
  requireRole('manager'),
  handle(async (req) => {
    const businessId = ctx(req).business.id;
    const { provider, pctx } = await contextFor(businessId, String(req.params.id));
    const result = await provider.test(pctx);
    await upsertIntegration(businessId, provider.id, {
      last_tested_at: new Date().toISOString(),
      last_test_ok: result.ok,
      status: result.ok ? 'connected' : 'error',
      error: result.ok ? null : result.message,
      ...(result.account ? { account: result.account } : {}),
    });
    // Own website: the first good test starts the agent reading it, no extra click.
    if (provider.id === 'website' && result.ok && !(await getIntegrationRow(businessId, 'website'))?.last_sync_at && !isBusinessBusy(businessId)) {
      const task = await startTask(businessId, WEBSITE_IMPORT_PROMPT, null).catch(() => null);
      if (task) return { ...result, message: `${result.message} BizPilot is now reading your site and filling everything in.`, taskId: task.id };
    }
    return result;
  }),
);

/** Own website: read the site again and bring in what's new. */
integrations.post(
  '/website/import',
  requireUser,
  requireRole('manager'),
  handle(async (req) => {
    const businessId = ctx(req).business.id;
    if (!(await getIntegrationRow(businessId, 'website'))?.credentials?.SITE_URL) throw new HttpError(400, 'Save your website address first.');
    if (isBusinessBusy(businessId)) throw new HttpError(409, 'BizPilot is still working on another goal. Try again when it finishes.');
    return startTask(businessId, WEBSITE_IMPORT_PROMPT, null);
  }),
);

integrations.delete(
  '/:id',
  requireUser,
  requireRole('manager'),
  handle(async (req) => {
    const businessId = ctx(req).business.id;
    const { error } = await supabaseAdmin().from('integrations').delete().eq('business_id', businessId).eq('provider_id', String(req.params.id));
    if (error) throw new Error(error.message);
    return { ok: true };
  }),
);

/** Start OAuth: returns the platform's authorisation URL for the browser to open. */
integrations.post(
  '/:id/connect',
  requireUser,
  requireRole('manager'),
  handle(async (req) => {
    const businessId = ctx(req).business.id;
    const { provider, pctx } = await contextFor(businessId, String(req.params.id));
    if (!provider.oauth) throw new HttpError(400, `${provider.label} doesn't use a Connect button; save its keys and click Test.`);
    if (!isConfigured(provider, pctx)) throw new HttpError(400, `Save your ${provider.label} app credentials first.`);
    return { url: provider.oauth.authorizeUrl(pctx, callbackUrl(provider.id), signState(businessId, provider.id)) };
  }),
);

/** OAuth redirect target (opened by the platform, so no BizPilot login header). */
integrations.get('/:id/callback', async (req, res) => {
  const id = String(req.params.id);
  const back = (status: 'ok' | 'error', message: string) =>
    res.redirect(`${appUrl()}/?page=settings&integration=${encodeURIComponent(id)}&status=${status}&message=${encodeURIComponent(message)}`);
  try {
    const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    const businessId = verifyState(query.state, id);
    const { provider, pctx } = await contextFor(businessId, id);
    if (!provider.oauth) throw new HttpError(400, 'Not an OAuth integration.');
    const { tokens, account } = await provider.oauth.exchange(pctx, query, callbackUrl(id));
    await upsertIntegration(businessId, id, {
      tokens: { ...pctx.tokens, ...tokens },
      account: account ?? null,
      status: 'connected',
      error: null,
      last_test_ok: true,
      last_tested_at: new Date().toISOString(),
    });
    back('ok', `${provider.label} connected${account?.shop_name ? ` (${account.shop_name})` : ''}.`);
  } catch (e) {
    back('error', (e as Error).message);
  }
});
