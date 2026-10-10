import type { Provider } from './types.ts';
import { surveySite } from '../lib/siteReader.ts';

/**
 * The owner's own business website (self-hosted shop, WooCommerce, Shopify or a custom site).
 * There is no fixed API: BizPilot's agent reads the site and copies its products, stock,
 * prices, orders and delivery options into BizPilot (skill: website-import).
 */
export const website: Provider = {
  id: 'website',
  label: 'Your own website',
  category: 'E-commerce & marketplaces',
  description: 'A shop site you already run (self-hosted, WooCommerce, Shopify or custom). BizPilot reads it and fills in your products, stock, prices, orders and delivery options by itself.',
  docs: 'https://github.com/ngweibin050-dev/BizPilot/blob/main/INTEGRATIONS_SETUP.md#your-own-website',
  fields: [
    { key: 'SITE_URL', label: 'Website address', env: 'OWN_SITE_URL', secret: false, placeholder: 'https://myshop.com', help: 'The public address of your shop site.' },
    { key: 'API_KEY', label: 'API key', env: 'OWN_SITE_API_KEY', secret: true, placeholder: '', help: 'Optional. Only if your site\'s data needs a key (sent as a Bearer token).' },
  ],
  async test(ctx) {
    try {
      const s = await surveySite(ctx.creds.SITE_URL, ctx.creds.API_KEY);
      const feeds = Object.entries(s.data).map(([p, d]) => (d && typeof d === 'object' && 'rows' in (d as object) ? `${p} (${(d as { rows: number }).rows})` : p));
      return {
        ok: true,
        message: feeds.length
          ? `Reached ${s.title || s.site}. Found ${feeds.length} data feed(s): ${feeds.slice(0, 8).join(', ')}${feeds.length > 8 ? '…' : ''}.`
          : `Reached ${s.title || s.site}. No data feeds found, so BizPilot will read the pages themselves.`,
        account: { site: s.site, title: s.title, feeds: Object.keys(s.data) },
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
};

/** The goal BizPilot's agent runs when the website is first connected or the owner clicks "Import again". */
export const WEBSITE_IMPORT_PROMPT = `My own shop website is connected in Settings → Integrations → Your own website. Load the website-import skill and copy everything useful from it into BizPilot yourself: products with prices and current stock, suppliers, all orders as sales, and delivery/logistics info. Skip anything already in BizPilot, then tell me what you brought in and what needs my approval.`;
