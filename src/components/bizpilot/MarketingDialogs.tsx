import { useEffect, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { newId } from '@/lib/db/defaults';
import { getSupabase } from '@/lib/db/supabase';
import type { Campaign, ContentItem } from '@/lib/db/types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Field,
  NONE,
  SimpleSelect,
  dialogWide,
  fromDateInput,
  fromDateTimeInput,
  num,
  primaryBtn,
  toDateInput,
  toDateTimeInput,
} from './common';

export const PLATFORMS: ContentItem['platform'][] = ['Facebook', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn'];
export const CONTENT_TYPES: { value: ContentItem['type']; label: string }[] = [
  { value: 'post', label: 'Post' },
  { value: 'carousel', label: 'Carousel' },
  { value: 'video_script', label: 'Video script' },
  { value: 'ad', label: 'Ad' },
];
/** Platforms the server can publish to directly after approval. */
export const AUTO_PUBLISH = new Set<ContentItem['platform']>(['Facebook', 'Instagram']);

export function ContentDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item?: ContentItem | null;
}) {
  const { db, run } = useBizPilot();
  const [platform, setPlatform] = useState<ContentItem['platform']>('Facebook');
  const [type, setType] = useState<ContentItem['type']>('post');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [when, setWhen] = useState('');
  const [campaignId, setCampaignId] = useState(NONE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPlatform(item?.platform ?? 'Facebook');
    setType(item?.type ?? 'post');
    setTitle(item?.title ?? '');
    setBody(item?.body ?? '');
    setImageUrl(item?.imageUrl ?? '');
    setWhen(toDateTimeInput(item?.scheduledDate ?? new Date(Date.now() + 86400000).toISOString()));
    setCampaignId(item?.campaignId ?? NONE);
  }, [open, item]);

  const prohibited = db.settings.prohibitedClaims
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((w) => body.toLowerCase().includes(w.toLowerCase()) || title.toLowerCase().includes(w.toLowerCase()));

  const save = () => {
    if (!title.trim()) return setError('Title is required.');
    if (!body.trim()) return setError('Write the post text.');
    if (!when) return setError('Choose a scheduled date and time.');
    if (platform === 'Instagram' && !imageUrl.trim()) return setError('Instagram posts need an image URL.');
    if (imageUrl && !/^https?:\/\//i.test(imageUrl.trim())) return setError('Image URL must start with http(s)://');
    const data = {
      platform,
      type,
      title: title.trim(),
      body: body.trim(),
      imageUrl: imageUrl.trim(),
      scheduledDate: fromDateTimeInput(when),
      campaignId: campaignId === NONE ? null : campaignId,
    };
    const res = item
      ? run((d, a) => {
          const c = d.contentItems.find((x) => x.id === item.id);
          if (!c) throw new ops.OpError('Content not found.');
          if (c.status === 'published') throw new ops.OpError('Published content cannot be edited.');
          Object.assign(c, data);
          if (c.status === 'failed' || c.status === 'approved' || c.status === 'scheduled') {
            c.status = 'draft'; // edited content needs a fresh approval
            c.error = null;
          }
          ops.audit(d, a, 'update', 'content', c.id, `Content edited: ${c.title}`);
          return c;
        }, 'Content updated')
      : run((d, a) => ops.addContentItem(d, data, a), 'Draft saved');
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>{item ? 'Edit content' : 'New content'}</DialogTitle>
          <DialogDescription>
            Saved as a draft. Submit it for approval to publish
            {AUTO_PUBLISH.has(platform) ? ` — once approved, BizPilot posts it to ${platform}.` : '. This platform is posted manually after approval.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Platform">
            <SimpleSelect value={platform} onChange={(v) => setPlatform(v as ContentItem['platform'])} options={PLATFORMS.map((p) => ({ value: p, label: p }))} />
          </Field>
          <Field label="Type">
            <SimpleSelect value={type} onChange={(v) => setType(v as ContentItem['type'])} options={CONTENT_TYPES} />
          </Field>
          <Field label="Scheduled for">
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Field label="Title (internal)" className="sm:col-span-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Campaign">
            <SimpleSelect
              value={campaignId}
              onChange={setCampaignId}
              options={[{ value: NONE, label: 'None' }, ...db.campaigns.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </Field>
          <Field label={type === 'video_script' ? 'Script' : 'Post text / caption'} className="sm:col-span-3" hint={`${body.length} characters`}>
            <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {prohibited.length > 0 && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-3">
              Contains prohibited claim(s) from your brand profile: {prohibited.join(', ')}
            </div>
          )}
          <Field label="Image URL" className="sm:col-span-3" hint="Public https link to the image (required for Instagram)">
            <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
          </Field>
          {imageUrl && /^https?:\/\//i.test(imageUrl) && (
            <img src={imageUrl} alt="" className="h-28 w-28 rounded-md border object-cover sm:col-span-3" />
          )}
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            {item ? 'Save changes' : 'Save draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const OBJECTIVES: Campaign['objective'][] = ['awareness', 'traffic', 'leads', 'conversions', 'sales'];
const STATUSES: Campaign['status'][] = ['draft', 'active', 'paused', 'ended'];

interface CampForm {
  name: string;
  objective: Campaign['objective'];
  platform: string;
  budget: string;
  dailyCap: string;
  status: Campaign['status'];
  startDate: string;
  endDate: string;
  spend: string;
  clicks: string;
  impressions: string;
  conversions: string;
  revenue: string;
}

export function CampaignDialog({
  open,
  onOpenChange,
  campaign,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  campaign?: Campaign | null;
}) {
  const { run } = useBizPilot();
  const [f, setF] = useState<CampForm>({} as CampForm);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const c = campaign;
    setF({
      name: c?.name ?? '',
      objective: c?.objective ?? 'sales',
      platform: c?.platform ?? 'Facebook',
      budget: c ? String(c.budget) : '',
      dailyCap: c ? String(c.dailyCap) : '',
      status: c?.status ?? 'draft',
      startDate: toDateInput(c?.startDate),
      endDate: toDateInput(c?.endDate),
      spend: c ? String(c.spend) : '0',
      clicks: c ? String(c.clicks) : '0',
      impressions: c ? String(c.impressions) : '0',
      conversions: c ? String(c.conversions) : '0',
      revenue: c ? String(c.revenue) : '0',
    });
  }, [open, campaign]);

  const set = (k: keyof CampForm, v: string) => setF((x) => ({ ...x, [k]: v }));

  const save = () => {
    if (!f.name.trim()) return setError('Campaign name is required.');
    const nums = {
      budget: num(f.budget),
      dailyCap: num(f.dailyCap || '0'),
      spend: num(f.spend || '0'),
      clicks: num(f.clicks || '0'),
      impressions: num(f.impressions || '0'),
      conversions: num(f.conversions || '0'),
      revenue: num(f.revenue || '0'),
    };
    if (!(nums.budget >= 0)) return setError('Enter a total budget (0 or more).');
    for (const [k, v] of Object.entries(nums)) if (!(v >= 0)) return setError(`${k} must be 0 or more.`);
    if (nums.clicks > nums.impressions && nums.impressions > 0) return setError('Clicks cannot exceed impressions.');
    if (f.startDate && f.endDate && f.endDate < f.startDate) return setError('End date is before start date.');
    const data: Partial<Campaign> & { name: string } = {
      name: f.name.trim(),
      objective: f.objective,
      platform: f.platform.trim(),
      ...nums,
      status: f.status,
      startDate: f.startDate ? fromDateInput(f.startDate) : null,
      endDate: f.endDate ? fromDateInput(f.endDate) : null,
    };
    const res = run((d, a) => {
      if (campaign) {
        const c = d.campaigns.find((x) => x.id === campaign.id);
        if (!c) throw new ops.OpError('Campaign not found.');
        Object.assign(c, data);
        ops.audit(d, a, 'update', 'campaign', c.id, `Campaign updated: ${c.name}`);
        return c;
      }
      const c = ops.addCampaign(d, data, a);
      c.status = f.status;
      return c;
    }, campaign ? 'Campaign updated' : 'Campaign created');
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>{campaign ? `Edit ${campaign.name}` : 'New campaign'}</DialogTitle>
          <DialogDescription>Enter results from your ad manager to track CTR, cost per acquisition and ROAS.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Name *" className="col-span-2">
            <Input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Platform">
            <Input value={f.platform ?? ''} onChange={(e) => set('platform', e.target.value)} placeholder="Facebook, TikTok…" />
          </Field>
          <Field label="Objective">
            <SimpleSelect value={f.objective ?? 'sales'} onChange={(v) => set('objective', v)} options={OBJECTIVES.map((o) => ({ value: o, label: o[0].toUpperCase() + o.slice(1) }))} />
          </Field>
          <Field label="Total budget (RM)">
            <Input type="number" min="0" step="0.01" value={f.budget ?? ''} onChange={(e) => set('budget', e.target.value)} />
          </Field>
          <Field label="Daily cap (RM)">
            <Input type="number" min="0" step="0.01" value={f.dailyCap ?? ''} onChange={(e) => set('dailyCap', e.target.value)} />
          </Field>
          <Field label="Start">
            <Input type="date" value={f.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)} />
          </Field>
          <Field label="End">
            <Input type="date" value={f.endDate ?? ''} onChange={(e) => set('endDate', e.target.value)} />
          </Field>
          <Field label="Status">
            <SimpleSelect value={f.status ?? 'draft'} onChange={(v) => set('status', v)} options={STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} />
          </Field>
          <div className="col-span-2 mt-1 text-xs font-medium text-slate-600 sm:col-span-4">Results to date</div>
          <Field label="Spend (RM)">
            <Input type="number" min="0" step="0.01" value={f.spend ?? ''} onChange={(e) => set('spend', e.target.value)} />
          </Field>
          <Field label="Impressions">
            <Input type="number" min="0" value={f.impressions ?? ''} onChange={(e) => set('impressions', e.target.value)} />
          </Field>
          <Field label="Clicks">
            <Input type="number" min="0" value={f.clicks ?? ''} onChange={(e) => set('clicks', e.target.value)} />
          </Field>
          <Field label="Conversions">
            <Input type="number" min="0" value={f.conversions ?? ''} onChange={(e) => set('conversions', e.target.value)} />
          </Field>
          <Field label="Revenue attributed (RM)">
            <Input type="number" min="0" step="0.01" value={f.revenue ?? ''} onChange={(e) => set('revenue', e.target.value)} />
          </Field>
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            {campaign ? 'Save changes' : 'Create campaign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BrandProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { db, updateSettings } = useBizPilot();
  const pick = () => ({
    brandVoice: db.settings.brandVoice ?? '',
    targetAudience: db.settings.targetAudience ?? '',
    brandDifferentiators: db.settings.brandDifferentiators ?? '',
    brandStyle: db.settings.brandStyle ?? '',
    brandLanguages: db.settings.brandLanguages ?? '',
    brandCompetitors: db.settings.brandCompetitors ?? '',
    prohibitedClaims: db.settings.prohibitedClaims ?? '',
  });
  const [f, setF] = useState(pick);
  const set = (k: keyof ReturnType<typeof pick>) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    if (!open) return;
    setF(pick());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>Brand profile</DialogTitle>
          <DialogDescription>WorkBuddy follows this for every caption, script and ad, and checks the prohibited claims before anything is published.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Brand voice" hint="e.g. warm, playful, Manglish-friendly, no hard selling">
            <Textarea rows={3} value={f.brandVoice} onChange={set('brandVoice')} />
          </Field>
          <Field label="Target audience and customer personas">
            <Textarea rows={3} value={f.targetAudience} onChange={set('targetAudience')} />
          </Field>
          <Field label="Product benefits and differentiators" hint="Only true, provable points">
            <Textarea rows={3} value={f.brandDifferentiators} onChange={set('brandDifferentiators')} />
          </Field>
          <Field label="Visual style" hint="Colours, fonts, photo style, logo notes">
            <Textarea rows={3} value={f.brandStyle} onChange={set('brandStyle')} />
          </Field>
          <Field label="Content languages" hint="e.g. English, Malay, Chinese">
            <Input value={f.brandLanguages} onChange={set('brandLanguages')} />
          </Field>
          <Field label="Competitors" hint="Names or links, one per line">
            <Textarea rows={2} value={f.brandCompetitors} onChange={set('brandCompetitors')} />
          </Field>
          <Field label="Prohibited claims" hint="Comma separated, e.g. cure, 100% guaranteed, halal (if not certified)" className="sm:col-span-2">
            <Textarea rows={2} value={f.prohibitedClaims} onChange={set('prohibitedClaims')} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className={primaryBtn}
            onClick={() => {
              updateSettings(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()])));
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- new content: idea → WorkBuddy

const MEDIA_BUCKET = 'marketing-media';
const MAX_MEDIA_MB = 50;

/**
 * "New content" starts with the owner's idea, not a form: they describe what they
 * want, pick products and add photos or videos, and WorkBuddy either creates the
 * drafts or coaches them (hooks, captions, shot lists, AI image/video prompts).
 */
export function ContentIdeaDialog({
  open,
  onOpenChange,
  onSend,
  onManual,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSend: (goal: string) => Promise<void>;
  onManual: () => void;
}) {
  const { db, business } = useBizPilot();
  const [idea, setIdea] = useState('');
  const [productIds, setProductIds] = useState<string[]>([]);
  const [media, setMedia] = useState<{ url: string; kind: 'image' | 'video' | 'link' }[]>([]);
  const [link, setLink] = useState('');
  const [platform, setPlatform] = useState('auto');
  const [when, setWhen] = useState('');
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setIdea(''); setProductIds([]); setMedia([]); setLink(''); setPlatform('auto'); setWhen(''); setError(null);
  }, [open]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const supa = getSupabase();
    if (!supa) return setError('Uploads need Supabase. Paste a link to the photo or video instead.');
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
        if (!kind) throw new Error(`${f.name} is not a photo or video.`);
        if (f.size > MAX_MEDIA_MB * 1024 * 1024) throw new Error(`${f.name} is over ${MAX_MEDIA_MB} MB.`);
        const path = `${business.id}/${newId()}-${f.name.replace(/[^\w.-]+/g, '_')}`;
        const { error: e } = await supa.storage.from(MEDIA_BUCKET).upload(path, f, { contentType: f.type, upsert: false });
        if (e) throw new Error(/bucket/i.test(e.message) ? 'Photo uploads are not set up yet (run the marketing-media SQL in DEPLOY.md). Paste a link instead.' : e.message);
        const url = supa.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
        setMedia((m) => [...m, { url, kind }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const addLink = () => {
    const u = link.trim();
    if (!/^https?:\/\//i.test(u)) return setError('Links must start with http(s)://');
    setMedia((m) => [...m, { url: u, kind: /\.(mp4|mov|webm)(\?|$)/i.test(u) ? 'video' : /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u) ? 'image' : 'link' }]);
    setLink('');
    setError(null);
  };

  const go = async (mode: 'create' | 'help') => {
    if (!idea.trim() && !productIds.length && !media.length) return setError('Tell WorkBuddy your idea, or pick a product.');
    const products = db.products.filter((p) => productIds.includes(p.id));
    const lines = [
      'Load the marketing-content skill.',
      `The owner's content idea: ${idea.trim() || '(no text: build the idea around the products and media below)'}`,
      products.length ? `Products to feature:\n${products.map((p) => `- ${p.name} (SKU ${p.sku}, RM${p.price.toFixed(2)}, ${p.stock} in stock)${p.description ? `: ${p.description.slice(0, 300)}` : ''}`).join('\n')}` : '',
      media.length ? `Media the owner provided (their own photos/videos; use these exact links):\n${media.map((m) => `- ${m.kind}: ${m.url}`).join('\n')}` : '',
      `Platform: ${platform === 'auto' ? 'choose the best one(s) for this idea' : platform}.`,
      when ? `Post on: ${new Date(when).toISOString()} (owner's chosen date and time; schedule it exactly then).` : 'Post date: pick the best upcoming time for each platform.',
      mode === 'create'
        ? 'Create the finished content now with draft_content (requestPublish false): captions with hook, CTA and hashtags (plus a Malay version if Malay is a brand language). Use the first photo link as imageUrl. If a video was given, write the caption for it and put the video link in the body; if the idea suits a video, also create a video_script draft. In your answer, show the full text of every draft you created.'
        : "Don't create drafts. Help the owner make it themselves: 3 angles with a hook each, one ready-to-edit caption with hashtags, a shot list for their photo/video, and 3 ready-to-copy prompts for AI image or video tools (e.g. Canva, CapCut, Midjourney) describing their actual product. Keep it short and practical.",
    ].filter(Boolean);
    setSending(true);
    try {
      await onSend(lines.join('\n\n'));
      onOpenChange(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>New content</DialogTitle>
          <DialogDescription>Tell WorkBuddy your idea. Add your product and a photo or video if you have one.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Your idea">
            <Textarea rows={4} autoFocus value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="e.g. Payday promo for our beef satay, buy 2 get free peanut sauce, fun TikTok style" />
          </Field>

          {db.products.length > 0 && (
            <Field label="Products (optional)">
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {db.products.map((p) => {
                  const on = productIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setProductIds((ids) => (on ? ids.filter((x) => x !== p.id) : [...ids, p.id]))}
                      className={`rounded-full border px-3 py-1 text-xs ${on ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          <Field label="Photos or videos (optional)" hint={`Upload up to ${MAX_MEDIA_MB} MB each, or paste a link (Google Drive, YouTube, your website…).`}>
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">
                  <input type="file" accept="image/*,video/*" multiple className="hidden" disabled={uploading} onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
                  {uploading ? 'Uploading…' : 'Upload photo / video'}
                </label>
                <Input className="min-w-0 flex-1" value={link} onChange={(e) => setLink(e.target.value)} placeholder="or paste a link https://…" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }} />
                <Button type="button" variant="outline" size="sm" className="h-9" disabled={!link.trim()} onClick={addLink}>Add</Button>
              </div>
              {media.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {media.map((m, i) => (
                    <div key={m.url} className="relative">
                      {m.kind === 'image' ? (
                        <img src={m.url} alt="" className="h-20 w-20 rounded-md border object-cover" />
                      ) : m.kind === 'video' ? (
                        <video src={m.url} className="h-20 w-20 rounded-md border bg-black object-cover" muted />
                      ) : (
                        <div className="flex h-20 w-28 items-center justify-center truncate rounded-md border bg-slate-50 px-2 text-[11px] text-slate-600">{m.url.replace(/^https?:\/\//, '').slice(0, 30)}</div>
                      )}
                      <button type="button" title="Remove" onClick={() => setMedia((x) => x.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-slate-700 text-xs text-white">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Platform">
              <SimpleSelect
                value={platform}
                onChange={setPlatform}
                options={[{ value: 'auto', label: 'Let WorkBuddy choose' }, ...['Facebook', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn'].map((p) => ({ value: p, label: p }))]}
              />
            </Field>
            <Field label="Post on (optional)" hint="Leave empty and WorkBuddy picks the best time.">
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </Field>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button variant="ghost" className="text-slate-500" onClick={() => { onOpenChange(false); onManual(); }}>
            Write it myself
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={sending || uploading} onClick={() => void go('help')}>
              Help me write it
            </Button>
            <Button className={primaryBtn} disabled={sending || uploading} onClick={() => void go('create')}>
              {sending ? 'Sending…' : 'Create it for me'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
