import { AgentPanel } from '@/components/bizpilot/AgentPanel';
import { useState } from 'react';
import { PrivacyTab } from '@/components/bizpilot/PrivacyTab';
import { toast } from 'sonner';
import { Headset, Loader2, MessageSquareReply, Plus, RefreshCw, Star, TriangleAlert, Users } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { reviewStats } from '@/lib/metrics';
import { fmtDate, fmtDateTime, money, relDay } from '@/lib/format';
import type { Review, SupportTicket } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { EmptyState, Kpi, MARKETPLACES, Pill, SectionCard, SourceBadge, StatusPill, primaryBtn } from '@/components/bizpilot/common';
import { REVIEW_TOPICS, ReviewDialog, TicketDialog } from '@/components/bizpilot/CustomerDialogs';
import { hasPendingApproval } from '@/components/bizpilot/actions';
import { AT_RISK_DAYS, deriveCustomers } from '@/components/bizpilot/customers';
import type { SalesSource } from '@/lib/db/types';

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn('h-3.5 w-3.5', i <= n ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} />
      ))}
    </span>
  );
}

function ReviewItem({ review }: { review: Review }) {
  const { db, run } = useBizPilot();
  const [reply, setReply] = useState(review.draftResponse ?? '');
  const pending = hasPendingApproval(db, 'review_response', 'reviewId', review.id);
  const product = review.productId ? db.products.find((p) => p.id === review.productId) : undefined;

  const send = () => {
    if (!reply.trim()) return toast.error('Write a reply first.');
    run((d, a) => {
      const r = d.reviews.find((x) => x.id === review.id);
      if (!r) throw new ops.OpError('Review not found.');
      r.draftResponse = reply.trim();
      ops.requestApproval(
        d,
        {
          type: 'review_response',
          title: `Reply to ${r.rating}★ ${r.source} review from ${r.customerName}`,
          description: `Review: "${r.text.slice(0, 160)}${r.text.length > 160 ? '…' : ''}"\nReply: "${reply.trim()}"`,
          payload: { reviewId: r.id, response: reply.trim() },
          risk: r.sentiment === 'negative' ? 'medium' : 'low',
        },
        a,
      );
    }, 'Reply sent to Approvals');
  };

  const saveDraft = () =>
    run((d) => {
      const r = d.reviews.find((x) => x.id === review.id);
      if (r) r.draftResponse = reply;
    }, 'Draft saved');

  const setField = (patch: Partial<Review>, msg: string) =>
    run((d, a) => {
      const r = d.reviews.find((x) => x.id === review.id);
      if (!r) throw new ops.OpError('Review not found.');
      Object.assign(r, patch);
      ops.audit(d, a, 'update', 'review', r.id, msg);
    }, msg);

  return (
    <div className={cn('rounded-lg border bg-white p-4', review.sentiment === 'negative' && review.status === 'new' ? 'border-red-200' : 'border-slate-200')}>
      <div className="flex flex-wrap items-center gap-2">
        <Stars n={review.rating} />
        <span className="text-sm font-medium">{review.customerName}</span>
        <span className="text-xs text-slate-400">
          {review.source} · {fmtDate(review.date)}
          {product ? ` · ${product.name}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <StatusPill status={review.sentiment} />
          <select
            className="h-6 rounded-full border border-slate-200 bg-slate-50 px-2 text-[11px]"
            value={review.topic}
            onChange={(e) => setField({ topic: e.target.value }, `Review re-tagged: ${e.target.value}`)}
            title="Topic"
          >
            {[...new Set([...REVIEW_TOPICS, review.topic])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <StatusPill status={review.status} />
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{review.text}</p>

      {review.status === 'responded' ? (
        <div className="mt-3 rounded-md bg-teal-50 p-3 text-sm">
          <div className="mb-1 text-[11px] font-semibold uppercase text-teal-800">Your reply</div>
          {review.postedResponse || review.draftResponse}
        </div>
      ) : pending ? (
        <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          Reply waiting for approval: “{review.draftResponse}”
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <Textarea rows={2} placeholder="Write a reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className={primaryBtn} onClick={send}>
              <MessageSquareReply className="mr-1 h-3.5 w-3.5" /> Send reply for approval
            </Button>
            <Button size="sm" variant="outline" onClick={saveDraft} disabled={reply === (review.draftResponse ?? '')}>
              Save draft
            </Button>
            {review.status !== 'escalated' ? (
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setField({ status: 'escalated' }, 'Review escalated')}>
                <TriangleAlert className="mr-1 h-3.5 w-3.5" /> Escalate
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setField({ status: 'new' }, 'Review de-escalated')}>
                Remove escalation
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TicketRow({ ticket }: { ticket: SupportTicket }) {
  const { run } = useBizPilot();
  const [notes, setNotes] = useState(ticket.notes);
  const [open, setOpen] = useState(false);
  const update = (patch: Partial<SupportTicket>, msg: string) => run((d, a) => ops.updateTicket(d, ticket.id, patch, a), msg);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="text-left text-sm font-medium hover:underline" onClick={() => setOpen(!open)}>
          {ticket.subject}
        </button>
        <span className="text-xs text-slate-400">
          {[ticket.customerName, ticket.customerEmail].filter(Boolean).join(' · ') || 'No customer'} · opened {fmtDateTime(ticket.createdAt)}
          {ticket.resolvedAt ? ` · resolved ${fmtDate(ticket.resolvedAt)}` : ''}
        </span>
        <div className="ml-auto flex gap-1.5">
          <select
            className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs"
            value={ticket.priority}
            onChange={(e) => update({ priority: e.target.value as SupportTicket['priority'] }, 'Priority updated')}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <select
            className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs"
            value={ticket.status}
            onChange={(e) => update({ status: e.target.value as SupportTicket['status'] }, 'Status updated')}
          >
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>
      <div className="mt-1 flex gap-1.5">
        <StatusPill status={ticket.priority} label={`${ticket.priority} priority`} />
        <StatusPill status={ticket.status} />
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          {ticket.body && <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-sm text-slate-700">{ticket.body}</p>}
          <Textarea rows={3} placeholder="Internal notes…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button size="sm" variant="outline" disabled={notes === ticket.notes} onClick={() => update({ notes }, 'Notes saved')}>
            Save notes
          </Button>
        </div>
      )}
    </div>
  );
}

export function Customers() {
  const { db, callServer } = useBizPilot();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [sentiment, setSentiment] = useState('all');
  const [topic, setTopic] = useState('all');
  const [rStatus, setRStatus] = useState('open');
  const [tStatus, setTStatus] = useState('active');
  const [syncing, setSyncing] = useState<string | null>(null);
  const [custQ, setCustQ] = useState('');
  const [custFilter, setCustFilter] = useState<'all' | 'repeat' | 'at_risk'>('all');

  const stats = reviewStats(db.reviews);
  const reviews = db.reviews.filter(
    (r) =>
      (sentiment === 'all' || r.sentiment === sentiment) &&
      (topic === 'all' || r.topic === topic) &&
      (rStatus === 'all' || (rStatus === 'open' ? r.status !== 'responded' : r.status === rStatus)),
  );
  const tickets = db.tickets.filter((t) => (tStatus === 'all' ? true : tStatus === 'active' ? t.status !== 'resolved' : t.status === tStatus));
  const openTickets = db.tickets.filter((t) => t.status !== 'resolved');

  const customers = deriveCustomers(db.salesOrders);
  const repeatCount = customers.filter((c) => c.repeat).length;
  const atRisk = customers.filter((c) => c.atRisk);
  const custList = customers.filter((c) => {
    if (custFilter === 'repeat' && !c.repeat) return false;
    if (custFilter === 'at_risk' && !c.atRisk) return false;
    if (custQ) {
      const s = custQ.toLowerCase();
      return c.name.toLowerCase().includes(s) || c.email.toLowerCase().includes(s) || c.phone.includes(s);
    }
    return true;
  });

  const sync = async (provider: string, label: string) => {
    setSyncing(provider);
    const res = await callServer<{ orders?: { imported: number; updated: number }; reviews?: { imported: number } }>(`/api/sync/${provider}`);
    setSyncing(null);
    if (res) toast.success(`${label}: ${res.reviews?.imported ?? 0} new review(s), ${res.orders?.imported ?? 0} new order(s)`);
  };

  const syncButtons = MARKETPLACES.map((m) => (
    <Button key={m.id} size="sm" variant="outline" onClick={() => sync(m.id, m.label)} disabled={!!syncing}>
      {syncing === m.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
      Sync {m.label}
    </Button>
  ));

  return (
    <div>
      <PageHeader title="Customers" subtitle="Reviews, support and repeat customers" />
      <AgentPanel page="customers" className="mb-4" />
      <Tabs defaultValue="reviews">
        <TabsList>
          <TabsTrigger value="reviews">Reviews{stats.unresolved.length ? ` (${stats.unresolved.length})` : ''}</TabsTrigger>
          <TabsTrigger value="tickets">Support tickets{openTickets.length ? ` (${openTickets.length})` : ''}</TabsTrigger>
          <TabsTrigger value="retention">Customers &amp; retention</TabsTrigger>
          <TabsTrigger value="privacy">Privacy (PDPA)</TabsTrigger>
        </TabsList>

        <TabsContent value="reviews" className="mt-4 space-y-4">
          {db.reviews.length === 0 ? (
            <EmptyState
              icon={Star}
              title="No reviews yet"
              body="Sync reviews from your connected marketplaces, or add reviews from Google, Facebook or walk-in feedback by hand."
              actionLabel="Add a review"
              onAction={() => setReviewOpen(true)}
            >
              <div className="mt-3 flex flex-wrap justify-center gap-2">{syncButtons}</div>
            </EmptyState>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi icon={Star} label="Average rating" value={`${stats.avgRating.toFixed(2)} / 5`} hint={`${stats.total} review(s)`} />
                <Kpi icon={TriangleAlert} label="Negative" value={String(stats.negative.length)} hint={`${stats.total ? Math.round((stats.negative.length / stats.total) * 100) : 0}% of reviews`} tone={stats.negative.length ? 'red' : 'slate'} />
                <Kpi icon={MessageSquareReply} label="Awaiting reply" value={String(stats.unresolved.length)} hint="status new" tone={stats.unresolved.length ? 'amber' : 'slate'} />
                <Kpi icon={Star} label="Positive" value={String(stats.positive.length)} hint="4–5 stars" />
              </div>
              {stats.topics.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Topics:</span>
                  {stats.topics.map(([t, n]) => (
                    <button key={t} onClick={() => setTopic(topic === t ? 'all' : t)}>
                      <Pill tone={topic === t ? 'green' : 'slate'}>
                        {t} · {n}
                      </Pill>
                    </button>
                  ))}
                </div>
              )}
              <SectionCard
                title="Reviews"
                description={`${reviews.length} shown`}
                actions={
                  <>
                    <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
                      <option value="all">All sentiment</option>
                      <option value="negative">Negative</option>
                      <option value="neutral">Neutral</option>
                      <option value="positive">Positive</option>
                    </select>
                    <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={topic} onChange={(e) => setTopic(e.target.value)}>
                      <option value="all">All topics</option>
                      {[...new Set([...REVIEW_TOPICS, ...stats.topics.map(([t]) => t)])].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={rStatus} onChange={(e) => setRStatus(e.target.value)}>
                      <option value="open">Needs reply</option>
                      <option value="escalated">Escalated</option>
                      <option value="responded">Responded</option>
                      <option value="all">All</option>
                    </select>
                    {syncButtons}
                    <Button size="sm" className={primaryBtn} onClick={() => setReviewOpen(true)}>
                      <Plus className="mr-1 h-4 w-4" /> Add review
                    </Button>
                  </>
                }
              >
                <div className="space-y-3">
                  {reviews.map((r) => (
                    <ReviewItem key={r.id} review={r} />
                  ))}
                  {reviews.length === 0 && <div className="py-4 text-center text-sm text-slate-500">No reviews match these filters.</div>}
                </div>
              </SectionCard>
            </>
          )}
        </TabsContent>

        <TabsContent value="tickets" className="mt-4">
          {db.tickets.length === 0 ? (
            <EmptyState
              icon={Headset}
              title="No support tickets"
              body="Log customer complaints, returns and questions so nothing gets forgotten. Track priority, status and internal notes."
              actionLabel="Create the first ticket"
              onAction={() => setTicketOpen(true)}
            />
          ) : (
            <SectionCard
              title="Support tickets"
              description={`${openTickets.length} open · ${db.tickets.filter((t) => t.priority === 'high' && t.status !== 'resolved').length} high priority`}
              actions={
                <>
                  <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={tStatus} onChange={(e) => setTStatus(e.target.value)}>
                    <option value="active">Open & in progress</option>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="all">All</option>
                  </select>
                  <Button size="sm" className={primaryBtn} onClick={() => setTicketOpen(true)}>
                    <Plus className="mr-1 h-4 w-4" /> New ticket
                  </Button>
                </>
              }
            >
              <div className="space-y-2">
                {[...tickets]
                  .sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.priority] - ({ high: 0, medium: 1, low: 2 })[b.priority])
                  .map((t) => (
                    <TicketRow key={t.id} ticket={t} />
                  ))}
                {tickets.length === 0 && <div className="py-4 text-center text-sm text-slate-500">No tickets with this status.</div>}
              </div>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="retention" className="mt-4 space-y-4">
          {customers.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No identified customers yet"
              body="Customers are built from your sales orders. Online and marketplace orders carry customer details; for counter sales, enter the customer's name or phone in the New sale dialog."
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Kpi icon={Users} label="Customers" value={String(customers.length)} hint="from sales orders, walk-ins excluded" />
                <Kpi icon={RefreshCw} label="Repeat customers" value={String(repeatCount)} hint={`${Math.round((repeatCount / customers.length) * 100)}% ordered 2+ times`} />
                <Kpi icon={TriangleAlert} label="At risk" value={String(atRisk.length)} hint={`no order in ${AT_RISK_DAYS} days`} tone={atRisk.length ? 'amber' : 'slate'} />
              </div>
              <SectionCard
                title="Customer list"
                actions={
                  <>
                    <Input className="h-8 w-52" placeholder="Search name, email, phone" value={custQ} onChange={(e) => setCustQ(e.target.value)} />
                    <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={custFilter} onChange={(e) => setCustFilter(e.target.value as typeof custFilter)}>
                      <option value="all">All</option>
                      <option value="repeat">Repeat</option>
                      <option value="at_risk">At risk</option>
                    </select>
                  </>
                }
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Channels</TableHead>
                      <TableHead className="text-right">Orders</TableHead>
                      <TableHead className="text-right">Total spend</TableHead>
                      <TableHead>First order</TableHead>
                      <TableHead>Last order</TableHead>
                      <TableHead>Segment</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {custList.map((c) => (
                      <TableRow key={c.key}>
                        <TableCell>
                          <div className="font-medium">{c.name}</div>
                          <div className="text-[11px] text-slate-400">{[c.email, c.phone].filter(Boolean).join(' · ')}</div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {c.channels.map((s) => (
                              <SourceBadge key={s} source={s as SalesSource} />
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{c.orders}</TableCell>
                        <TableCell className="text-right font-medium">{money(c.totalSpend)}</TableCell>
                        <TableCell className="text-xs">{fmtDate(c.firstOrder)}</TableCell>
                        <TableCell className="text-xs">
                          {fmtDate(c.lastOrder)} <span className="text-slate-400">({relDay(c.lastOrder)})</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {c.repeat ? <Pill tone="green">repeat</Pill> : <Pill>one-time</Pill>}
                            {c.atRisk && <Pill tone="amber">at risk</Pill>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {custList.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6 text-center text-sm text-slate-500">
                          No customers match.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </SectionCard>
            </>
          )}
        </TabsContent>
        <TabsContent value="privacy" className="mt-4"><PrivacyTab /></TabsContent>
      </Tabs>
      <ReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} />
      <TicketDialog open={ticketOpen} onOpenChange={setTicketOpen} />
    </div>
  );
}
