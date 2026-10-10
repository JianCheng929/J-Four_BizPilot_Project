import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Reads the owner's own business website (Settings → Integrations → Your own website)
 * so the agent can copy its products, stock, prices, orders and delivery options into BizPilot.
 * Only the saved site is ever fetched, never private or internal addresses.
 */

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;

/** Common places a shop exposes its data: custom JSON APIs, Shopify, WooCommerce. */
export const CANDIDATE_PATHS = [
  '/api', '/api/shop', '/api/store', '/api/info', '/api/products', '/api/items', '/api/catalog', '/api/stock', '/api/inventory',
  '/api/orders', '/api/sales', '/api/customers', '/api/suppliers', '/api/prices', '/api/pricing', '/api/shipping',
  '/api/logistics', '/api/deliveries', '/api/couriers', '/api/categories', '/api/reviews', '/api/agent/summary',
  '/products.json', '/wp-json/wc/store/v1/products', '/wp-json/wc/store/products',
];

export function siteOrigin(raw: string): URL {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new Error('That website address is not valid. Use something like https://myshop.com');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The website must start with http:// or https://');
  return new URL(u.origin);
}

function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? privateIp(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function assertPublic(host: string) {
  if (process.env.SITE_READER_ALLOW_PRIVATE === '1') return; // local development and tests only
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('BizPilot can only read public websites, not local or private addresses.');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new Error(`Can't find the website ${host}. Check the address, and that the site is running.`); });
  if (addrs.some((a) => privateIp(a.address))) throw new Error('BizPilot can only read public websites, not local or private addresses.');
}

export interface SitePage {
  path: string;
  status: number;
  type: 'json' | 'html' | 'text';
  json?: unknown;
  text?: string;
}

/** Fetches one path on the owner's site (same site only, redirects included). */
export async function fetchSitePath(site: string, path: string, apiKey?: string): Promise<SitePage> {
  const origin = siteOrigin(site);
  let url = new URL(path || '/', origin);
  for (let hop = 0; hop < 4; hop++) {
    if (url.origin !== origin.origin) throw new Error('BizPilot only reads pages on your own website.');
    await assertPublic(url.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json, text/html;q=0.9, */*;q=0.5', 'User-Agent': 'BizPilot-SiteReader/1.0', ...(apiKey ? { Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey } : {}) },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const body = buf.subarray(0, MAX_BYTES).toString('utf8');
    const ctype = res.headers.get('content-type') ?? '';
    const p = url.pathname + url.search;
    if (/json/i.test(ctype) || /^\s*[[{]/.test(body)) {
      try { return { path: p, status: res.status, type: 'json', json: JSON.parse(body) }; } catch { /* not JSON after all */ }
    }
    return /html/i.test(ctype) || /<html|<body|<div/i.test(body)
      ? { path: p, status: res.status, type: 'html', text: body }
      : { path: p, status: res.status, type: 'text', text: body };
  }
  throw new Error('The website redirected too many times.');
}

/** Visible text of an HTML page (scripts, styles and tags removed). */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Same-site links and API paths mentioned in a page or its inline scripts. */
export function linksIn(html: string, origin: URL): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/(?:href|src|action)\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], origin);
      if (u.origin === origin.origin && !/\.(css|js|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)(\?|$)/i.test(u.pathname)) found.add(u.pathname + u.search);
    } catch { /* ignore */ }
  }
  for (const m of html.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/]+)/g)) found.add(m[1]);
  return [...found].slice(0, 60);
}

/** A short picture of a JSON response: counts, field names and a few example rows. */
export function describeJson(json: unknown): unknown {
  const list = Array.isArray(json) ? json : json && typeof json === 'object'
    ? Object.values(json as Record<string, unknown>).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object') as unknown[] | undefined
    : undefined;
  if (list) {
    const fields = [...new Set(list.slice(0, 20).flatMap((r) => (r && typeof r === 'object' ? Object.keys(r as object) : [])))];
    return { rows: list.length, fields, examples: list.slice(0, 3) };
  }
  const text = JSON.stringify(json);
  return text.length > 2500 ? `${text.slice(0, 2500)}…` : json;
}

export interface SiteSurvey {
  site: string;
  title: string;
  homepageText: string;
  links: string[];
  data: Record<string, unknown>;
  notFound: number;
}

/** Looks over the whole site: its home page, links, and every data feed it answers on. */
export async function surveySite(site: string, apiKey?: string): Promise<SiteSurvey> {
  const origin = siteOrigin(site);
  const home = await fetchSitePath(origin.href, '/', apiKey);
  if (home.status >= 400) throw new Error(`The website answered HTTP ${home.status}. Check the address and that the site is running.`);
  const html = home.text ?? '';
  const links = home.type === 'html' ? linksIn(html, origin) : [];
  const paths = [...new Set([...CANDIDATE_PATHS, ...links.filter((l) => l.startsWith('/api'))])].slice(0, 45);
  const data: Record<string, unknown> = {};
  if (home.type === 'json') data['/'] = describeJson(home.json);
  let notFound = 0;
  for (let i = 0; i < paths.length; i += 8) {
    const batch = await Promise.all(paths.slice(i, i + 8).map((p) => fetchSitePath(origin.href, p, apiKey).catch(() => null)));
    for (const r of batch) {
      if (r && r.status < 400 && r.type === 'json') data[r.path] = describeJson(r.json);
      else notFound++;
    }
  }
  return {
    site: origin.origin,
    title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '',
    homepageText: home.type === 'html' ? pageText(html).slice(0, 6000) : '',
    links: links.filter((l) => !l.startsWith('/api')).slice(0, 40),
    data,
    notFound,
  };
}
