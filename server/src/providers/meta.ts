import type { ContentItem } from '../../../src/lib/db/types.ts';
import type { Provider, ProviderContext } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * Meta (Facebook Page + Instagram Business) publishing through the Graph API.
 * Uses a Page access token, which the owner generates for their own Page in
 * Meta for Developers (Graph API Explorer → pages_manage_posts,
 * instagram_content_publish). Posts only go out after approval.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(ctx: ProviderContext, method: 'GET' | 'POST', path: string, params: Record<string, string> = {}) {
  if (!ctx.creds.PAGE_TOKEN || !ctx.creds.PAGE_ID) {
    throw new ProviderError('Meta is not connected. Add your Page ID and Page access token in Settings → Integrations.');
  }
  const qs = new URLSearchParams({ ...params, access_token: ctx.creds.PAGE_TOKEN });
  const res = await fetch(method === 'GET' ? `${GRAPH}${path}?${qs}` : `${GRAPH}${path}`, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    body: method === 'POST' ? qs : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || data.error) throw new ProviderError(`Meta: ${data.error?.message ?? `HTTP ${res.status}`}`);
  return data;
}

async function igAccountId(ctx: ProviderContext): Promise<string> {
  if (ctx.creds.IG_USER_ID) return ctx.creds.IG_USER_ID;
  const page = await graph(ctx, 'GET', `/${ctx.creds.PAGE_ID}`, { fields: 'instagram_business_account' });
  const id = page.instagram_business_account?.id;
  if (!id) throw new ProviderError('This Facebook Page has no Instagram Business account linked.');
  return id;
}

/** Publish an approved content item. Returns the platform post id. */
export async function publishContent(ctx: ProviderContext, c: ContentItem): Promise<{ postId: string; url?: string }> {
  const text = c.body || c.title;
  if (c.platform === 'Facebook') {
    if (c.imageUrl) {
      const r = await graph(ctx, 'POST', `/${ctx.creds.PAGE_ID}/photos`, { url: c.imageUrl, caption: text });
      return { postId: String(r.post_id ?? r.id), url: `https://www.facebook.com/${r.post_id ?? r.id}` };
    }
    const r = await graph(ctx, 'POST', `/${ctx.creds.PAGE_ID}/feed`, { message: text });
    return { postId: String(r.id), url: `https://www.facebook.com/${r.id}` };
  }
  if (c.platform === 'Instagram') {
    if (!c.imageUrl) throw new ProviderError('Instagram posts need a public image URL. Add one to the content item.');
    const ig = await igAccountId(ctx);
    const container = await graph(ctx, 'POST', `/${ig}/media`, { image_url: c.imageUrl, caption: text });
    // Containers can take a few seconds to process before publishing.
    for (let i = 0; i < 10; i++) {
      const st = await graph(ctx, 'GET', `/${container.id}`, { fields: 'status_code' });
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR') throw new ProviderError('Instagram could not process the image.');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const r = await graph(ctx, 'POST', `/${ig}/media_publish`, { creation_id: container.id });
    return { postId: String(r.id) };
  }
  throw new ProviderError(`Publishing to ${c.platform} is not supported yet; publish it manually and mark it published.`);
}

export const meta: Provider = {
  id: 'meta',
  label: 'Facebook & Instagram',
  category: 'Marketing',
  description: 'Publish approved posts to your Facebook Page and Instagram Business account.',
  docs: 'https://developers.facebook.com/docs/pages-api/posts',
  fields: [
    { key: 'PAGE_ID', label: 'Facebook Page ID', env: 'META_PAGE_ID', secret: false },
    { key: 'PAGE_TOKEN', label: 'Page access token', env: 'META_PAGE_TOKEN', secret: true, help: 'Long-lived Page token with pages_manage_posts (and instagram_content_publish for Instagram).' },
    { key: 'IG_USER_ID', label: 'Instagram account ID', env: 'META_IG_USER_ID', secret: false, help: 'Optional. Found automatically from the Page if left empty.' },
  ],
  async test(ctx) {
    try {
      const page = await graph(ctx, 'GET', `/${ctx.creds.PAGE_ID}`, { fields: 'name,instagram_business_account{username}' });
      const ig = page.instagram_business_account?.username;
      return { ok: true, message: `Connected to Page "${page.name}"${ig ? ` and Instagram @${ig}` : ' (no Instagram linked)'}.`, account: { page: page.name, instagram: ig ?? null } };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
};
