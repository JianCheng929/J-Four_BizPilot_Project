import { AgentPanel } from '@/components/bizpilot/AgentPanel';
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, BarChart3, CalendarDays, ChevronLeft, ChevronRight, Clapperboard, ImagePlus, Megaphone, Pencil, Plus, RotateCcw, Send, Sparkles, Trash2, UserRound } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import type { Campaign, ContentItem } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/layout/AppShell';
import type { PageKey } from '@/components/layout/AppShell';
import { post } from '@/lib/api';
import { salesTotal } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { EmptyState, Kpi, Pill, SectionCard, StatusPill, primaryBtn } from '@/components/bizpilot/common';
import { AUTO_PUBLISH, BrandProfileDialog, CampaignDialog, ContentDialog, ContentIdeaDialog } from '@/components/bizpilot/MarketingDialogs';
import { hasPendingApproval } from '@/components/bizpilot/actions';
import { isVideoUrl } from '@/components/bizpilot/VideoMaker';
import { checkCompliance } from '@/lib/compliance';

const CONTENT_FILTERS = ['upcoming', 'all', 'draft', 'in_review', 'scheduled', 'published', 'failed'] as const;

function campaignMetrics(c: Campaign) {
  return {
    ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : null,
    cpa: c.conversions > 0 ? c.spend / c.conversions : null,
    roas: c.spend > 0 ? c.revenue / c.spend : null,
    used: c.budget > 0 ? c.spend / c.budget : null,
    over: c.budget > 0 && c.spend > c.budget,
  };
}

function dayKey(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA'); // yyyy-mm-dd local
}

const TYPE_FILTERS = [
  ['all', 'All drafts'],
  ['post', 'Posts'],
  ['carousel', 'Carousels'],
  ['video_script', 'Video scripts'],
  ['ad', 'Ads'],
] as const;

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function Marketing({ onNavigate }: { onNavigate?: (p: PageKey) => void }) {
  const { db, run } = useBizPilot();
  const [tab, setTab] = useState('calendar');
  const [view, setView] = useState<'week' | 'month' | 'list'>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [typeFilter, setTypeFilter] = useState<(typeof TYPE_FILTERS)[number][0]>('all');
  const [asking, setAsking] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [calPlatform, setCalPlatform] = useState<'all' | ContentItem['platform']>('all');
  const calItems = calPlatform === 'all' ? db.contentItems : db.contentItems.filter((c) => c.platform === calPlatform);

  /** Hand a marketing job to WorkBuddy and open its chat in Command Centre. */
  const ask = async (goal: string) => {
    setAsking(true);
    try {
      await post('/api/agent/tasks', { prompt: goal });
      toast.success('WorkBuddy is on it. Opening Command Centre…');
      onNavigate?.('command');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const [imaging, setImaging] = useState<string | null>(null);
  /** Generate an AI image for a draft from its text and the brand style. */
  const makeImage = async (c: ContentItem) => {
    setImaging(c.id);
    try {
      const style = db.settings.brandStyle ? ` Visual style: ${db.settings.brandStyle}.` : '';
      const prompt = `Professional social media marketing visual for "${c.title}". ${c.body.replace(/#\S+/g, '').slice(0, 500)}${style} Photorealistic product photography, clean composition, no text, no logos.`;
      const aspect = c.platform === 'TikTok' ? '9:16' : c.platform === 'Instagram' ? '4:5' : c.platform === 'YouTube' ? '16:9' : '1:1';
      const img = await post<{ url: string }>('/api/media/image', { prompt, aspect });
      run((d) => {
        const x = d.contentItems.find((y) => y.id === c.id);
        if (x) x.imageUrl = img.url;
      }, 'Image generated and attached');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImaging(null);
    }
  };
  const nextMonday = addDays(startOfWeek(new Date()), 7).toLocaleDateString('en-CA');
  const PLAN_WEEK = `Load the bizpilot-marketing skill and run next week's marketing cycle (Monday ${nextMonday} to Sunday)${calPlatform === 'all' ? ', with a separate schedule for each platform that suits the business' : ` for ${calPlatform} only, using ${calPlatform}'s own best posting times and formats`}. Create the drafts in the content calendar now.`;
  const VIDEO = 'Load the marketing-content skill and make one short promotional video for the product that most needs a push right now: write the script (storyboard, voice-over, subtitles, title and thumbnail ideas) as a video_script draft, then call make_video with that draft so a real video is produced.';
  const makeVideoFor = (c: ContentItem) => `Load the marketing-content skill and make the real video for the draft "${c.title}" (contentId ${c.id}, ${c.platform}). Base the scenes on its script below, then call make_video with that contentId.\n\n${c.body.slice(0, 1500)}`;
  const INSIGHTS = 'Load the marketing-content skill and review our marketing results: what worked, what did not, and the 3 things to change next week. Separate facts from guesses.';
  const [brandOpen, setBrandOpen] = useState(false);
  const [contentDialog, setContentDialog] = useState<{ open: boolean; item: ContentItem | null }>({ open: false, item: null });
  const [campDialog, setCampDialog] = useState<{ open: boolean; campaign: Campaign | null }>({ open: false, campaign: null });
  const [filter, setFilter] = useState<(typeof CONTENT_FILTERS)[number]>('upcoming');

  const s = db.settings;
  const brandComplete = !!(s.brandVoice && s.targetAudience);
  const failed = db.contentItems.filter((c) => c.status === 'failed');
  const overBudget = db.campaigns.filter((c) => campaignMetrics(c).over);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const items = calItems
    .filter((c) => {
      if (filter === 'all') return true;
      if (filter === 'upcoming') return c.status !== 'published' || new Date(c.scheduledDate) >= todayStart;
      return c.status === filter;
    })
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  const byDay = new Map<string, ContentItem[]>();
  for (const c of items) byDay.set(dayKey(c.scheduledDate), [...(byDay.get(dayKey(c.scheduledDate)) ?? []), c]);

  const submit = (c: ContentItem) => {
    if (hasPendingApproval(db, 'marketing_publish', 'contentId', c.id)) return;
    run((d, a) => ops.submitContentForPublish(d, c.id, a, { autoPublish: AUTO_PUBLISH.has(c.platform) }), c.status === 'failed' ? 'Retry sent to Approvals' : 'Sent to Approvals');
  };

  const removeContent = (c: ContentItem) => {
    if (!window.confirm(`Delete "${c.title}"?`)) return;
    run((d, a) => {
      d.contentItems = d.contentItems.filter((x) => x.id !== c.id);
      ops.audit(d, a, 'delete', 'content', c.id, `Content deleted: ${c.title}`);
    }, 'Content deleted');
  };

  const setCampaignStatus = (c: Campaign, status: Campaign['status']) =>
    run((d, a) => {
      const x = d.campaigns.find((y) => y.id === c.id);
      if (!x) throw new ops.OpError('Campaign not found.');
      x.status = status;
      ops.audit(d, a, 'update', 'campaign', x.id, `Campaign ${x.name}: ${status}`);
    }, `Campaign ${status}`);

  const removeCampaign = (c: Campaign) => {
    if (!window.confirm(`Delete campaign ${c.name}?`)) return;
    run((d, a) => {
      d.campaigns = d.campaigns.filter((x) => x.id !== c.id);
      for (const ci of d.contentItems) if (ci.campaignId === c.id) ci.campaignId = null;
      ops.audit(d, a, 'delete', 'campaign', c.id, `Campaign deleted: ${c.name}`);
    }, 'Campaign deleted');
  };

  const totals = db.campaigns.reduce(
    (t, c) => ({ spend: t.spend + c.spend, revenue: t.revenue + c.revenue, conversions: t.conversions + c.conversions }),
    { spend: 0, revenue: 0, conversions: 0 },
  );

  return (
    <div>
      <PageHeader
        title="Marketing Studio"
        subtitle="Brand profile, content calendar, post and video drafts, campaigns and analytics"
        actions={
          <>
            <Button size="sm" variant="outline" disabled={asking} onClick={() => void ask(PLAN_WEEK)}>
              <Sparkles className="mr-1 h-4 w-4" /> Plan next week{calPlatform === 'all' ? '' : ` for ${calPlatform}`} with WorkBuddy
            </Button>
            <Button size="sm" className={primaryBtn} onClick={() => setIdeaOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> New content
            </Button>
          </>
        }
      />
      <AgentPanel page="marketing" className="mb-4" />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={CalendarDays} label="Scheduled this week" value={String(db.contentItems.filter((c) => { const t = new Date(c.scheduledDate).getTime(); const w = startOfWeek(new Date()).getTime(); return t >= w && t < w + 7 * 86400000; }).length)} />
        <Kpi icon={Send} label="Awaiting approval" value={String(db.contentItems.filter((c) => c.status === 'in_review').length)} tone="amber" />
        <Kpi icon={Megaphone} label="Published" value={String(db.contentItems.filter((c) => c.status === 'published').length)} hint={failed.length ? `${failed.length} failed` : undefined} tone={failed.length ? 'red' : 'teal'} />
        <Kpi icon={BarChart3} label="Ad spend / revenue" value={`${money(totals.spend)} / ${money(totals.revenue)}`} tone="slate" />
      </div>

      {(failed.length > 0 || overBudget.length > 0) && (
        <div className="mb-4 space-y-2">
          {failed.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {failed.length} post(s) failed to publish. Fix the issue and retry from the calendar below.
            </div>
          )}
          {overBudget.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Budget exceeded: {overBudget.map((c) => `${c.name} (${money(c.spend)} of ${money(c.budget)})`).join('; ')}. Pause or raise the budget.
            </div>
          )}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="brand">Brand profile</TabsTrigger>
          <TabsTrigger value="calendar">Content calendar</TabsTrigger>
          <TabsTrigger value="drafts">Post &amp; video drafts</TabsTrigger>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="brand" className="mt-4">
          <SectionCard
            title="Brand profile"
            description="WorkBuddy follows this for every caption, script and ad."
            actions={
              <Button size="sm" variant="outline" onClick={() => setBrandOpen(true)}>
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
              </Button>
            }
          >
            {brandComplete || s.prohibitedClaims ? (
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                {([
                  ['Voice', s.brandVoice],
                  ['Audience and personas', s.targetAudience],
                  ['Benefits and differentiators', s.brandDifferentiators],
                  ['Visual style', s.brandStyle],
                  ['Languages', s.brandLanguages],
                  ['Competitors', s.brandCompetitors],
                  ['Prohibited claims', s.prohibitedClaims],
                ] as const).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[11px] uppercase text-slate-400">{k}</dt>
                    <dd className="whitespace-pre-line text-slate-700">{v || <span className="text-slate-400">Not set</span>}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="flex items-center gap-3 text-sm text-slate-600">
                <UserRound className="h-5 w-5 text-slate-400" />
                <span>Describe your brand voice and audience so drafted content sounds like you.</span>
                <Button size="sm" className={primaryBtn} onClick={() => setBrandOpen(true)}>
                  Set up
                </Button>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="calendar" className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
            {(['all', 'Facebook', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn'] as const).map((p) => {
              const n = p === 'all' ? db.contentItems.length : db.contentItems.filter((c) => c.platform === p).length;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setCalPlatform(p)}
                  className={cn('rounded-md px-3 py-1.5 text-sm', calPlatform === p ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}
                >
                  {p === 'all' ? 'All platforms' : p} <span className="text-xs text-slate-400">{n}</span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(['week', 'month', 'list'] as const).map((v) => (
              <Button key={v} size="sm" variant={view === v ? 'default' : 'outline'} className={cn(view === v && primaryBtn)} onClick={() => setView(v)}>
                {v === 'week' ? 'Week' : v === 'month' ? 'Month' : 'List'}
              </Button>
            ))}
            {view !== 'list' && (
              <div className="ml-auto flex items-center gap-1">
                <Button size="icon-sm" variant="outline" onClick={() => setAnchor((a) => (view === 'week' ? addDays(a, -7) : new Date(a.getFullYear(), a.getMonth() - 1, 1)))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>Today</Button>
                <Button size="icon-sm" variant="outline" onClick={() => setAnchor((a) => (view === 'week' ? addDays(a, 7) : new Date(a.getFullYear(), a.getMonth() + 1, 1)))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
          {view !== 'list' && (() => {
            const first = view === 'week' ? startOfWeek(anchor) : startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
            const weeks = view === 'week' ? 1 : 6;
            const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
            const today = new Date().toLocaleDateString('en-CA');
            return (
              <SectionCard
                title={view === 'week'
                  ? `Week of ${first.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}`
                  : anchor.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' })}
              >
                <div className="overflow-x-auto">
                  <div className="grid min-w-[720px] grid-cols-7 gap-px rounded-lg border border-slate-200 bg-slate-200">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                      <div key={d} className="bg-slate-50 px-2 py-1 text-[11px] font-semibold uppercase text-slate-500">{d}</div>
                    ))}
                    {days.map((d) => {
                      const key = d.toLocaleDateString('en-CA');
                      const list = calItems.filter((c) => dayKey(c.scheduledDate) === key);
                      const outside = view === 'month' && d.getMonth() !== anchor.getMonth();
                      return (
                        <div key={key} className={cn('min-h-24 bg-white p-1.5', view === 'week' && 'min-h-40', outside && 'bg-slate-50/70')}>
                          <div className={cn('mb-1 text-[11px]', key === today ? 'font-bold text-teal-700' : outside ? 'text-slate-300' : 'text-slate-500')}>{d.getDate()}</div>
                          <div className="space-y-1">
                            {list.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                title={c.title}
                                onClick={() => setContentDialog({ open: true, item: c })}
                                className={cn(
                                  'block w-full truncate rounded px-1.5 py-1 text-left text-[11px]',
                                  c.status === 'published' ? 'bg-teal-50 text-teal-800' : c.status === 'failed' ? 'bg-red-50 text-red-700' : c.status === 'in_review' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-700',
                                )}
                              >
                                {c.platform.slice(0, 2)} · {c.title}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-300" />Draft</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-300" />Awaiting approval</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-teal-400" />Published</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-300" />Failed</span>
                </div>
              </SectionCard>
            );
          })()}
          {view === 'list' && (db.contentItems.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="Your content calendar is empty"
              body="Draft a post, choose a date and submit it for approval. Approved Facebook and Instagram posts are published automatically."
              actionLabel="Create your first post"
              onAction={() => setIdeaOpen(true)}
            />
          ) : (
            <SectionCard
              title="Content calendar"
              actions={
                <select
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as (typeof CONTENT_FILTERS)[number])}
                >
                  {CONTENT_FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {f === 'upcoming' ? 'Upcoming & unpublished' : f === 'all' ? 'All' : f.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              }
            >
              {byDay.size === 0 ? (
                <div className="py-4 text-center text-sm text-slate-500">Nothing with this status.</div>
              ) : (
                <div className="space-y-5">
                  {[...byDay.entries()].map(([day, list]) => (
                    <div key={day}>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {new Date(`${day}T00:00:00`).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                      </div>
                      <div className="space-y-2">
                        {list.map((c) => {
                          const pending = hasPendingApproval(db, 'marketing_publish', 'contentId', c.id);
                          const campaign = c.campaignId ? db.campaigns.find((x) => x.id === c.campaignId) : undefined;
                          return (
                            <div
                              key={c.id}
                              className={cn('flex gap-3 rounded-lg border bg-white p-3', c.status === 'failed' ? 'border-red-200' : 'border-slate-200')}
                            >
                              {c.imageUrl ? (
                                isVideoUrl(c.imageUrl) ? <video src={c.imageUrl} muted className="h-16 w-16 shrink-0 rounded-md border bg-black object-cover" /> : <img src={c.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-md border object-cover" />
                              ) : (
                                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400">
                                  <Megaphone className="h-5 w-5" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-medium">{c.title}</span>
                                  <Pill tone="blue">{c.platform}</Pill>
                                  <Pill>{c.type.replace('_', ' ')}</Pill>
                                  <StatusPill status={c.status} />
                                  {campaign && <Pill tone="violet">{campaign.name}</Pill>}
                                  <span className="text-[11px] text-slate-400">{fmtDateTime(c.scheduledDate)}</span>
                                </div>
                                <p className="mt-1 line-clamp-2 text-xs text-slate-600">{c.body}</p>
                                {c.status === 'failed' && c.error && <div className="mt-1 text-xs text-red-600">Error: {c.error}</div>}
                                {c.status === 'published' && (
                                  <div className="mt-1 text-[11px] text-teal-700">
                                    Published {c.publishedAt ? fmtDateTime(c.publishedAt) : ''}
                                    {c.externalPostId ? ` · post ${c.externalPostId}` : ''}
                                  </div>
                                )}
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                {(c.status === 'draft' || c.status === 'failed') && (
                                  <Button size="sm" className={primaryBtn} disabled={pending} onClick={() => submit(c)}>
                                    {c.status === 'failed' ? <RotateCcw className="mr-1 h-3.5 w-3.5" /> : <Send className="mr-1 h-3.5 w-3.5" />}
                                    {c.status === 'failed' ? 'Retry' : 'Submit for approval'}
                                  </Button>
                                )}
                                {pending && <span className="text-[11px] text-amber-700">awaiting approval</span>}
                                <div className="flex gap-1">
                                  {c.status !== 'published' && c.status !== 'in_review' && (
                                    <Button size="icon-sm" variant="ghost" title="Edit" onClick={() => setContentDialog({ open: true, item: c })}>
                                      <Pencil className="h-4 w-4" />
                                    </Button>
                                  )}
                                  {c.status !== 'in_review' && (
                                    <Button size="icon-sm" variant="ghost" title="Delete" onClick={() => removeContent(c)}>
                                      <Trash2 className="h-4 w-4 text-slate-400" />
                                    </Button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          ))}
        </TabsContent>

        <TabsContent value="drafts" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {TYPE_FILTERS.map(([k, label]) => (
              <Button key={k} size="sm" variant={typeFilter === k ? 'default' : 'outline'} className={cn(typeFilter === k && primaryBtn)} onClick={() => setTypeFilter(k)}>
                {label}
              </Button>
            ))}
            <Button size="sm" variant="outline" className="ml-auto" disabled={asking} onClick={() => void ask(VIDEO)}>
              <Clapperboard className="mr-1 h-4 w-4" /> Write a promo video with WorkBuddy
            </Button>
          </div>
          {(() => {
            const drafts = db.contentItems
              .filter((c) => c.status !== 'published' && (typeFilter === 'all' || c.type === typeFilter))
              .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
            if (!drafts.length) {
              return (
                <EmptyState
                  icon={Clapperboard}
                  title="No drafts here"
                  body="WorkBuddy can plan a week of posts or write a promotional video script for you, or you can write one yourself."
                  actionLabel="Plan next week with WorkBuddy"
                  onAction={() => void ask(PLAN_WEEK)}
                />
              );
            }
            return (
              <div className="grid gap-3 lg:grid-cols-2">
                {drafts.map((c) => {
                  const pending = hasPendingApproval(db, 'marketing_publish', 'contentId', c.id);
                  return (
                    <SectionCard
                      key={c.id}
                      title={c.title}
                      description={`${c.platform} · ${c.type.replace('_', ' ')} · ${fmtDateTime(c.scheduledDate)}`}
                      actions={<StatusPill status={c.status} />}
                    >
                      {c.imageUrl && isVideoUrl(c.imageUrl) ? (
                        <video src={c.imageUrl} controls playsInline className="mb-2 max-h-72 w-full rounded-md border bg-black" />
                      ) : c.imageUrl ? (
                        <img src={c.imageUrl} alt="" className="mb-2 max-h-48 w-full rounded-md border object-cover" />
                      ) : null}
                      <div className="max-h-64 overflow-y-auto whitespace-pre-line rounded-md bg-slate-50 p-3 text-sm text-slate-700">{c.body}</div>
                      {(() => {
                        const issues = checkCompliance(`${c.title}\n${c.body}`, db);
                        if (!issues.length) return <div className="mt-2 text-[11px] text-teal-700">✓ Compliance check passed</div>;
                        return (
                          <div className={cn('mt-2 rounded-md border px-2 py-1.5 text-[11px]', issues.some((i) => i.level === 'block') ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
                            <b>Compliance:</b> {issues.map((i) => `${i.rule} ("${i.match}")`).join(' · ')}
                          </div>
                        );
                      })()}
                      {c.status === 'failed' && c.error && <div className="mt-2 text-xs text-red-600">Error: {c.error}</div>}
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        {pending && <span className="mr-auto self-center text-[11px] text-amber-700">awaiting approval</span>}
                        {c.type === 'video_script' && !isVideoUrl(c.imageUrl) && c.status !== 'in_review' && (
                          <Button size="sm" variant="outline" disabled={asking} onClick={() => void ask(makeVideoFor(c))}>
                            <Clapperboard className="mr-1 h-3.5 w-3.5" /> Make video
                          </Button>
                        )}
                        {c.type !== 'video_script' && c.status !== 'in_review' && (
                          <Button size="sm" variant="outline" disabled={imaging === c.id} onClick={() => void makeImage(c)}>
                            <ImagePlus className="mr-1 h-3.5 w-3.5" /> {imaging === c.id ? 'Generating…' : c.imageUrl ? 'New image' : 'Generate image'}
                          </Button>
                        )}
                        {c.status !== 'in_review' && (
                          <Button size="sm" variant="outline" onClick={() => setContentDialog({ open: true, item: c })}>
                            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                          </Button>
                        )}
                        {(c.status === 'draft' || c.status === 'failed') && (
                          <Button size="sm" className={primaryBtn} disabled={pending} onClick={() => submit(c)}>
                            <Send className="mr-1 h-3.5 w-3.5" /> Submit for approval
                          </Button>
                        )}
                      </div>
                    </SectionCard>
                  );
                })}
              </div>
            );
          })()}
        </TabsContent>

        <TabsContent value="campaigns" className="mt-4">
          {db.campaigns.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="No campaigns yet"
              body="Track paid campaigns with a budget and daily cap. Enter spend, clicks, conversions and revenue from your ad manager to see CTR, cost per acquisition and ROAS."
              actionLabel="Create your first campaign"
              onAction={() => setCampDialog({ open: true, campaign: null })}
            />
          ) : (
            <SectionCard
              title="Campaigns"
              description={`Total spend ${money(totals.spend)} · ${totals.conversions} conversion(s) · ROAS ${totals.spend > 0 ? (totals.revenue / totals.spend).toFixed(2) + '×' : '—'}`}
              actions={
                <Button size="sm" className={primaryBtn} onClick={() => setCampDialog({ open: true, campaign: null })}>
                  <Plus className="mr-1 h-4 w-4" /> New campaign
                </Button>
              }
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Budget used</TableHead>
                      <TableHead className="text-right">Impr.</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">CTR</TableHead>
                      <TableHead className="text-right">Conv.</TableHead>
                      <TableHead className="text-right">CPA</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">ROAS</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {db.campaigns.map((c) => {
                      const m = campaignMetrics(c);
                      return (
                        <TableRow key={c.id} className={cn(m.over && 'bg-amber-50/70')}>
                          <TableCell>
                            <div className="font-medium">{c.name}</div>
                            <div className="text-[11px] text-slate-400">
                              {[c.platform, c.objective, c.dailyCap ? `cap ${money(c.dailyCap)}/day` : null].filter(Boolean).join(' · ')}
                              {c.startDate ? ` · ${fmtDate(c.startDate)}` : ''}
                              {c.endDate ? ` – ${fmtDate(c.endDate)}` : ''}
                            </div>
                          </TableCell>
                          <TableCell>
                            <select
                              className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs"
                              value={c.status}
                              onChange={(e) => setCampaignStatus(c, e.target.value as Campaign['status'])}
                            >
                              {(['draft', 'active', 'paused', 'ended'] as const).map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </select>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className={cn('text-sm', m.over && 'font-semibold text-amber-700')}>
                              {money(c.spend)} / {money(c.budget)}
                            </div>
                            {m.used !== null && (
                              <div className="ml-auto mt-1 h-1.5 w-24 rounded-full bg-slate-100">
                                <div className={cn('h-1.5 rounded-full', m.over ? 'bg-amber-500' : 'bg-teal-600')} style={{ width: `${Math.min(100, m.used * 100)}%` }} />
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{c.impressions.toLocaleString('en-MY')}</TableCell>
                          <TableCell className="text-right">{c.clicks.toLocaleString('en-MY')}</TableCell>
                          <TableCell className="text-right">{m.ctr !== null ? `${m.ctr.toFixed(2)}%` : '—'}</TableCell>
                          <TableCell className="text-right">{c.conversions}</TableCell>
                          <TableCell className="text-right">{m.cpa !== null ? money(m.cpa) : '—'}</TableCell>
                          <TableCell className="text-right">{money(c.revenue)}</TableCell>
                          <TableCell className={cn('text-right font-medium', m.roas !== null && m.roas < 1 && 'text-red-600')}>
                            {m.roas !== null ? `${m.roas.toFixed(2)}×` : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="icon-sm" variant="ghost" title="Edit / enter results" onClick={() => setCampDialog({ open: true, campaign: c })}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button size="icon-sm" variant="ghost" title="Delete" onClick={() => removeCampaign(c)}>
                                <Trash2 className="h-4 w-4 text-slate-400" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="analytics" className="mt-4 space-y-4">
          {(() => {
            const published = db.contentItems.filter((c) => c.status === 'published').length;
            const attempted = published + failed.length;
            const platforms = ['Facebook', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn'] as const;
            const ranked = [...db.campaigns].filter((c) => c.spend > 0).sort((a, b) => b.revenue / b.spend - a.revenue / a.spend);
            const weak = ranked.filter((c) => c.revenue / c.spend < 1);
            const inWindow = (c: Campaign) => {
              if (!c.startDate) return null;
              const from = new Date(c.startDate).getTime();
              const to = c.endDate ? new Date(c.endDate).getTime() + 86400000 : Date.now();
              return salesTotal(db.salesOrders.filter((o) => { const t = new Date(o.date).getTime(); return t >= from && t < to; }));
            };
            return (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Kpi icon={Send} label="Publishing success" value={attempted ? `${Math.round((published / attempted) * 100)}%` : '—'} hint={`${published} published · ${failed.length} failed`} tone={failed.length ? 'amber' : 'teal'} />
                  <Kpi icon={BarChart3} label="Return on ad spend" value={totals.spend > 0 ? `${(totals.revenue / totals.spend).toFixed(2)}×` : '—'} hint={`${money(totals.revenue)} from ${money(totals.spend)}`} tone={totals.spend > 0 && totals.revenue < totals.spend ? 'red' : 'teal'} />
                  <Kpi icon={Megaphone} label="Cost per conversion" value={totals.conversions ? money(totals.spend / totals.conversions) : '—'} hint={`${totals.conversions} conversion(s)`} tone="slate" />
                  <Kpi icon={CalendarDays} label="Content planned" value={String(db.contentItems.length)} hint={`${db.contentItems.filter((c) => c.status === 'draft').length} still drafts`} tone="slate" />
                </div>

                {weak.length > 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    Losing money: {weak.map((c) => `${c.name} (ROAS ${(c.revenue / c.spend).toFixed(2)}×)`).join('; ')}. Consider pausing or changing the creative.
                  </div>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <SectionCard title="Content by platform">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Platform</TableHead>
                          <TableHead className="text-right">Planned</TableHead>
                          <TableHead className="text-right">Published</TableHead>
                          <TableHead className="text-right">Failed</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {platforms.map((p) => {
                          const list = db.contentItems.filter((c) => c.platform === p);
                          return (
                            <TableRow key={p}>
                              <TableCell>{p}</TableCell>
                              <TableCell className="text-right">{list.length}</TableCell>
                              <TableCell className="text-right">{list.filter((c) => c.status === 'published').length}</TableCell>
                              <TableCell className="text-right">{list.filter((c) => c.status === 'failed').length}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </SectionCard>

                  <SectionCard title="Campaign ranking" description="Best return on ad spend first. Sales during a campaign are all sales in its dates, not proven to come from the ad.">
                    {ranked.length === 0 ? (
                      <div className="py-4 text-center text-sm text-slate-500">Enter spend and results on a campaign to rank it.</div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Campaign</TableHead>
                            <TableHead className="text-right">ROAS</TableHead>
                            <TableHead className="text-right">CPA</TableHead>
                            <TableHead className="text-right">Sales during</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {ranked.map((c) => {
                            const m = campaignMetrics(c);
                            const during = inWindow(c);
                            return (
                              <TableRow key={c.id}>
                                <TableCell className="font-medium">{c.name}</TableCell>
                                <TableCell className={cn('text-right', m.roas !== null && m.roas < 1 && 'text-red-600')}>{m.roas !== null ? `${m.roas.toFixed(2)}×` : '—'}</TableCell>
                                <TableCell className="text-right">{m.cpa !== null ? money(m.cpa) : '—'}</TableCell>
                                <TableCell className="text-right">{during !== null ? money(during) : '—'}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </SectionCard>
                </div>

                <div className="flex justify-end">
                  <Button className={primaryBtn} disabled={asking} onClick={() => void ask(INSIGHTS)}>
                    <Sparkles className="mr-1 h-4 w-4" /> Ask WorkBuddy what to change next week
                  </Button>
                </div>
              </>
            );
          })()}
        </TabsContent>
      </Tabs>

      <BrandProfileDialog open={brandOpen} onOpenChange={setBrandOpen} />
      <ContentIdeaDialog open={ideaOpen} onOpenChange={setIdeaOpen} onSend={ask} onManual={() => setContentDialog({ open: true, item: null })} />
      <ContentDialog open={contentDialog.open} onOpenChange={(o) => setContentDialog((x) => ({ ...x, open: o }))} item={contentDialog.item} />
      <CampaignDialog open={campDialog.open} onOpenChange={(o) => setCampDialog((x) => ({ ...x, open: o }))} campaign={campDialog.campaign} />
    </div>
  );
}
