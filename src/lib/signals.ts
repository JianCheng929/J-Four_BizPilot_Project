import type { BizPilotDB, Product } from './db/types';
import { budgetVsActual, cashFlowForecast, cashPosition, receivablesAgeing } from './metrics';
import { expiringBatches, reorderSuggestions, transferSuggestions } from './ops';

/**
 * What BizPilot notices on its own (blueprint §11 A5 proactive recommendations,
 * §25 observe → analyse → plan). Each signal comes from real records, carries
 * its evidence, and has a goal the agent can run. `auto` signals are started
 * by the server without the owner asking (risky steps still wait in
 * Approvals); the rest wait for the owner because the agent needs facts only
 * the owner has.
 *
 * Shared by the web app (the "BizPilot noticed" panels) and the server
 * (the reactor that starts the agent).
 */

export type SignalPage = 'dashboard' | 'finance' | 'inventory' | 'supplychain' | 'marketing' | 'customers';

export interface Signal {
  /** Stable id: the agent works on each key once (its chat is `auto-<key>`). */
  key: string;
  pages: SignalPage[];
  severity: 'info' | 'warning' | 'critical';
  title: string;
  evidence: string;
  action: string;
  prompt: string;
  auto: boolean;
}

const DAY = 86_400_000;
const rm = (n: number) => `RM${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const week = (t: number) => {
  const d = new Date(t);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}w${Math.floor((t - jan1) / (7 * DAY))}`;
};

export const signalChatId = (key: string) => `auto-${key}`.replace(/[^\w-]/g, '-').slice(0, 64);

function soldSince(db: BizPilotDB, productId: string, since: string) {
  return db.salesOrders.some((o) => o.status !== 'cancelled' && o.date >= since && o.lines.some((l) => l.productId === productId));
}

function hasContentFor(db: BizPilotDB, p: Product) {
  const n = p.name.toLowerCase();
  return db.contentItems.some((c) => `${c.title} ${c.body}`.toLowerCase().includes(n));
}

export function detectSignals(db: BizPilotDB, now = Date.now()): Signal[] {
  const out: Signal[] = [];
  const s = db.settings;

  // 1. New stock that is not selling yet: get it selling.
  for (const po of db.purchaseOrders) {
    if (!po.receivedAt && po.status !== 'partially_received') continue;
    const at = po.receivedAt ?? po.sentAt ?? po.createdAt;
    if (now - Date.parse(at) > 30 * DAY) continue;
    const idle = po.lines
      .map((l) => db.products.find((p) => p.id === l.productId))
      .filter((p): p is Product => !!p && p.stock > 0 && p.status === 'active' && !soldSince(db, p.id, at));
    if (!idle.length) continue;
    const value = idle.reduce((t, p) => t + p.stock * p.unitCost, 0);
    const noContent = idle.filter((p) => !hasContentFor(db, p));
    out.push({
      key: `sell-${po.id}`,
      pages: ['dashboard', 'inventory', 'marketing', 'finance'],
      severity: 'warning',
      title: `${rm(value)} of new stock has not sold yet`,
      evidence: `${po.poNumber} arrived ${new Date(at).toLocaleDateString('en-MY')}: ${idle.map((p) => `${p.stock} ${p.name}`).join(', ')}. No sales since${noContent.length ? `, and no marketing drafted for ${noContent.length === idle.length ? 'any of them' : noContent.map((p) => p.name).join(', ')}` : ''}.`,
      action: 'Get it selling',
      prompt: `New stock from ${po.poNumber} has not sold yet: ${idle.map((p) => `${p.name} (SKU ${p.sku}, ${p.stock} units, cost RM${p.unitCost}, price RM${p.price})`).join('; ')}. Get it selling now, by yourself:
1. Check each price against cost and the ${s.targetMarginPct || 30}% target margin (and marketplace fees); fix prices that lose money by requesting a price change.
2. Write marketplace-ready listing copy (title, 5 bullets, specs, keywords) and save it as the product description.
3. Draft 3 social posts per product in the brand voice for the next 7 days in the content calendar (they wait for approval before publishing).
4. Propose one launch offer that keeps the margin, and tell me which channel to list on first.
Finish with notify_owner: what you prepared and what needs my approval.`,
      auto: true,
    });
  }

  // 2. No running costs recorded: profit looks better than it is.
  const active = db.salesOrders.length > 0 || db.purchaseOrders.some((p) => p.status !== 'draft');
  if (active && db.expenses.length === 0) {
    out.push({
      key: 'setup-costs',
      pages: ['dashboard', 'finance'],
      severity: 'info',
      title: 'No running costs recorded yet',
      evidence: 'Rent, utilities, wages, platform and payment fees are missing, so profit and cash forecasts look better than they really are.',
      action: 'Set up my monthly costs',
      prompt: `I have not recorded any running costs yet. Ask me in ONE short message for my monthly costs, listing what a ${s.mode} business in ${s.country || 'Malaysia'} usually pays (rent, electricity and water, internet and phone, wages and EPF/SOCSO, marketplace commission and payment fees, transport, software) with a typical RM range for each, so I can answer quickly. Do not record anything until I answer; then record each one as a repeating expense with its due day.`,
      auto: false,
    });
  }

  // 3. Cash running short.
  const cash = cashPosition(db);
  const f = cashFlowForecast(db, 30);
  if (cash.capitalSet && (cash.balance < 0 || f.worstCase < 0 || (cash.capital > 0 && cash.balance < cash.capital * 0.2))) {
    out.push({
      key: `cash-${week(now)}`,
      pages: ['dashboard', 'finance'],
      severity: cash.balance < 0 || f.worstCase < 0 ? 'critical' : 'warning',
      title: f.worstCase < 0 ? 'Money may run out within 30 days' : `Only ${rm(cash.balance)} left to spend`,
      evidence: `Available ${rm(cash.balance)} of ${rm(cash.capital)} starting capital; expected in ${rm(f.totalIn)}, out ${rm(f.totalOut)} over 30 days (worst case ${rm(f.worstCase)}).`,
      action: 'Make a cash plan',
      prompt: `Cash is getting low: ${rm(cash.balance)} available, worst case in 30 days ${rm(f.worstCase)}. Make a cash plan by yourself: chase unpaid invoices (send_payment_reminder), find slow or overstocked items to sell with a promotion that keeps a margin, list purchases that can wait, and check prices that lose money. Draft what you can (reminders, promo posts, price changes go to approval). Finish with notify_owner: the plan with RM amounts.`,
      auto: true,
    });
  }

  // 4. Overdue invoices with no reminder in 7 days.
  for (const row of receivablesAgeing(db, now).rows) {
    for (const inv of row.items) {
      const late = Math.floor((now - Date.parse(inv.dueDate)) / DAY);
      if (late < 1) continue;
      if (inv.lastReminderAt && now - Date.parse(inv.lastReminderAt) < 7 * DAY) continue;
      if (db.approvals.some((a) => a.status === 'pending' && a.type === 'payment_reminder' && a.payload.invoiceId === inv.id)) continue;
      out.push({
        key: `remind-${inv.id}-${inv.remindersSent ?? 0}`,
        pages: ['dashboard', 'finance'],
        severity: late > 30 ? 'critical' : 'warning',
        title: `${inv.customerName} is ${late} days late paying ${rm(inv.total)}`,
        evidence: `${inv.invoiceNumber}, due ${inv.dueDate.slice(0, 10)}, ${inv.remindersSent ?? 0} reminder(s) sent.`,
        action: 'Chase payment',
        prompt: `Invoice ${inv.invoiceNumber} to ${inv.customerName} for ${rm(inv.total)} is ${late} days overdue with ${inv.remindersSent ?? 0} reminder(s) sent. Send a payment reminder now (send_payment_reminder). If it is over 60 days late, also tell me in notify_owner whether to stop selling to this customer on credit.`,
        auto: true,
      });
    }
  }

  // 5. About to run out with nothing on order.
  const transfers = transferSuggestions(db);
  for (const r of reorderSuggestions(db)) {
    if (r.urgency !== 'stockout_risk') continue;
    const p = r.product;
    const onOrder = db.purchaseOrders.some((po) => ['draft', 'pending_approval', 'approved'].includes(po.status) && po.lines.some((l) => l.productId === p.id));
    if (onOrder) continue;
    const move = transfers.find((t) => t.product.id === p.id);
    out.push({
      key: `restock-${p.id}-${week(now)}`,
      pages: ['dashboard', 'inventory', 'supplychain'],
      severity: 'critical',
      title: `${p.name} will run out${r.stockoutDate ? ` around ${r.stockoutDate}` : ''}`,
      evidence: `${r.available} available, selling ${p.avgDailySales}/day. ${r.reason}`,
      action: r.make ? 'Plan production' : 'Restock it',
      prompt: `${p.name} (SKU ${p.sku}) is about to run out: ${r.available} available, ${p.avgDailySales}/day, suggested ${r.suggestedQty}. Restock it now by yourself: ${move ? `first move stock (${move.quantity} from ${move.from.name} to ${move.to.name}) with transfer_stock, then ` : ''}${r.make ? 'plan production with plan_production and buy any missing materials' : 'draft a purchase order with the best supplier (compare price, lead time and reliability; if none is set, research suppliers on the web with sources)'}. Finish with notify_owner.`,
      auto: true,
    });
  }

  // 6. Batches expiring soon.
  for (const e of expiringBatches(db, 14)) {
    out.push({
      key: `expiry-${e.product.id}-${e.batch.batch}`.slice(0, 58),
      pages: ['dashboard', 'inventory'],
      severity: e.daysLeft < 0 ? 'critical' : 'warning',
      title: e.daysLeft < 0 ? `${e.batch.qty} ${e.product.name} expired` : `${e.batch.qty} ${e.product.name} expire in ${e.daysLeft} day(s)`,
      evidence: `Batch ${e.batch.batch}, expiry ${e.batch.expiry}, cost ${rm(e.batch.qty * e.product.unitCost)}.`,
      action: e.daysLeft < 0 ? 'Handle expired stock' : 'Sell before expiry',
      prompt: e.daysLeft < 0
        ? `Batch ${e.batch.batch} of ${e.product.name} (${e.batch.qty} units) expired on ${e.batch.expiry}. Tell me in notify_owner to remove it from sale, and what it cost (${rm(e.batch.qty * e.product.unitCost)}). Do not write it off yourself.`
        : `Batch ${e.batch.batch} of ${e.product.name} (${e.batch.qty} units) expires on ${e.batch.expiry}, in ${e.daysLeft} days, selling ${e.product.avgDailySales}/day. Plan to sell it before then: draft a clearance offer that still covers cost and 2 social posts, and request a temporary price change if needed. Finish with notify_owner.`,
      auto: e.daysLeft >= 0,
    });
  }

  // 7. Unhappy customers with no reply.
  for (const r of db.reviews) {
    if (r.status !== 'new' || r.sentiment !== 'negative' || r.draftResponse) continue;
    if (now - Date.parse(r.date) > 30 * DAY) continue;
    out.push({
      key: `review-${r.id}`,
      pages: ['dashboard', 'customers'],
      severity: r.rating <= 2 ? 'warning' : 'info',
      title: `${r.rating}★ review from ${r.customerName || 'a customer'} has no reply`,
      evidence: `${r.source}, ${r.topic}: "${r.text.slice(0, 120)}${r.text.length > 120 ? '…' : ''}"`,
      action: 'Draft a reply',
      prompt: `A ${r.rating}-star ${r.source} review (id ${r.id}) about ${r.topic} has no reply. Draft a reply in the brand voice that fixes the problem within policy and send it for approval. Escalate instead if it mentions safety, fake products, legal action or a refund.`,
      auto: true,
    });
  }

  // 8. Stock sitting still for a month.
  for (const p of db.products) {
    if (p.status !== 'active' || p.stock <= 0 || p.avgDailySales > 0) continue;
    const last = db.stockMovements.find((m) => m.productId === p.id);
    if (!last || now - Date.parse(last.date) < 30 * DAY) continue;
    const value = p.stock * p.unitCost;
    if (value < 100) continue;
    out.push({
      key: `slow-${p.id}-${new Date(now).toISOString().slice(0, 7)}`,
      pages: ['inventory', 'marketing'],
      severity: 'info',
      title: `${p.name} has not moved in over a month`,
      evidence: `${p.stock} units, ${rm(value)} at cost, no sales in the last 28 days.`,
      action: 'Plan a clearance',
      prompt: `${p.name} (SKU ${p.sku}) has ${p.stock} units (${rm(value)} at cost) and no sales in 28 days. Plan how to clear it: a bundle or discount that keeps cost covered, 2 social posts, and whether to stop reordering it. Draft them (approvals as usual) and tell me in notify_owner.`,
      auto: true,
    });
  }

  // 9. Orders waiting on the shelf: start a pick run for staff.
  const toPick = db.salesOrders
    .filter((o) => o.status === 'awaiting_fulfilment' && !o.pickStatus && (o.paymentStatus === 'paid' || o.channel === 'retail'))
    .sort((a, b) => a.date.localeCompare(b.date));
  const picking = (db.staffTasks ?? []).some((t) => t.kind === 'pick' && (t.status === 'open' || t.status === 'in_progress') && toPick.some((o) => t.ref.includes(o.orderNumber)));
  if (toPick.length && !picking) {
    const oldestH = Math.floor((now - Date.parse(toPick[0].date)) / 3_600_000);
    out.push({
      key: `pick-${toPick[0].id}`,
      pages: ['dashboard', 'inventory'],
      severity: oldestH > 24 ? 'warning' : 'info',
      title: `${toPick.length} paid order(s) waiting to be picked`,
      evidence: `${toPick.slice(0, 5).map((o) => o.orderNumber).join(', ')}${toPick.length > 5 ? '…' : ''}; oldest ${oldestH} hour(s) ago.`,
      action: 'Start a pick run',
      prompt: `${toPick.length} paid orders are waiting to be picked (${toPick.map((o) => o.orderNumber).join(', ')}). Start a pick run with start_pick_run so staff get one pick list sorted by shelf/bin. If any product has no bin, say so. For online orders with an address, get courier quotes and request booking of the best option. Finish with notify_owner.`,
      auto: true,
    });
  }

  // 10. Spending over budget this month.
  for (const r of budgetVsActual(db, new Date(now).toISOString().slice(0, 7), now).rows) {
    if (!r.budget || (r.actual <= r.budget && r.projected <= r.budget * 1.1)) continue;
    const over = r.actual > r.budget;
    out.push({
      key: `budget-${r.category}-${new Date(now).toISOString().slice(0, 7)}${over ? '-over' : ''}`.slice(0, 58),
      pages: ['dashboard', 'finance'],
      severity: over ? 'warning' : 'info',
      title: over ? `${r.category} is over budget: ${rm(r.actual)} of ${rm(r.budget)}` : `${r.category} is heading over budget`,
      evidence: `Spent ${rm(r.actual)} of ${rm(r.budget)} this month (${r.pct}%), on track for ${rm(r.projected)}.`,
      action: 'Find savings',
      prompt: `${r.category} spending is ${rm(r.actual)} against a ${rm(r.budget)} monthly budget (projected ${rm(r.projected)}). Look at the expenses in this category (list_expenses), find what drove it, and suggest concrete cuts or a better supplier with RM amounts. Do not change the budget yourself. Finish with notify_owner.`,
      auto: true,
    });
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  // Items the owner cleared stay hidden for 30 days unless the situation changes (new key).
  const cleared = s.dismissedSignals ?? {};
  return out
    .filter((x) => !(cleared[x.key] && now - Date.parse(cleared[x.key]) < 30 * DAY))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}
