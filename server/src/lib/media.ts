import { supabaseAdmin } from './supabase.ts';

/**
 * AI image generation for marketing (blueprint C2/C5).
 *
 * Images come from Pollinations (FLUX model): free, no API key. Set
 * POLLINATIONS_TOKEN on the server for higher rate limits. Each image is
 * copied into the Supabase Storage bucket `marketing-media` so its link
 * never changes; if the bucket is missing, the generator link is used.
 */

export type Aspect = '1:1' | '4:5' | '9:16' | '16:9';

const SIZES: Record<Aspect, [number, number]> = {
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
};

export interface GeneratedImage {
  url: string;
  stored: boolean;
  prompt: string;
  width: number;
  height: number;
}

export async function generateImage(businessId: string, prompt: string, aspect: Aspect = '1:1', seed?: number): Promise<GeneratedImage> {
  const clean = prompt.replace(/\s+/g, ' ').trim().slice(0, 900);
  if (clean.length < 3) throw new Error('Describe the image to generate.');
  const [width, height] = SIZES[aspect] ?? SIZES['1:1'];
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: 'flux',
    nologo: 'true',
    private: 'true',
    enhance: 'true',
    seed: String(seed ?? Math.floor(Math.random() * 1_000_000_000)),
  });
  if (process.env.POLLINATIONS_TOKEN) params.set('token', process.env.POLLINATIONS_TOKEN);
  const source = `https://image.pollinations.ai/prompt/${encodeURIComponent(clean).replace(/[()!'*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}?${params}`;

  let res: Response | null = null;
  let lastError = '';
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    try {
      const r = await fetch(source, { signal: AbortSignal.timeout(120_000) });
      const type = r.headers.get('content-type') ?? '';
      if (r.ok && type.startsWith('image/')) res = r;
      else lastError = `image service answered ${r.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (!res && attempt < 2) await new Promise((ok) => setTimeout(ok, 3000 * (attempt + 1)));
  }
  if (!res) throw new Error(`Image generation failed (${lastError}). Try again in a minute.`);

  const type = res.headers.get('content-type') ?? 'image/jpeg';
  const bytes = Buffer.from(await res.arrayBuffer());
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const path = `${businessId}/ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  // The public generator link (without the private token) is the fallback.
  const publicSource = source.replace(/&token=[^&]*/, '');
  try {
    const bucket = supabaseAdmin().storage.from('marketing-media');
    const { error } = await bucket.upload(path, bytes, { contentType: type, upsert: false });
    if (error) throw error;
    return { url: bucket.getPublicUrl(path).data.publicUrl, stored: true, prompt: clean, width, height };
  } catch (e) {
    console.warn('[media] storing image failed, using generator link:', (e as Error).message);
    return { url: publicSource, stored: false, prompt: clean, width, height };
  }
}
