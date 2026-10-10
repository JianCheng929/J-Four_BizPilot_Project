import { getSupabase } from './db/supabase';

/**
 * Files the owner drops into the Command Centre. They are read here in the
 * browser (pictures shrunk to JPEG, PDF text and pages, spreadsheet rows,
 * video frames) so the small server only passes them to WorkBuddy.
 * Photos and PDFs are also kept in private storage so the agent can attach
 * them to the expense or purchase they become.
 */

export interface ChatFile {
  name: string;
  kind: 'image' | 'pdf' | 'sheet' | 'text' | 'video';
  size: number;
  text?: string;
  images: string[];
  path?: string;
  note?: string;
  /** Small preview for the message (data URL), not sent to the server */
  preview?: string;
}

export const MAX_FILES = 6;
const MAX_TEXT = 40_000;
const MAX_PDF_PAGES_AS_PICTURES = 3;
const VIDEO_FRAMES = 6;

export const ACCEPT = 'image/*,video/*,application/pdf,.csv,.xlsx,.xls,.txt,.json,.md,text/plain,text/csv';

export function kindOf(f: File): ChatFile['kind'] | null {
  const n = f.name.toLowerCase();
  if (/heic|heif/.test(f.type) || /\.(heic|heif)$/.test(n)) return null;
  if (f.type.startsWith('image/')) return 'image';
  if (f.type.startsWith('video/')) return 'video';
  if (f.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/\.(xlsx|xls|csv)$/.test(n)) return 'sheet';
  if (f.type.startsWith('text/') || /\.(txt|json|md)$/.test(n)) return 'text';
  return null;
}

function canvasJpeg(source: CanvasImageSource, w: number, h: number, max = 1568): string {
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

const base64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

async function readImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error(`${file.name}: this picture format can't be read. Send it as JPG or PNG.`);
  const url = canvasJpeg(bmp, bmp.width, bmp.height);
  bmp.close();
  return url;
}

async function readPdf(file: File): Promise<{ text: string; pages: string[]; count: number }> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let text = '';
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 30) && text.length < MAX_TEXT; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += `\n[Page ${i}]\n` + content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join('');
    if (i <= MAX_PDF_PAGES_AS_PICTURES) {
      const vp = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1400 / vp.width);
      const view = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(view.width);
      c.height = Math.round(view.height);
      await page.render({ canvasContext: c.getContext('2d')!, viewport: view }).promise;
      pages.push(canvasJpeg(c, c.width, c.height, 1600));
    }
  }
  const count = doc.numPages;
  await doc.destroy();
  return { text: text.trim().slice(0, MAX_TEXT), pages, count };
}

async function readSheet(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith('.csv')) return (await file.text()).slice(0, MAX_TEXT);
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  return wb.SheetNames.map((n) => `[Sheet ${n}]\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`).join('\n\n').slice(0, MAX_TEXT);
}

async function readVideo(file: File): Promise<{ frames: string[]; seconds: number }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  try {
    await new Promise<void>((ok, bad) => { v.onloadeddata = () => ok(); v.onerror = () => bad(new Error(`${file.name}: this video can't be played in the browser. Send it as MP4.`)); });
    const seconds = Number.isFinite(v.duration) ? v.duration : 0;
    const frames: string[] = [];
    for (let i = 0; i < VIDEO_FRAMES; i++) {
      v.currentTime = seconds ? (seconds * (i + 0.5)) / VIDEO_FRAMES : 0;
      await new Promise<void>((ok) => { v.onseeked = () => ok(); setTimeout(ok, 3000); });
      frames.push(canvasJpeg(v, v.videoWidth || 640, v.videoHeight || 360, 960));
      if (!seconds) break;
    }
    return { frames, seconds };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Keep the original photo/PDF in the business's private receipts folder (best effort). */
async function keepOriginal(businessId: string, file: File): Promise<string | undefined> {
  const supa = getSupabase();
  if (!supa || file.size > 10 * 1024 * 1024) return undefined;
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const path = `${businessId}/chat/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supa.storage.from('receipts').upload(path, file, { contentType: file.type || undefined, upsert: false });
  return error ? undefined : path;
}

export async function readChatFile(file: File, businessId: string): Promise<ChatFile> {
  const kind = kindOf(file);
  if (!kind) throw new Error(`${file.name}: send photos, videos, PDFs, spreadsheets (xlsx, csv) or text files. Word files: save as PDF first.`);
  if (file.size > 60 * 1024 * 1024) throw new Error(`${file.name} is larger than 60 MB.`);
  const base: ChatFile = { name: file.name, kind, size: file.size, images: [] };
  if (kind === 'image') {
    const img = await readImage(file);
    return { ...base, images: [base64(img)], preview: img, path: await keepOriginal(businessId, file) };
  }
  if (kind === 'pdf') {
    const { text, pages, count } = await readPdf(file);
    return {
      ...base, text: text || undefined, images: pages.map(base64), preview: pages[0], path: await keepOriginal(businessId, file),
      note: `${count} page(s)${count > pages.length ? `; pictures of the first ${pages.length}, text of all` : ''}${text ? '' : '; no text layer (scanned), read the pictures'}.`,
    };
  }
  if (kind === 'video') {
    const { frames, seconds } = await readVideo(file);
    return { ...base, images: frames.map(base64), preview: frames[0], note: `${Math.round(seconds)} s video, ${frames.length} frame(s); no sound.` };
  }
  const text = kind === 'sheet' ? await readSheet(file) : (await file.text()).slice(0, MAX_TEXT);
  return { ...base, text };
}
