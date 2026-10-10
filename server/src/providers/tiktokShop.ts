/**
 * TikTok Shop Partner API (202309 versions), Malaysia shops.
 *
 * Docs: https://partner.tiktokshop.com/docv2/page/sign-your-api-request
 *       https://partner.tiktokshop.com/docv2/page/650aa8ccc16ffe02b8f167a0 (Search Orders 202309)
 *
 * Signing: take query params except `sign` and `access_token`, sort by key,
 * concatenate key+value, prepend the request path, append the raw JSON body
 * (when the content type is not multipart/form-data), wrap the whole string
 * with app_secret on both sides, then HMAC-SHA256 keyed with app_secret → hex.
 * The access token goes in the `x-tts-access-token` header.
 */
import { createHmac } from 'node:crypto';
import type { ExternalOrder, ExternalOrderItem, Provider, ProviderContext } from './types.ts';
import { ProviderError } from './types.ts';

const API_HOST = 'https://open-api.tiktokglobalshop.com';
const AUTH_HOST = 'https://auth.tiktok-shops.com';
const AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function requireCreds(ctx: ProviderContext): { appKey: string; appSecret: string } {
  const appKey = ctx.creds.APP_KEY;
  const appSecret = ctx.creds.APP_SECRET;
  if (!appKey || !appSecret) {
    throw new ProviderError('TikTok Shop App Key and App Secret are required. Add them in Settings → Integrations.');
  }
  return { appKey, appSecret };
}

export function signTikTok(appSecret: string, path: string, query: Record<string, string>, body?: string): string {
  const params = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${query[k]}`)
    .join('');
  const base = `${appSecret}${path}${params}${body ?? ''}${appSecret}`;
  return createHmac('sha256', appSecret).update(base, 'utf8').digest('hex');
}

const num = (v: unknown): number => {
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
  return Number.isFinite(n) ? n : 0;
};

async function parse(res: Response, label: string): Promise<any> {
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`TikTok Shop ${label} returned HTTP ${res.status} with a non-JSON body.`);
  }
  // Envelope: { code: 0, message: "Success", request_id, data }
  if (data.code !== undefined && Number(data.code) !== 0) {
    throw new ProviderError(`TikTok Shop ${label} failed: ${data.code}${data.message ? ` — ${data.message}` : ''}`);
  }
  if (!res.ok) throw new ProviderError(`TikTok Shop ${label} returned HTTP ${res.status}.`);
  return data;
}

/** Token endpoints on auth.tiktok-shops.com (unsigned; app_secret is sent as a param). */
async function tokenCall(ctx: ProviderContext, path: string, params: Record<string, string>): Promise<any> {
  const { appKey, appSecret } = requireCreds(ctx);
  const qs = new URLSearchParams({ app_key: appKey, app_secret: appSecret, ...params });
  let res: Response;
  try {
    res = await fetch(`${AUTH_HOST}${path}?${qs.toString()}`, { method: 'GET' });
  } catch (e) {
    throw new ProviderError(`Could not reach TikTok Shop (${(e as Error).message}).`);
  }
  const data = await parse(res, path);
  if (!data.data?.access_token) throw new ProviderError('TikTok Shop did not return an access token.');
  return data.data;
}

function tokensFrom(d: any) {
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    // access_token_expire_in / refresh_token_expire_in are absolute unix seconds.
    expire_at: num(d.access_token_expire_in) * 1000,
    refresh_expire_at: num(d.refresh_token_expire_in) * 1000,
    open_id: d.open_id,
    seller_name: d.seller_name,
    seller_base_region: d.seller_base_region,
  };
}

/** Returns a valid access token, refreshing via grant_type=refresh_token within 5 minutes of expiry. */
export async function ensureAccessToken(ctx: ProviderContext): Promise<string> {
  const { access_token, refresh_token, expire_at } = ctx.tokens;
  if (!access_token) throw new ProviderError('Click Connect to authorise your TikTok Shop');
  if (expire_at && Number(expire_at) - Date.now() > REFRESH_MARGIN_MS) return access_token;
  if (!refresh_token) throw new ProviderError('TikTok Shop session expired. Click Connect to authorise your shop again.');
  let d: any;
  try {
    d = await tokenCall(ctx, '/api/v2/token/refresh', { refresh_token, grant_type: 'refresh_token' });
  } catch (e) {
    throw new ProviderError(`${(e as Error).message} Click Connect to authorise your TikTok Shop again.`);
  }
  const tokens = tokensFrom(d);
  await ctx.saveTokens(tokens);
  Object.assign(ctx.tokens, tokens);
  return tokens.access_token;
}

async function apiCall(
  ctx: ProviderContext,
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string | number | undefined> = {},
  body?: Record<string, unknown>,
): Promise<any> {
  const { appKey, appSecret } = requireCreds(ctx);
  const token = await ensureAccessToken(ctx);
  const q: Record<string, string> = { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q[k] = String(v);
  const bodyStr = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
  q.sign = signTikTok(appSecret, path, q, bodyStr);
  let res: Response;
  try {
    res = await fetch(`${API_HOST}${path}?${new URLSearchParams(q).toString()}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-tts-access-token': token },
      body: bodyStr,
    });
  } catch (e) {
    throw new ProviderError(`Could not reach TikTok Shop (${(e as Error).message}).`);
  }
  return parse(res, path);
}

interface Shop {
  id: string;
  name: string;
  region: string;
  cipher: string;
  code?: string;
}

async function getShops(ctx: ProviderContext): Promise<Shop[]> {
  const data = await apiCall(ctx, 'GET', '/authorization/202309/shops');
  return (data.data?.shops ?? []).map((s: any) => ({
    id: String(s.id),
    name: String(s.name ?? ''),
    region: String(s.region ?? ''),
    cipher: String(s.cipher ?? ''),
    code: s.code,
  }));
}

/** Prefer the Malaysian shop when the seller authorised several regions. */
function pickShop(shops: Shop[]): Shop | undefined {
  return shops.find((s) => s.region.toUpperCase() === 'MY') ?? shops[0];
}

function mapOrder(o: any): ExternalOrder {
  const status = String(o.status ?? '').toUpperCase();
  // TikTok returns one line item per unit purchased; aggregate by SKU + price.
  const items = new Map<string, ExternalOrderItem>();
  for (const li of o.line_items ?? []) {
    const sku = String(li.seller_sku || li.sku_id || li.product_id || li.id);
    const price = num(li.sale_price);
    const key = `${sku}|${price}`;
    const prev = items.get(key);
    const name = li.sku_name && li.sku_name !== 'Default' ? `${li.product_name} (${li.sku_name})` : String(li.product_name ?? sku);
    if (prev) prev.quantity += 1;
    else items.set(key, { sku, name, quantity: 1, unitPrice: price });
  }
  const addr = o.recipient_address ?? {};
  return {
    externalId: String(o.id),
    orderNumber: String(o.id),
    date: new Date(num(o.create_time) * 1000).toISOString(),
    // TikTok masks buyer PII in many regions; keep what is returned.
    customerName: String(addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' ') || 'TikTok Shop buyer'),
    customerPhone: addr.phone_number || undefined,
    shippingAddress: addr.full_address || addr.address_detail || undefined,
    shippingPostcode: addr.postal_code || undefined,
    items: [...items.values()],
    total: num(o.payment?.total_amount),
    paymentStatus: status === 'UNPAID' ? 'pending' : 'paid',
    cancelled: status === 'CANCELLED',
    shipped: ['IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(status),
    paymentMethod: o.payment_method_name || undefined,
  };
}

export const tiktokShop: Provider = {
  id: 'tiktok_shop',
  label: 'TikTok Shop',
  category: 'E-commerce & marketplaces',
  description: 'Import TikTok Shop Malaysia orders via the TikTok Shop Partner API.',
  docs: 'https://partner.tiktokshop.com/docv2',
  fields: [
    { key: 'APP_KEY', label: 'App Key', env: 'TIKTOKSHOP_APP_KEY', secret: false },
    { key: 'APP_SECRET', label: 'App Secret', env: 'TIKTOKSHOP_APP_SECRET', secret: true },
    {
      key: 'SERVICE_ID',
      label: 'Service ID',
      env: 'TIKTOKSHOP_SERVICE_ID',
      secret: false,
      help: 'From Partner Center → App → Service ID, used for the authorisation link',
    },
  ],

  oauth: {
    // The redirect URL is NOT a parameter here: it must be configured on the app
    // in TikTok Shop Partner Center (set it to the BizPilot callback URL).
    authorizeUrl(ctx, _redirectUri, state) {
      const serviceId = ctx.creds.SERVICE_ID;
      if (!serviceId) throw new ProviderError('TikTok Shop Service ID is required to build the authorisation link.');
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('service_id', serviceId);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchange(ctx, query) {
      const code = query.code || query.auth_code;
      if (!code) throw new ProviderError('TikTok Shop did not return an authorisation code.');
      const d = await tokenCall(ctx, '/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' });
      const tokens: Record<string, any> = tokensFrom(d);
      Object.assign(ctx.tokens, tokens);
      const shop = pickShop(await getShops(ctx));
      if (!shop) throw new ProviderError('No TikTok Shop is linked to this authorisation.');
      tokens.shop_cipher = shop.cipher;
      tokens.shop_id = shop.id;
      tokens.shop_name = shop.name;
      Object.assign(ctx.tokens, tokens);
      return {
        tokens,
        account: { shop_name: shop.name, shop_id: shop.id, region: shop.region, seller_name: d.seller_name },
      };
    },
  },

  async test(ctx) {
    try {
      requireCreds(ctx);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    if (!ctx.tokens.access_token) return { ok: false, message: 'Click Connect to authorise your TikTok Shop' };
    try {
      const shop = pickShop(await getShops(ctx));
      if (!shop) return { ok: false, message: 'Authorised, but no TikTok Shop is linked to this account.' };
      if (shop.cipher && shop.cipher !== ctx.tokens.shop_cipher) {
        await ctx.saveTokens({ shop_cipher: shop.cipher, shop_id: shop.id, shop_name: shop.name });
      }
      return {
        ok: true,
        message: `Connected to TikTok Shop "${shop.name}" (${shop.region}).`,
        account: { shop_name: shop.name, shop_id: shop.id, region: shop.region },
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async fetchOrders(ctx, since) {
    let cipher: string | undefined = ctx.tokens.shop_cipher;
    if (!cipher) {
      const shop = pickShop(await getShops(ctx));
      if (!shop) throw new ProviderError('No TikTok Shop is linked to this authorisation.');
      cipher = shop.cipher;
      await ctx.saveTokens({ shop_cipher: shop.cipher, shop_id: shop.id, shop_name: shop.name });
    }
    const orders: ExternalOrder[] = [];
    const seen = new Set<string>();
    let pageToken = '';
    for (;;) {
      const data = await apiCall(
        ctx,
        'POST',
        '/order/202309/orders/search',
        {
          shop_cipher: cipher,
          page_size: 50,
          sort_field: 'update_time',
          sort_order: 'ASC',
          page_token: pageToken || undefined,
        },
        { update_time_ge: Math.floor(since.getTime() / 1000) },
      );
      const d = data.data ?? {};
      for (const o of d.orders ?? []) {
        const id = String(o.id);
        if (seen.has(id)) continue;
        seen.add(id);
        orders.push(mapOrder(o));
      }
      if (!d.next_page_token || !(d.orders ?? []).length) break;
      pageToken = String(d.next_page_token);
    }
    return orders;
  },

  // fetchReviews not implemented: TikTok Shop does not expose buyer product
  // reviews through a generally available Partner API endpoint for MY sellers.
};
