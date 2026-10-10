/**
 * Shopee Open Platform v2 (Malaysia shops).
 *
 * Docs: https://open.shopee.com/developer-guide/20 (authorisation & signing)
 *       https://open.shopee.com/documents/v2/v2.order.get_order_list
 *
 * Signing (HMAC-SHA256, lowercase hex, key = partner_key):
 *   public / auth APIs : partner_id + api_path + timestamp
 *   shop-level APIs    : partner_id + api_path + timestamp + access_token + shop_id
 * Common query params: partner_id, timestamp (unix seconds), sign
 * (+ access_token, shop_id for shop-level calls).
 */
import { createHmac } from 'node:crypto';
import type { ExternalOrder, ExternalOrderItem, ExternalReview, Provider, ProviderContext } from './types.ts';
import { ProviderError } from './types.ts';

const HOSTS = {
  live: 'https://partner.shopeemobile.com',
  sandbox: 'https://partner.test-stable.shopeemobile.com',
} as const;

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_WINDOW_S = 15 * 24 * 60 * 60; // get_order_list allows at most 15 days per request
const DETAIL_BATCH = 50; // get_order_detail accepts at most 50 order_sn per call

function host(ctx: ProviderContext): string {
  const env = (ctx.creds.ENV || 'live').trim().toLowerCase();
  return env === 'sandbox' ? HOSTS.sandbox : HOSTS.live;
}

function requireCreds(ctx: ProviderContext): { partnerId: number; partnerKey: string } {
  const partnerId = Number(ctx.creds.PARTNER_ID);
  const partnerKey = ctx.creds.PARTNER_KEY;
  if (!ctx.creds.PARTNER_ID || !Number.isFinite(partnerId) || !partnerKey) {
    throw new ProviderError('Shopee Partner ID and Partner Key are required. Add them in Settings → Integrations.');
  }
  return { partnerId, partnerKey };
}

function sign(partnerKey: string, base: string): string {
  return createHmac('sha256', partnerKey).update(base).digest('hex');
}

const num = (v: unknown): number => {
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
  return Number.isFinite(n) ? n : 0;
};

const nowS = () => Math.floor(Date.now() / 1000);

type Query = Record<string, string | number | undefined>;

function buildUrl(base: string, path: string, query: Query): string {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

async function parse(res: Response, path: string): Promise<any> {
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`Shopee ${path} returned HTTP ${res.status} with a non-JSON body.`);
  }
  // Shopee reports errors as { error: "error_xxx", message: "..." } (error is "" on success).
  if (data.error) {
    throw new ProviderError(`Shopee ${path} failed: ${data.error}${data.message ? ` — ${data.message}` : ''}`);
  }
  if (!res.ok) throw new ProviderError(`Shopee ${path} returned HTTP ${res.status}.`);
  return data;
}

/** Public / auth-level call (no shop access token). */
async function publicCall(ctx: ProviderContext, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query: Query = {}) {
  const { partnerId, partnerKey } = requireCreds(ctx);
  const timestamp = nowS();
  const url = buildUrl(host(ctx), path, {
    ...query,
    partner_id: partnerId,
    timestamp,
    sign: sign(partnerKey, `${partnerId}${path}${timestamp}`),
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (e) {
    throw new ProviderError(`Could not reach Shopee (${(e as Error).message}).`);
  }
  return parse(res, path);
}

/** Shop-level call; refreshes the access token first if needed. */
async function shopCall(ctx: ProviderContext, path: string, query: Query = {}, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  const { partnerId, partnerKey } = requireCreds(ctx);
  const accessToken = await ensureAccessToken(ctx);
  const shopId = Number(ctx.tokens.shop_id);
  const timestamp = nowS();
  const url = buildUrl(host(ctx), path, {
    ...query,
    partner_id: partnerId,
    timestamp,
    access_token: accessToken,
    shop_id: shopId,
    sign: sign(partnerKey, `${partnerId}${path}${timestamp}${accessToken}${shopId}`),
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (e) {
    throw new ProviderError(`Could not reach Shopee (${(e as Error).message}).`);
  }
  return parse(res, path);
}

/**
 * Returns a valid access token, refreshing via /api/v2/auth/access_token/get
 * when it expires within 5 minutes. Shopee rotates the refresh token on every
 * refresh (access token ~4h, refresh token ~30 days), so both are saved.
 */
export async function ensureAccessToken(ctx: ProviderContext): Promise<string> {
  const { access_token, refresh_token, shop_id, expire_at } = ctx.tokens;
  if (!access_token || !shop_id) throw new ProviderError('Click Connect to authorise your Shopee shop');
  if (expire_at && Number(expire_at) - Date.now() > REFRESH_MARGIN_MS) return access_token;
  if (!refresh_token) throw new ProviderError('Shopee session expired. Click Connect to authorise your Shopee shop again.');

  const { partnerId } = requireCreds(ctx);
  let data: any;
  try {
    data = await publicCall(ctx, 'POST', '/api/v2/auth/access_token/get', {
      refresh_token,
      partner_id: partnerId,
      shop_id: Number(shop_id),
    });
  } catch (e) {
    throw new ProviderError(`${(e as Error).message} Click Connect to authorise your Shopee shop again.`);
  }
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token,
    shop_id: Number(shop_id),
    expire_at: Date.now() + num(data.expire_in) * 1000,
  };
  await ctx.saveTokens(tokens);
  Object.assign(ctx.tokens, tokens);
  return tokens.access_token;
}

async function getShopInfo(ctx: ProviderContext): Promise<{ shop_name: string; shop_id: number; region?: string }> {
  const data = await shopCall(ctx, '/api/v2/shop/get_shop_info');
  // get_shop_info returns its fields at the top level (not under `response`); accept both.
  const info = data.response ?? data;
  return { shop_name: info.shop_name ?? 'Shopee shop', shop_id: Number(ctx.tokens.shop_id), region: info.region };
}

function mapOrder(o: any): ExternalOrder {
  const status = String(o.order_status ?? '').toUpperCase();
  const itemsBySku = new Map<string, ExternalOrderItem>();
  for (const it of o.item_list ?? []) {
    const sku = String(it.model_sku || it.item_sku || it.item_id);
    const name = it.model_name ? `${it.item_name} (${it.model_name})` : String(it.item_name ?? sku);
    const qty = num(it.model_quantity_purchased) || 1;
    const price = num(it.model_discounted_price ?? it.model_original_price);
    const key = `${sku}|${price}`;
    const prev = itemsBySku.get(key);
    if (prev) prev.quantity += qty;
    else itemsBySku.set(key, { sku, name, quantity: qty, unitPrice: price });
  }
  const addr = o.recipient_address ?? {};
  const cancelled = status === 'CANCELLED' || status === 'IN_CANCEL';
  // Payment status: UNPAID → pending. TO_RETURN means a return/refund request is
  // in progress (not necessarily completed), so it stays 'paid'; Shopee's order
  // status alone does not tell us a refund was completed (that lives in the
  // returns API), so 'refunded' is not inferred here.
  const paymentStatus: ExternalOrder['paymentStatus'] = status === 'UNPAID' ? 'pending' : 'paid';
  return {
    externalId: String(o.order_sn),
    orderNumber: String(o.order_sn),
    date: new Date(num(o.create_time) * 1000).toISOString(),
    // Shopee masks buyer identity for privacy (e.g. "j*****n"); we keep what is returned.
    customerName: String(addr.name || o.buyer_username || 'Shopee buyer'),
    customerPhone: addr.phone || undefined,
    shippingAddress: addr.full_address || undefined,
    shippingPostcode: addr.zipcode || undefined,
    items: [...itemsBySku.values()],
    total: num(o.total_amount),
    paymentStatus,
    cancelled,
    shipped: ['SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED'].includes(status),
    paymentMethod: o.payment_method || undefined,
  };
}

export const shopee: Provider = {
  id: 'shopee',
  label: 'Shopee',
  category: 'E-commerce & marketplaces',
  description: 'Import Shopee Malaysia orders and buyer reviews via the Shopee Open Platform.',
  docs: 'https://open.shopee.com/',
  fields: [
    { key: 'PARTNER_ID', label: 'Partner ID', env: 'SHOPEE_PARTNER_ID', secret: false, placeholder: '2001234' },
    { key: 'PARTNER_KEY', label: 'Partner Key', env: 'SHOPEE_PARTNER_KEY', secret: true },
    {
      key: 'ENV',
      label: 'Environment',
      env: 'SHOPEE_ENV',
      secret: false,
      placeholder: 'live',
      help: 'Optional. "live" (default) or "sandbox" for the Shopee test-stable environment.',
    },
  ],

  oauth: {
    authorizeUrl(ctx, redirectUri, state) {
      const { partnerId, partnerKey } = requireCreds(ctx);
      const path = '/api/v2/shop/auth_partner';
      const timestamp = nowS();
      // Shopee has no `state` parameter, so carry it on the redirect URL itself.
      const redirect = new URL(redirectUri);
      redirect.searchParams.set('state', state);
      return buildUrl(host(ctx), path, {
        partner_id: partnerId,
        timestamp,
        sign: sign(partnerKey, `${partnerId}${path}${timestamp}`),
        redirect: redirect.toString(),
      });
    },

    async exchange(ctx, query) {
      const { partnerId } = requireCreds(ctx);
      const code = query.code;
      const shopId = Number(query.shop_id);
      if (!code) throw new ProviderError('Shopee did not return an authorisation code.');
      if (!query.shop_id || !Number.isFinite(shopId)) {
        // main_account_id is returned instead when a merchant (CB/main) account authorises.
        throw new ProviderError('Shopee did not return a shop_id. Authorise an individual shop rather than a main account.');
      }
      const data = await publicCall(ctx, 'POST', '/api/v2/auth/token/get', { code, shop_id: shopId, partner_id: partnerId });
      const tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        shop_id: shopId,
        expire_at: Date.now() + num(data.expire_in) * 1000,
      };
      Object.assign(ctx.tokens, tokens);
      const info = await getShopInfo(ctx);
      return { tokens, account: { shop_name: info.shop_name, shop_id: shopId } };
    },
  },

  async test(ctx) {
    try {
      requireCreds(ctx);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    if (!ctx.tokens.access_token || !ctx.tokens.shop_id) {
      return { ok: false, message: 'Click Connect to authorise your Shopee shop' };
    }
    try {
      const info = await getShopInfo(ctx);
      return {
        ok: true,
        message: `Connected to Shopee shop "${info.shop_name}".`,
        account: { shop_name: info.shop_name, shop_id: info.shop_id },
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async fetchOrders(ctx, since) {
    // 1. Collect order_sn values updated in [since, now], in ≤15-day windows.
    const orderSns: string[] = [];
    const seen = new Set<string>();
    const end = nowS();
    let from = Math.floor(since.getTime() / 1000);
    while (from < end) {
      const to = Math.min(from + MAX_WINDOW_S, end);
      let cursor = '';
      for (;;) {
        const data = await shopCall(ctx, '/api/v2/order/get_order_list', {
          time_range_field: 'update_time',
          time_from: from,
          time_to: to,
          page_size: 100,
          cursor,
        });
        const r = data.response ?? {};
        for (const o of r.order_list ?? []) {
          const sn = String(o.order_sn);
          if (!seen.has(sn)) {
            seen.add(sn);
            orderSns.push(sn);
          }
        }
        if (!r.more || !r.next_cursor) break;
        cursor = String(r.next_cursor);
      }
      from = to;
    }

    // 2. Fetch details in batches of 50.
    const orders: ExternalOrder[] = [];
    for (let i = 0; i < orderSns.length; i += DETAIL_BATCH) {
      const batch = orderSns.slice(i, i + DETAIL_BATCH);
      const data = await shopCall(ctx, '/api/v2/order/get_order_detail', {
        order_sn_list: batch.join(','),
        response_optional_fields: 'buyer_username,recipient_address,item_list,total_amount,payment_method,order_status,create_time',
      });
      for (const o of data.response?.order_list ?? []) orders.push(mapOrder(o));
    }
    return orders;
  },

  async fetchReviews(ctx, since) {
    // /api/v2/product/get_comment without item_id returns comments across the
    // whole shop. The docs do not guarantee ordering, so we page through all of
    // them (capped) and filter by create_time.
    const sinceS = Math.floor(since.getTime() / 1000);
    const reviews: ExternalReview[] = [];
    let cursor = '';
    for (let page = 0; page < 200; page++) {
      const data = await shopCall(ctx, '/api/v2/product/get_comment', { cursor, page_size: 100 });
      const r = data.response ?? {};
      for (const c of r.item_comment_list ?? []) {
        const created = num(c.create_time);
        if (created < sinceS) continue;
        reviews.push({
          externalId: String(c.comment_id),
          customerName: String(c.buyer_username || 'Shopee buyer'),
          rating: num(c.rating_star),
          text: String(c.comment ?? ''),
          date: new Date(created * 1000).toISOString(),
          sku: c.item_id != null ? String(c.item_id) : undefined,
        });
      }
      if (!r.more || !r.next_cursor) break;
      cursor = String(r.next_cursor);
    }
    return reviews;
  },
};
