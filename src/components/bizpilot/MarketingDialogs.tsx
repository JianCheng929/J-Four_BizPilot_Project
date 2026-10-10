import { useEffect, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
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
