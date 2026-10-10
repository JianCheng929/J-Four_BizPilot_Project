import { AgentPanel } from '@/components/bizpilot/AgentPanel';
import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlarmClock,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Circle,
  CircleDollarSign,
  ClipboardCheck,
  MessageSquareWarning,
  PackageOpen,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Truck,
  Wallet,
  Boxes,
} from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { api } from '@/lib/api';
import * as ops from '@/lib/ops';
import {
  awaitingFulfilment,
  cashPosition,
  stockValuation,
  dailySalesSeries,
  grossProfitLastNDays,
  latePurchaseOrders,
  overdueInvoices,
  salesLastNDays,
  todaySales,
  upcomingBills,
} from '@/lib/metrics';
import { fmtDate, money, moneyShort, relDay } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { PageHeader, type PageKey } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { Kpi, SectionCard, primaryBtn } from '@/components/bizpilot/common';
import { CapitalDialog } from '@/components/bizpilot/CapitalDialog';

const ONLINE = '#0d9488';
const RETAIL = '#d97706';
const MARKETPLACE_IDS = ['shopee', 'lazada', 'tiktok_shop', 'tiktok'];

interface IntegrationStatus {
  id: string;
  status: string;
}

function useIntegrationStatus() {
  const [list, setList] = useState<IntegrationStatus[] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ id: string; connected: boolean }[]>('/api/integrations'),
      api<{ connected: boolean }>('/api/agent/status').catch(() => ({ connected: false })),
    ])
      .then(([items, wb]) => {
        if (!alive) return;
        const list = items.map((i) => ({ id: i.id, status: i.connected ? 'connected' : 'not_connected' }));
        list.push({ id: 'workbuddy', status: wb.connected ? 'connected' : 'not_connected' });
        setList(list);
      })
      .catch(() => alive && setList(null));
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

interface AttentionItem {
  key: string;
  tone: 'red' | 'amber' | 'blue';
  title: string;
  detail: string;
  page: PageKey;
}

export function Dashboard({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { db } = useBizPilot();
  const integrations = useIntegrationStatus();

  const today = todaySales(db);
  const week = salesLastNDays(db, 7);
  const prevWeekRevenue = salesLastNDays(db, 14).revenue - week.revenue;
  const gp7 = grossProfitLastNDays(db, 7);
  const awaiting = awaitingFulfilment(db);
  const reorder = ops.reorderSuggestions(db);
  const latePOs = latePurchaseOrders(db);
  const [capitalOpen, setCapitalOpen] = useState(false);
  const cash = cashPosition(db);
  const stockValue = stockValuation(db);
  const overdue = overdueInvoices(db);
  const overdueTotal = overdue.reduce((s, i) => s + i.total, 0);
  const bills = upcomingBills(db, 7);
  const billsTotal = bills.reduce((s, e) => s + e.amount, 0);
  const pending = db.approvals.filter((a) => a.status === 'pending');
  const negReviews = db.reviews.filter((r) => r.sentiment === 'negative' && r.status === 'new');
  const failedPosts = db.contentItems.filter((c) => c.status === 'failed');
  const series = dailySalesSeries(db, 14);
  const series14Total = series.reduce((s, d) => s + d.online + d.retail, 0);

  const hasProducts = db.products.length > 0;
  const hasSales = db.salesOrders.length > 0;
  const isConnected = (pred: (id: string) => boolean) => !!integrations?.some((i) => pred(i.id) && i.status === 'connected');
  const workbuddyDone = db.agentTasks.length > 0;
  const channelDone =
    isConnected((id) => MARKETPLACE_IDS.includes(id)) || db.salesOrders.some((o) => ['shopee', 'lazada', 'tiktok_shop'].includes(o.source));
  const checklist: { done: boolean; label: string; hint: string; page: PageKey; cta: string; onClick?: () => void }[] = [
    { done: Boolean(db.settings.openingCashDate), label: 'Set your starting capital (modal)', hint: 'The money you put into the business, so BizPilot can track what is left', page: 'finance' as PageKey, cta: 'Set capital', onClick: () => setCapitalOpen(true) },
    { done: hasProducts, label: 'Add your products', hint: 'Cost, price, opening stock and reorder level', page: 'inventory' as PageKey, cta: 'Add products' },
    { done: workbuddyDone, label: 'Give WorkBuddy its first goal', hint: 'Try "Morning briefing" in the Command Centre', page: 'command' as PageKey, cta: 'Open Command Centre' },
    { done: channelDone, label: 'Connect a sales channel', hint: 'Shopee, Lazada or TikTok Shop', page: 'settings' as PageKey, cta: 'Open Settings' },
    { done: hasSales, label: 'Record your first sale', hint: 'Counter sale or online order', page: 'finance' as PageKey, cta: 'New sale' },
  ];
  const checklistDone = checklist.filter((c) => c.done).length;
  const showChecklist = !hasSales || checklistDone < checklist.length;

  // ----- Daily briefing: only real numbers, with the period stated
  const hour = new Date().getHours();
  const briefing: string[] = [];
  if (hasSales) {
    briefing.push(
      `Today so far: ${money(today.revenue)} from ${today.orders} order(s). Last 7 days: ${money(week.revenue)} from ${week.orders} order(s), gross profit ${money(gp7)}.`,
    );
    if (prevWeekRevenue > 0) {
      const ch = ((week.revenue - prevWeekRevenue) / prevWeekRevenue) * 100;
      briefing.push(`That is ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(0)}% on the 7 days before (${money(prevWeekRevenue)}).`);
    }
  }
  if (awaiting.length) briefing.push(`${awaiting.length} order(s) are waiting to be packed.`);
  if (reorder.length) briefing.push(`${reorder.length} product(s) need restocking — ${reorder[0].product.name} is most urgent (${reorder[0].available} available).`);
  const running = (db.productionOrders ?? []).filter((o) => o.status === 'in_progress');
  const overdueProduction = (db.productionOrders ?? []).filter((o) => ['approved', 'in_progress'].includes(o.status) && o.dueDate && o.dueDate < new Date().toISOString().slice(0, 10));
  if (running.length) briefing.push(`${running.length} production order(s) in progress${overdueProduction.length ? `, ${overdueProduction.length} past the due date` : ''}.`);
  if (latePOs.length) briefing.push(`${latePOs.length} supplier deliver${latePOs.length > 1 ? 'ies are' : 'y is'} past the expected date.`);
  if (overdue.length) briefing.push(`${overdue.length} invoice(s) overdue, ${money(overdueTotal)} in total.`);
  if (bills.length) briefing.push(`${bills.length} bill(s) worth ${money(billsTotal)} due within 7 days.`);
  if (negReviews.length) briefing.push(`${negReviews.length} negative review(s) have no reply yet.`);
  if (pending.length) briefing.push(`${pending.length} action(s) await your approval.`);
  if (!briefing.length) briefing.push(hasProducts ? 'No sales recorded yet and nothing needs attention.' : 'No business records yet — start with the checklist below.');

  // ----- Needs attention
  const attention: AttentionItem[] = [
    ...reorder.slice(0, 3).map((s) => ({
      key: `r-${s.product.id}`,
      tone: (s.available <= 0 ? 'red' : 'amber') as AttentionItem['tone'],
      title: `${s.product.name}: ${s.available <= 0 ? 'out of stock' : 'low stock'}`,
      detail: s.reason,
      page: 'inventory' as PageKey,
    })),
    ...overdueProduction.map((o) => ({
      key: `mo-${o.id}`,
      tone: 'amber' as const,
      title: `${o.orderNumber} is past its due date`,
      detail: `${o.quantity}× ${db.products.find((p) => p.id === o.productId)?.name ?? 'item'} · due ${o.dueDate}`,
      page: 'supplychain' as PageKey,
    })),
    ...latePOs.map((po) => ({
      key: `po-${po.id}`,
      tone: 'amber' as const,
      title: `${po.poNumber} is late`,
      detail: `${db.suppliers.find((s) => s.id === po.supplierId)?.name ?? 'Supplier'} · was due ${relDay(po.expectedDate)}`,
      page: 'supplychain' as PageKey,
    })),
    ...overdue.slice(0, 3).map((i) => ({
      key: `inv-${i.id}`,
      tone: 'red' as const,
      title: `${i.invoiceNumber} overdue`,
      detail: `${i.customerName} · ${money(i.total)} · due ${fmtDate(i.dueDate)}`,
      page: 'finance' as PageKey,
    })),
    ...bills.slice(0, 3).map((b) => ({
      key: `bill-${b.id}`,
      tone: 'amber' as const,
      title: `Bill: ${b.description}`,
      detail: `${money(b.amount)} · due ${b.dueDate ? relDay(b.dueDate) : '—'}`,
      page: 'finance' as PageKey,
    })),
    ...(awaiting.length
      ? [{ key: 'awaiting', tone: 'blue' as const, title: `${awaiting.length} order(s) to fulfil`, detail: `oldest ${relDay(awaiting[awaiting.length - 1].date)}`, page: 'finance' as PageKey }]
      : []),
    ...negReviews.slice(0, 2).map((r) => ({
      key: `rev-${r.id}`,
      tone: 'red' as const,
      title: `${r.rating}★ review on ${r.source}`,
      detail: r.text,
      page: 'customers' as PageKey,
    })),
    ...(failedPosts.length
      ? [{ key: 'posts', tone: 'red' as const, title: `${failedPosts.length} post(s) failed to publish`, detail: failedPosts[0].error ?? failedPosts[0].title, page: 'marketing' as PageKey }]
      : []),
  ];

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`${db.settings.name || 'Your business'} · one view of your business health`} />
      <AgentPanel page="dashboard" className="mb-4" />
      {capitalOpen && <CapitalDialog open={capitalOpen} onOpenChange={setCapitalOpen} />}

      <div className="mb-5 rounded-xl border border-teal-700/20 bg-gradient-to-br from-teal-700/[0.06] to-transparent p-4">
        <div className="flex gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-700 text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-teal-900">
              Good {hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'} — daily briefing
            </div>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">{briefing.join(' ')}</p>
            <div className="mt-1.5 text-[11px] text-slate-400">
              Calculated from your records · today ({fmtDate(new Date().toISOString())}) and the trailing 7 days
            </div>
          </div>
        </div>
      </div>

      {(hasProducts || hasSales) && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
          <Kpi icon={ShoppingCart} label="Today's sales" value={money(today.revenue)} hint={`${today.orders} order(s)`} onClick={() => onNavigate('finance')} />
          <Kpi icon={TrendingUp} label="Sales (7 days)" value={money(week.revenue)} hint={`${week.orders} order(s)`} onClick={() => onNavigate('finance')} />
          <Kpi icon={CircleDollarSign} label="Gross profit (7 days)" value={money(gp7)} hint="revenue − cost of goods" onClick={() => onNavigate('finance')} />
          <Kpi icon={PackageOpen} label="Awaiting fulfilment" value={String(awaiting.length)} hint="orders to pack" tone={awaiting.length ? 'amber' : 'slate'} onClick={() => onNavigate('finance')} />
          <Kpi icon={AlertTriangle} label="Low stock" value={String(reorder.length)} hint="need replenishment" tone={reorder.length ? 'amber' : 'slate'} onClick={() => onNavigate('inventory')} />
          <Kpi icon={ClipboardCheck} label="Pending approvals" value={String(pending.length)} hint="actions waiting" tone={pending.length ? 'teal' : 'slate'} onClick={() => onNavigate('approvals')} />
          <Kpi icon={MessageSquareWarning} label="Negative reviews" value={String(negReviews.length)} hint="new, unanswered" tone={negReviews.length ? 'red' : 'slate'} onClick={() => onNavigate('customers')} />
          <Kpi icon={AlarmClock} label="Overdue invoices" value={money(overdueTotal)} hint={`${overdue.length} invoice(s)`} tone={overdue.length ? 'red' : 'slate'} onClick={() => onNavigate('finance')} />
          <Kpi icon={CalendarClock} label="Bills due (7 days)" value={money(billsTotal)} hint={`${bills.length} bill(s)`} tone={bills.length ? 'amber' : 'slate'} onClick={() => onNavigate('finance')} />
          <Kpi icon={Truck} label="Late deliveries" value={String(latePOs.length)} hint="purchase orders" tone={latePOs.length ? 'amber' : 'slate'} onClick={() => onNavigate('supplychain')} />
          <Kpi icon={Wallet} label="Money available" value={money(cash.balance)} hint={cash.capitalSet ? `after ${money(cash.purchasesOut)} stock bought` : 'set starting capital in Settings'} tone={cash.balance < 0 ? 'red' : 'teal'} onClick={() => (cash.capitalSet ? onNavigate('finance') : setCapitalOpen(true))} />
          <Kpi icon={Boxes} label="Stock value" value={money(stockValue.totalCost)} hint={`${stockValue.units} units at cost`} tone="slate" onClick={() => onNavigate('inventory')} />
        </div>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          {hasSales ? (
            <SectionCard title="Sales by channel — last 14 days" description={`${money(series14Total)} paid sales · online vs retail (POS)`}>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => moneyShort(v)} />
                    <Tooltip
                      cursor={{ fill: 'rgba(15,118,110,0.06)' }}
                      formatter={(v, name) => [money(Number(v)), name === 'online' ? 'Online' : 'Retail']}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Legend formatter={(v) => (v === 'online' ? 'Online' : 'Retail')} iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="online" stackId="s" fill={ONLINE} stroke="#fff" strokeWidth={1} />
                    <Bar dataKey="retail" stackId="s" fill={RETAIL} stroke="#fff" strokeWidth={1} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>
          ) : null}
          {showChecklist && (
            <SectionCard
              className={cn(hasSales && 'mt-5')}
              title="Getting started"
              description={`${checklistDone} of ${checklist.length} done — charts appear once you record sales`}
            >
              <div className="space-y-2">
                {checklist.map((c) => (
                  <div key={c.label} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
                    {c.done ? <CheckCircle2 className="h-5 w-5 text-teal-600" /> : <Circle className="h-5 w-5 text-slate-300" />}
                    <div className="min-w-0 flex-1">
                      <div className={cn('text-sm font-medium', c.done && 'text-slate-400 line-through')}>{c.label}</div>
                      <div className="text-xs text-slate-500">{c.hint}</div>
                    </div>
                    {!c.done && (
                      <Button size="sm" className={primaryBtn} onClick={() => (c.onClick ? c.onClick() : onNavigate(c.page))}>
                        {c.cta}
                      </Button>
                    )}
                  </div>
                ))}
                {integrations === null && (
                  <div className="text-[11px] text-slate-400">Connection status could not be read from the BizPilot server; check Settings.</div>
                )}
              </div>
            </SectionCard>
          )}
        </div>

        <SectionCard title="Needs attention">
          <div className="space-y-2">
            {attention.map((a) => (
              <button
                key={a.key}
                onClick={() => onNavigate(a.page)}
                className="flex w-full items-center gap-2 rounded-lg border border-slate-200 p-2.5 text-left transition-colors hover:bg-slate-50"
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', a.tone === 'red' ? 'bg-red-500' : a.tone === 'amber' ? 'bg-amber-500' : 'bg-sky-500')} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{a.title}</div>
                  <div className="truncate text-[11px] text-slate-500">{a.detail}</div>
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
              </button>
            ))}
            {pending.length > 0 && (
              <Button size="sm" className={cn('w-full', primaryBtn)} onClick={() => onNavigate('approvals')}>
                Review {pending.length} pending approval{pending.length > 1 ? 's' : ''}
              </Button>
            )}
            {attention.length === 0 && pending.length === 0 && (
              <div className="rounded-lg bg-slate-50 p-4 text-center text-sm text-slate-500">Nothing needs attention right now.</div>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
