import { createHmac } from 'node:crypto';
import * as ops from '../../../src/lib/ops.ts';
import { supabaseAdmin } from './supabase.ts';
import { withBusiness } from './workspace.ts';

/**
 * Kling AI text-to-video (real motion video, blueprint C5).
 *
 * Needs KLING_ACCESS_KEY and KLING_SECRET_KEY on the server (Kling developer
 * console → API keys; video generation uses paid Kling API credits).
 * Optional: KLING_API_BASE (default https://api-singapore.klingai.com),
 * KLING_MODEL (default kling-v1-6), KLING_MODE (std | pro, default std).
 */

export const klingConfigured = () => Boolean(process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY);

const base = () => (process.env.KLING_API_BASE || 'https://api-singapore.klingai.com').replace(/\/+$/, '');
const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function token(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: process.env.KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 }));
  const sig = createHmac('sha256', process.env.KLING_SECRET_KEY!).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: any };
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`Kling: ${json.message || `HTTP ${res.status}`}${res.status === 401 ? ' (check KLING_ACCESS_KEY / KLING_SECRET_KEY)' : ''}`);
  }
  return json.data ?? {};
}

export async function startKlingVideo(prompt: string, aspect: '9:16' | '1:1' | '16:9', seconds: 5 | 10): Promise<string> {
  const data = await call('/v1/videos/text2video', {
    method: 'POST',
    body: JSON.stringify({
      model_name: process.env.KLING_MODEL || 'kling-v1-6',
      mode: process.env.KLING_MODE || 'std',
      prompt: prompt.slice(0, 2400),
      negative_prompt: 'text, watermark, logo, blurry, distorted hands, deformed product',
      aspect_ratio: aspect,
      duration: String(seconds),
      cfg_scale: 0.5,
    }),
  });
  const id = data.task_id as string | undefined;
  if (!id) throw new Error('Kling did not return a task id.');
  return id;
}

/** Wait for the Kling task, store the video in Supabase Storage and put it on the content draft. */
export async function finishKlingVideo(businessId: string, taskId: string, contentId: string, title: string) {
  const deadline = Date.now() + 20 * 60_000;
  let videoUrl = '';
  let failure = '';
  while (Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 15_000));
    try {
      const d = await call(`/v1/videos/text2video/${taskId}`);
      const status = String(d.task_status ?? '');
      if (status === 'succeed') {
        videoUrl = d.task_result?.videos?.[0]?.url ?? '';
        if (!videoUrl) failure = 'Kling finished without a video link.';
        break;
      }
      if (status === 'failed') {
        failure = d.task_status_msg || 'Kling could not make this video.';
        break;
      }
    } catch (e) {
      failure = (e as Error).message; // keep polling; network hiccups are common
    }
  }
  if (!videoUrl) {
    await withBusiness(businessId, (db) => ops.notify(db, `Video failed: ${title}`, failure || 'Kling took too long. Try again.', 'warning'));
    return;
  }
  // Kling links expire, so keep our own copy.
  let url = videoUrl;
  try {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
    const bytes = Buffer.from(await res.arrayBuffer());
    const path = `${businessId}/kling-${taskId}.mp4`;
    const bucket = supabaseAdmin().storage.from('marketing-media');
    const { error } = await bucket.upload(path, bytes, { contentType: 'video/mp4', upsert: true });
    if (error) throw error;
    url = bucket.getPublicUrl(path).data.publicUrl;
  } catch (e) {
    console.warn('[kling] storing video failed, using Kling link:', (e as Error).message);
  }
  await withBusiness(businessId, (db) => {
    const c = db.contentItems.find((x) => x.id === contentId);
    if (c) c.imageUrl = url;
    ops.notify(db, `Video ready: ${title}`, 'Made with Kling AI. Open Marketing Studio → Post & video drafts to watch and download it.', 'info');
    ops.audit(db, 'Kling AI', 'create', 'content', contentId, `Video generated for ${title}`);
  });
}

/** Kling (Kolors) text-to-image. Returns a temporary Kling image link. */
export async function klingImage(prompt: string, aspect: '1:1' | '4:5' | '9:16' | '16:9'): Promise<string> {
  const data = await call('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({
      model_name: process.env.KLING_IMAGE_MODEL || 'kling-v1',
      prompt: prompt.slice(0, 2400),
      negative_prompt: 'text, watermark, logo, blurry, deformed hands, extra fingers, distorted face, low quality',
      aspect_ratio: aspect === '4:5' ? '3:4' : aspect,
      n: 1,
    }),
  });
  const id = data.task_id as string | undefined;
  if (!id) throw new Error('Kling did not return a task id.');
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 4000));
    const d = await call(`/v1/images/generations/${id}`);
    if (d.task_status === 'succeed') {
      const url = d.task_result?.images?.[0]?.url;
      if (url) return url;
      throw new Error('Kling finished without an image.');
    }
    if (d.task_status === 'failed') throw new Error(d.task_status_msg || 'Kling could not make this image.');
  }
  throw new Error('Kling took too long to make the image.');
}
