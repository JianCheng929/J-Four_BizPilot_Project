import { useState } from 'react';
import { AlertTriangle, CalendarDays, Megaphone, Pencil, Plus, RotateCcw, Send, Trash2, UserRound } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import type { Campaign, ContentItem } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { EmptyState, Pill, SectionCard, StatusPill, primaryBtn } from '@/components/bizpilot/common';
import { AUTO_PUBLISH, BrandProfileDialog, CampaignDialog, ContentDialog } from '@/components/bizpilot/MarketingDialogs';
import { hasPendingApproval } from '@/components/bizpilot/actions';

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

export function Marketing() {
  const { db, run } = useBizPilot();
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
  const items = db.contentItems
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
    const flagged = s.prohibitedClaims
      .split(/[,\n]/)
      .map((w) => w.trim())
      .filter((w) => w && (c.body + ' ' + c.title).toLowerCase().includes(w.toLowerCase()));
    run((d, a) => {
      const x = d.contentItems.find((y) => y.id === c.id);
      if (!x) throw new ops.OpError('Content not found.');
      x.status = 'in_review';
      x.error = null;
      ops.requestApproval(
        d,
        {
          type: 'marketing_publish',
          title: `Publish to ${x.platform}: ${x.title}`,
          description: `${x.type.replace('_', ' ')} scheduled ${fmtDateTime(x.scheduledDate)}${AUTO_PUBLISH.has(x.platform) ? ' (auto-publish)' : ' (post manually)'}.\n\n${x.body.slice(0, 400)}${x.body.length > 400 ? '…' : ''}${x.imageUrl ? `\n\nImage: ${x.imageUrl}` : ''}${flagged.length ? `\n\n⚠ Contains prohibited claim(s): ${flagged.join(', ')}` : ''}`,
          payload: { contentId: x.id },
          risk: flagged.length ? 'high' : 'low',
        },
        a,
      );
    }, c.status === 'failed' ? 'Retry sent to Approvals' : 'Sent to Approvals');
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
        subtitle="Plan, approve and publish content; track campaign results"
        actions={
          <Button size="sm" className={primaryBtn} onClick={() => setContentDialog({ open: true, item: null })}>
            <Plus className="mr-1 h-4 w-4" /> New content
          </Button>
        }
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <SectionCard
          title="Brand profile"
          actions={
            <Button size="sm" variant="outline" onClick={() => setBrandOpen(true)}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
            </Button>
          }
        >
          {brandComplete || s.prohibitedClaims ? (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-[11px] uppercase text-slate-400">Voice</dt>
                <dd className="text-slate-700">{s.brandVoice || <span className="text-slate-400">Not set</span>}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-slate-400">Audience</dt>
                <dd className="text-slate-700">{s.targetAudience || <span className="text-slate-400">Not set</span>}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-slate-400">Prohibited claims</dt>
                <dd className="text-slate-700">{s.prohibitedClaims || <span className="text-slate-400">None</span>}</dd>
              </div>
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
        <SectionCard title="Status">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-600">Content in calendar</span>
              <span className="font-medium">{db.contentItems.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Awaiting approval</span>
              <span className="font-medium">{db.contentItems.filter((c) => c.status === 'in_review').length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Published (all time)</span>
              <span className="font-medium">{db.contentItems.filter((c) => c.status === 'published').length}</span>
            </div>
            <div className={cn('flex justify-between', failed.length && 'text-red-600')}>
              <span>Failed to publish</span>
              <span className="font-medium">{failed.length}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="text-slate-600">Ad spend / attributed revenue</span>
              <span className="font-medium">
                {money(totals.spend)} / {money(totals.revenue)}
              </span>
            </div>
          </div>
        </SectionCard>
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

      <Tabs defaultValue="calendar">
        <TabsList>
          <TabsTrigger value="calendar">Content calendar</TabsTrigger>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
        </TabsList>

        <TabsContent value="calendar" className="mt-4">
          {db.contentItems.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="Your content calendar is empty"
              body="Draft a post, choose a date and submit it for approval. Approved Facebook and Instagram posts are published automatically."
              actionLabel="Create your first post"
              onAction={() => setContentDialog({ open: true, item: null })}
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
                                <img src={c.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-md border object-cover" />
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
          )}
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
      </Tabs>

      <BrandProfileDialog open={brandOpen} onOpenChange={setBrandOpen} />
      <ContentDialog open={contentDialog.open} onOpenChange={(o) => setContentDialog((x) => ({ ...x, open: o }))} item={contentDialog.item} />
      <CampaignDialog open={campDialog.open} onOpenChange={(o) => setCampDialog((x) => ({ ...x, open: o }))} campaign={campDialog.campaign} />
    </div>
  );
}
