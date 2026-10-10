/**
 * Lazada Open Platform (Malaysia).
 *
 * Docs: https://open.lazada.com/apps/doc/doc?nodeId=10450&docId=108068 (signature)
 *       https://open.lazada.com/apps/doc/doc?nodeId=10434&docId=108260 (seller authorisation)
 *
 * Signing: take every request parameter (system + business, except `sign`),
 * sort by key (ASCII), concatenate api_path + key1value1key2value2…, then
 * HMAC-SHA256 with app_secret → uppercase hex.
 * System params: app_key, timestamp (ms), sign_method=sha256, access_token (seller APIs).
 */
import { createHmac } from 'node:crypto';
import type { ExternalOrder, ExternalOrderItem, Provider, ProviderContext } from './types.ts';
import { ProviderError } from './types.ts';

const API_HOST = 'https://api.lazada.com.my/rest';
const AUTH_HOST = 'https://auth.lazada.com';
const AUTH_REST = `${AUTH_HOST}/rest`;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const ITEMS_BATCH = 50; // GetMultipleOrderItems accepts up to 50 order ids

function requireCreds(ctx: ProviderContext): { appKey: string; appSecret: string } {
  const appKey = ctx.creds.APP_KEY;
  const appSecret = ctx.creds.APP_SECRET;
  if (!appKey || !appSecret) {
    throw new ProviderError('Lazada App Key and App Secret are required. Add them in Settings → Integrations.');
  }
  return { appKey, appSecret };
}

export function signLazada(appSecret: string, apiPath: string, params: Record<string, string>): string {
  const base =
    apiPath +
    Object.keys(params)
      .filter((k) => k !== 'sign')
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join('');
  return createHmac('sha256', appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}

const num = (v: unknown): number => {
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
  return Number.isFinite(n) ? n : 0;
};

async function call(
  ctx: ProviderContext,
  baseUrl: string,
  apiPath: string,
  business: Record<string, string | number | undefined>,
  accessToken?: string,
): Promise<any> {
  const { appKey, appSecret } = requireCreds(ctx);
  const params: Record<string, string> = {
    app_key: appKey,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
  };
  if (accessToken) params.access_token = accessToken;
  for (const [k, v] of Object.entries(business)) if (v !== undefined) params[k] = String(v);
  params.sign = signLazada(appSecret, apiPath, params);

  const url = `${baseUrl}${apiPath}?${new URLSearchParams(params).toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch (e) {
    throw new ProviderError(`Could not reach Lazada (${(e as Error).message}).`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`Lazada ${apiPath} returned HTTP ${res.status} with a non-JSON body.`);
  }
  // Success responses carry code "0"; errors carry { type, code, message }.
  if (data.code !== undefined && String(data.code) !== '0') {
    throw new ProviderError(`Lazada ${apiPath} failed: ${data.code}${data.message ? ` — ${data.message}` : ''}`);
  }
  if (!res.ok) throw new ProviderError(`Lazada ${apiPath} returned HTTP ${res.status}.`);
  return data;
}

function tokensFrom(data: any) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expire_at: Date.now() + num(data.expires_in) * 1000,
    refresh_expire_at: data.refresh_expires_in ? Date.now() + num(data.refresh_expires_in) * 1000 : undefined,
    country: data.country,
    account: data.account,
  };
}

/** Returns a valid access token, refreshing via /auth/token/refresh within 5 minutes of expiry. */
export async function ensureAccessToken(ctx: ProviderContext): Promise<string> {
  const { access_token, refresh_token, expire_at } = ctx.tokens;
  if (!access_token) throw new ProviderError('Click Connect to authorise your Lazada seller account');
  if (expire_at && Number(expire_at) - Date.now() > REFRESH_MARGIN_MS) return access_token;
  if (!refresh_token) throw new ProviderError('Lazada session expired. Click Connect to authorise your Lazada seller account again.');
  let data: any;
  try {
    data = await call(ctx, AUTH_REST, '/auth/token/refresh', { refresh_token });
  } catch (e) {
    throw new ProviderError(`${(e as Error).message} Click Connect to authorise your Lazada seller account again.`);
  }
  const tokens = tokensFrom(data);
  if (!tokens.refresh_token) tokens.refresh_token = refresh_token;
  await ctx.saveTokens(tokens);
  Object.assign(ctx.tokens, tokens);
  return tokens.access_token;
}

async function sellerCall(ctx: ProviderContext, apiPath: string, business: Record<string, string | number | undefined> = {}) {
  const token = await ensureAccessToken(ctx);
  return call(ctx, API_HOST, apiPath, business, token);
}

/** Lazada timestamps look like "2024-05-01 10:22:00 +0800". */
function toIso(v: unknown): string {
  if (!v) return new Date().toISOString();
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  const d = new Date(m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function mapStatus(statuses: string[]) {
  const s = statuses.map((x) => x.toLowerCase());
  const cancelled = s.length > 0 && s.every((x) => x === 'canceled' || x === 'cancelled');
  const pending = s.some((x) => x === 'unpaid');
  const shipped = s.some((x) => ['shipped', 'delivered', 'shipped_back', 'shipped_back_success'].includes(x));
  const refunded = s.length > 0 && s.every((x) => x === 'returned' || x === 'refunded' || x === 'shipped_back_success');
  return { cancelled, pending, shipped, refunded };
}

function mapOrder(o: any, rawItems: any[]): ExternalOrder {
  // Lazada returns one order item row per unit; aggregate by SKU + price.
  const items = new Map<string, ExternalOrderItem>();
  for (const it of rawItems) {
    const sku = String(it.sku || it.shop_sku || it.sku_id || it.order_item_id);
    const price = num(it.item_price ?? it.paid_price);
    const key = `${sku}|${price}`;
    const prev = items.get(key);
    if (prev) prev.quantity += 1;
    else items.set(key, { sku, name: String(it.name ?? sku), quantity: 1, unitPrice: price });
  }
  const statuses: string[] = Array.isArray(o.statuses) ? o.statuses.map(String) : [];
  const st = mapStatus(statuses);
  const ship = o.address_shipping ?? {};
  const address = [ship.address1, ship.address2, ship.address3, ship.address4, ship.address5, ship.city, ship.post_code, ship.country]
    .filter((x) => x && String(x).trim())
    .join(', ');
  const customerName =
    [o.customer_first_name, o.customer_last_name].filter(Boolean).join(' ').trim() ||
    [ship.first_name, ship.last_name].filter(Boolean).join(' ').trim() ||
    'Lazada buyer';
  // Unpaid/pending: Lazada's "pending" means paid & awaiting fulfilment, so only
  // "unpaid" maps to paymentStatus pending.
  return {
    externalId: String(o.order_id),
    orderNumber: String(o.order_number ?? o.order_id),
    date: toIso(o.created_at),
    customerName,
    customerPhone: ship.phone || undefined,
    shippingAddress: address || undefined,
    shippingPostcode: ship.post_code || undefined,
    items: [...items.values()],
    // `price` is the order amount as reported by Lazada; shipping_fee and voucher
    // are reported separately (double-check against Seller Center for your account).
    total: num(o.price),
    paymentStatus: st.refunded ? 'refunded' : st.pending ? 'pending' : 'paid',
    cancelled: st.cancelled,
    shipped: st.shipped,
    paymentMethod: o.payment_method || undefined,
  };
}

export const lazada: Provider = {
  id: 'lazada',
  label: 'Lazada',
  category: 'E-commerce & marketplaces',
  description: 'Import Lazada Malaysia orders via the Lazada Open Platform.',
  docs: 'https://open.lazada.com/',
  fields: [
    { key: 'APP_KEY', label: 'App Key', env: 'LAZADA_APP_KEY', secret: false, placeholder: '123456' },
    { key: 'APP_SECRET', label: 'App Secret', env: 'LAZADA_APP_SECRET', secret: true },
  ],

  oauth: {
    authorizeUrl(ctx, redirectUri, state) {
      const { appKey } = requireCreds(ctx);
      const url = new URL('/oauth/authorize', AUTH_HOST);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('force_auth', 'true');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('client_id', appKey);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchange(ctx, query) {
      if (!query.code) throw new ProviderError('Lazada did not return an authorisation code.');
      const data = await call(ctx, AUTH_REST, '/auth/token/create', { code: query.code });
      if (!data.access_token) throw new ProviderError('Lazada did not return an access token.');
      const tokens = tokensFrom(data);
      const userInfo = Array.isArray(data.country_user_info) ? data.country_user_info : [];
      const my = userInfo.find((u: any) => String(u.country).toLowerCase() === 'my') ?? userInfo[0];
      if (data.country && String(data.country).toLowerCase() !== 'my' && !my) {
        throw new ProviderError(`This Lazada account is registered in "${data.country}", not Malaysia.`);
      }
      const account: Record<string, unknown> = {
        account: data.account,
        country: data.country,
        seller_id: my?.seller_id,
        user_id: my?.user_id,
        short_code: my?.short_code,
      };
      Object.assign(ctx.tokens, tokens);
      try {
        const seller = await sellerCall(ctx, '/seller/get');
        account.seller_name = seller.data?.name;
      } catch {
        // Seller name is cosmetic; the tokens are still valid.
      }
      return { tokens, account };
    },
  },

  async test(ctx) {
    try {
      requireCreds(ctx);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    if (!ctx.tokens.access_token) return { ok: false, message: 'Click Connect to authorise your Lazada seller account' };
    try {
      const data = await sellerCall(ctx, '/seller/get');
      const s = data.data ?? {};
      const name = s.name || s.name_company || 'Lazada seller';
      return {
        ok: true,
        message: `Connected to Lazada seller "${name}".`,
        account: { seller_name: name, seller_id: s.seller_id, short_code: s.short_code },
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async fetchOrders(ctx, since) {
    // 1. List orders updated after `since` (offset pagination, max 100 per page).
    const rawOrders: any[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const data = await sellerCall(ctx, '/orders/get', {
        update_after: since.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        sort_by: 'updated_at',
        sort_direction: 'ASC',
        offset,
        limit,
      });
      const page: any[] = data.data?.orders ?? [];
      rawOrders.push(...page);
      // Lazada caps offset-based paging (~5000 rows); for larger backlogs sync more often.
      if (page.length < limit) break;
    }

    // 2. Fetch items for up to 50 orders per call (GetMultipleOrderItems).
    const itemsByOrder = new Map<string, any[]>();
    for (let i = 0; i < rawOrders.length; i += ITEMS_BATCH) {
      const ids = rawOrders.slice(i, i + ITEMS_BATCH).map((o) => o.order_id);
      const data = await sellerCall(ctx, '/orders/items/get', { order_ids: `[${ids.join(',')}]` });
      for (const row of data.data ?? []) itemsByOrder.set(String(row.order_id), row.order_items ?? []);
    }

    return rawOrders.map((o) => mapOrder(o, itemsByOrder.get(String(o.order_id)) ?? []));
  },

  // fetchReviews intentionally not implemented: Lazada's seller review APIs
  // (/review/seller/history/list → /review/seller/list/v2) require an item_id
  // per call and a short start/end time window, and their request/response
  // shape could not be verified precisely enough to ship without guessing.
  // Add it once checked against https://open.lazada.com/ (Review API).
};
