import { useEffect, useRef, useState } from 'react';
import { Download, Film, Loader2, RotateCcw } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { getSupabase } from '@/lib/db/supabase';
import { newId } from '@/lib/db/defaults';
import { Button } from '@/components/ui/button';

export interface VideoScene {
  caption: string;
  imageUrl: string;
  seconds: number;
}

export interface VideoPlan {
  contentId: string;
  engine?: 'kling' | 'slideshow';
  title: string;
  aspect: '9:16' | '1:1' | '16:9';
  scenes: VideoScene[];
}

export const isVideoUrl = (u: string | null | undefined) => Boolean(u && /\.(webm|mp4|mov)(\?|#|$)/i.test(u));

const SIZE: Record<VideoPlan['aspect'], [number, number]> = { '9:16': [720, 1280], '1:1': [720, 720], '16:9': [1280, 720] };
const FPS = 30;
const FADE = 0.5; // seconds of cross-fade between scenes

// Renders started in this browser session, so re-opening a chat doesn't render twice.
const started = new Set<string>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('A scene image could not be loaded.'));
    img.src = url;
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function drawScene(ctx: CanvasRenderingContext2D, img: HTMLImageElement, caption: string, t: number, alpha: number) {
  const { width: W, height: H } = ctx.canvas;
  // Slow zoom ("Ken Burns") so stills feel like motion.
  const zoom = 1 + 0.12 * t;
  const scale = Math.max(W / img.width, H / img.height) * zoom;
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2 - 20 * t, w, h);
  if (caption) {
    const size = Math.round(W * 0.058);
    ctx.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrap(ctx, caption, W * 0.84);
    const lh = size * 1.25;
    const boxH = lines.length * lh + size;
    const y0 = H * 0.78 - boxH / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(W * 0.05, y0, W * 0.9, boxH, size * 0.4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + size / 2 + lh * i + lh / 2));
  }
  ctx.globalAlpha = 1;
}

function pickMime(): { mime: string; ext: string } {
  const options = [
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  return options.find((o) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(o.mime)) ?? { mime: '', ext: 'webm' };
}

/** Turns a scene list into a real video file in the browser, then saves it on the content draft. */
async function renderVideo(plan: VideoPlan, canvas: HTMLCanvasElement, onProgress: (p: number) => void): Promise<{ blob: Blob; ext: string }> {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('This browser cannot record video. Use Chrome or Edge.');
  const [W, H] = SIZE[plan.aspect] ?? SIZE['9:16'];
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const images = await Promise.all(plan.scenes.map((s) => loadImage(s.imageUrl)));
  const starts: number[] = [];
  let total = 0;
  for (const s of plan.scenes) {
    starts.push(total);
    total += Math.max(1.5, s.seconds || 3);
  }

  const { mime, ext } = pickMime();
  const stream = canvas.captureStream(FPS);
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((ok) => (rec.onstop = () => ok()));

  const frame = (time: number) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    let i = 0;
    for (let k = 0; k < starts.length; k++) if (starts[k] <= time) i = k;
    const len = Math.max(1.5, plan.scenes[i].seconds || 3);
    const local = (time - starts[i]) / len;
    drawScene(ctx, images[i], plan.scenes[i].caption, local, 1);
    const toEnd = starts[i] + len - time;
    if (i + 1 < images.length && toEnd < FADE) {
      drawScene(ctx, images[i + 1], plan.scenes[i + 1].caption, 0, 1 - toEnd / FADE);
    }
  };

  frame(0);
  rec.start(250);
  const t0 = performance.now();
  await new Promise<void>((ok) => {
    const timer = setInterval(() => {
      const time = (performance.now() - t0) / 1000;
      if (time >= total) {
        clearInterval(timer);
        frame(total - 0.001);
        ok();
        return;
      }
      frame(time);
      onProgress(time / total);
    }, 1000 / FPS);
  });
  rec.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  return { blob: new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' }), ext };
}

export function VideoMaker({ plan }: { plan: VideoPlan }) {
  const { db, business, run } = useBizPilot();
  const canvas = useRef<HTMLCanvasElement>(null);
  const item = db.contentItems.find((c) => c.id === plan.contentId);
  const saved = isVideoUrl(item?.imageUrl) ? item!.imageUrl : null;
  const [state, setState] = useState<'idle' | 'rendering' | 'saving' | 'done' | 'error'>(saved ? 'done' : 'idle');
  const [progress, setProgress] = useState(0);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [ext, setExt] = useState('mp4');
  const [error, setError] = useState('');

  const start = async () => {
    if (!canvas.current) return;
    started.add(plan.contentId);
    setError('');
    setState('rendering');
    try {
      const out = await renderVideo(plan, canvas.current, setProgress);
      setExt(out.ext);
      setLocalUrl(URL.createObjectURL(out.blob));
      setState('saving');
      const supa = getSupabase();
      if (supa && business) {
        const path = `${business.id}/video-${newId()}.${out.ext}`;
        const { error: e } = await supa.storage.from('marketing-media').upload(path, out.blob, { contentType: out.blob.type, upsert: false });
        if (e) throw new Error(/bucket/i.test(e.message) ? 'The video is ready to download, but saving needs the marketing-media storage set up (DEPLOY.md).' : e.message);
        const url = supa.storage.from('marketing-media').getPublicUrl(path).data.publicUrl;
        run((d) => {
          const c = d.contentItems.find((x) => x.id === plan.contentId);
          if (c) c.imageUrl = url;
        }, 'Video saved on the draft');
      }
      setState('done');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  // Render automatically the first time the plan is shown.
  useEffect(() => {
    if (plan.scenes.length && !saved && !started.has(plan.contentId)) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const src = localUrl ?? saved;
  const portrait = plan.aspect === '9:16';
  if (!plan.scenes.length) {
    // Kling AI makes the video on the server; the draft updates when it is done.
    return (
      <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
          <Film className="h-4 w-4 text-teal-700" /> {plan.title}
        </div>
        {saved ? (
          <>
            <video src={saved} controls playsInline className={`${portrait ? 'max-h-96' : 'max-h-72'} max-w-full rounded-md border bg-black`} />
            <Button size="sm" variant="outline" className="mt-2" asChild>
              <a href={saved} download target="_blank" rel="noreferrer">
                <Download className="mr-1 h-4 w-4" /> Download
              </a>
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Kling AI is making this video, usually 2 to 6 minutes. It appears here and on the draft when ready.
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
        <Film className="h-4 w-4 text-teal-700" /> {plan.title}
      </div>
      <canvas ref={canvas} className={state === 'rendering' ? `${portrait ? 'max-h-96' : 'max-h-72'} max-w-full rounded-md border` : 'hidden'} />
      {state === 'rendering' && (
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering video {Math.round(progress * 100)}%. Keep this tab open.
        </div>
      )}
      {state === 'saving' && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving the video on the draft…
        </div>
      )}
      {src && state !== 'rendering' && (
        <video src={src} controls playsInline className={`${portrait ? 'max-h-96' : 'max-h-72'} max-w-full rounded-md border bg-black`} />
      )}
      {state === 'error' && <div className="mt-2 text-xs text-red-600">{error}</div>}
      <div className="mt-2 flex flex-wrap gap-2">
        {src && (
          <Button size="sm" variant="outline" asChild>
            <a href={src} download={`${plan.title.replace(/[^\w-]+/g, '_')}.${saved && !localUrl ? (saved.split('.').pop() ?? 'mp4') : ext}`} target="_blank" rel="noreferrer">
              <Download className="mr-1 h-4 w-4" /> Download
            </a>
          </Button>
        )}
        {(state === 'error' || state === 'idle' || state === 'done') && (
          <Button size="sm" variant="ghost" onClick={() => void start()}>
            <RotateCcw className="mr-1 h-4 w-4" /> {state === 'idle' ? 'Render video' : 'Render again'}
          </Button>
        )}
      </div>
    </div>
  );
}
