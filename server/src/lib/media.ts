import { supabaseAdmin } from './supabase.ts';
import { klingConfigured, klingImage } from './kling.ts';

/**
 * AI image generation for marketing (blueprint C2/C5).
 *
 * Tries, in this order, the image models that have a key on the server:
 *   GEMINI_API_KEY   Google Gemini image model (default gemini-2.5-flash-image)
 *   OPENAI_API_KEY   OpenAI gpt-image-1
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN   Cloudflare Workers AI,
 *                    FLUX.1 schnell (free daily allowance, square images)
 *   KLING_ACCESS_KEY + KLING_SECRET_KEY   Kling AI (Kolors)
 *   otherwise        Pollinations (free, low quality, often rate-limited;
 *                    POLLINATIONS_TOKEN raises the limit)
 * Each image is copied into the Supabase Storage bucket `marketing-media`.
 */

export type Aspect = '1:1' | '4:5' | '9:16' | '16:9';

export interface GeneratedImage {
  url: string;
  stored: boolean;
  prompt: string;
  engine: string;
}

const QUALITY =
  ' High-end commercial advertising photo, sharp focus, realistic, natural skin and hands, professional lighting, clean background, no text, no watermark, no logo.';

interface Raw { bytes: Buffer; type: string; engine: string }

async function gemini(prompt: string, aspect: Aspect): Promise<Raw> {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY! },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Gemini: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  const part = json?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part) throw new Error('Gemini returned no image (the prompt may have been blocked).');
  return { bytes: Buffer.from(part.inlineData.data, 'base64'), type: part.inlineData.mimeType || 'image/png', engine: 'Gemini' };
}

async function openai(prompt: string, aspect: Aspect): Promise<Raw> {
  const size = aspect === '1:1' ? '1024x1024' : aspect === '16:9' ? '1536x1024' : '1024x1536';
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size, quality: process.env.OPENAI_IMAGE_QUALITY || 'medium', n: 1 }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`OpenAI: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image.');
  return { bytes: Buffer.from(b64, 'base64'), type: 'image/png', engine: 'OpenAI' };
}

async function download(url: string, engine: string): Promise<Raw> {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const type = r.headers.get('content-type') ?? '';
  if (!r.ok || !type.startsWith('image/')) throw new Error(`${engine}: image service answered ${r.status}${r.status === 402 ? ' (free limit reached)' : ''}`);
  return { bytes: Buffer.from(await r.arrayBuffer()), type, engine };
}

const cloudflareConfigured = () => Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

async function cloudflare(prompt: string): Promise<Raw> {
  const model = process.env.CLOUDFLARE_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    body: JSON.stringify({ prompt: prompt.slice(0, 2000), steps: 8 }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { image?: string }; errors?: { message?: string }[] };
  const b64 = body.result?.image;
  if (!res.ok || !b64) {
    const why = body.errors?.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare: ${why}${res.status === 429 ? ' (free daily allowance used up)' : ''}`);
  }
  return { bytes: Buffer.from(b64, 'base64'), type: 'image/jpeg', engine: 'Cloudflare FLUX' };
}

async function kling(prompt: string, aspect: Aspect): Promise<Raw> {
  return download(await klingImage(prompt, aspect), 'Kling');
}

async function pollinations(prompt: string, aspect: Aspect): Promise<Raw> {
  const [width, height] = { '1:1': [1024, 1024], '4:5': [896, 1120], '9:16': [768, 1344], '16:9': [1344, 768] }[aspect];
  const params = new URLSearchParams({ width: String(width), height: String(height), model: 'flux', nologo: 'true', seed: String(Math.floor(Math.random() * 1e9)) });
  if (process.env.POLLINATIONS_TOKEN) params.set('token', process.env.POLLINATIONS_TOKEN);
  const enc = encodeURIComponent(prompt.slice(0, 700)).replace(/[()!'*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  let last: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await download(`https://image.pollinations.ai/prompt/${enc}?${params}`, 'Free image service');
    } catch (e) {
      last = e as Error;
      await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1)));
    }
  }
  throw new Error(`${last?.message}. For reliable, high-quality images add CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (free) or GEMINI_API_KEY on the server.`);
}

export function imageEngines(): string[] {
  const e: string[] = [];
  // Best quality first; when one fails (quota, outage) the next one is tried.
  if (process.env.GEMINI_API_KEY) e.push('gemini');
  if (process.env.OPENAI_API_KEY) e.push('openai');
  if (cloudflareConfigured()) e.push('cloudflare');
  if (klingConfigured()) e.push('kling');
  e.push('pollinations');
  return e;
}

const RUN: Record<string, (p: string, a: Aspect) => Promise<Raw>> = { cloudflare, gemini, openai, kling, pollinations };

export async function generateImage(businessId: string, prompt: string, aspect: Aspect = '1:1'): Promise<GeneratedImage> {
  const clean = prompt.replace(/\s+/g, ' ').trim().slice(0, 1800);
  if (clean.length < 3) throw new Error('Describe the image to generate.');
  const full = clean + QUALITY;
  const errors: string[] = [];
  let raw: Raw | null = null;
  for (const engine of imageEngines()) {
    try {
      raw = await RUN[engine](full, aspect);
      break;
    } catch (e) {
      errors.push((e as Error).message);
      console.warn(`[media] ${engine} failed:`, (e as Error).message);
    }
  }
  if (!raw) throw new Error(`Image generation failed: ${errors.join(' | ')}`);

  const ext = raw.type.includes('png') ? 'png' : raw.type.includes('webp') ? 'webp' : 'jpg';
  const path = `${businessId}/ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bucket = supabaseAdmin().storage.from('marketing-media');
  const { error } = await bucket.upload(path, raw.bytes, { contentType: raw.type, upsert: false });
  if (error) throw new Error(`Image made but not saved (${error.message}). Run supabase/marketing-media.sql in Supabase.`);
  return { url: bucket.getPublicUrl(path).data.publicUrl, stored: true, prompt: clean, engine: raw.engine };
}
