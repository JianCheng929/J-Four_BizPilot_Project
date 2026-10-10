import type {
  BizPilotDB,
  Expense,
  Invoice,
  Product,
  SalesOrder,
  Review,
} from './db/types';

/**
 * Deterministic business logic (blueprint §15: "The AI model should not be the
 * authoritative source of business data"). All numbers shown to the user and
 * quoted by the AI agent come from these functions.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Blueprint B2: available to sell = on hand − reserved − unavailable (damaged, expired, quarantined). */
export function availableStock(p: Product): number {
  return Math.max(0, p.stock - p.reserved - (p.unavailable || 0));
}

export function daysOfStockLeft(p: Product): number {
  if (p.avgDailySales <= 0) return Infinity;
  return Math.floor(availableStock(p) / p.avgDailySales);
}

export function lowStockProducts(db: BizPilotDB): Product[] {
  return db.products
    .filter((p) => p.status !== 'discontinued')
    .filter(
      (p) =>
        availableStock(p) <= p.reorderLevel ||
        daysOfStockLeft(p) <= db.settings.lowStockThresholdDays,
    )
    .sort((a, b) => daysOfStockLeft(a) - daysOfStockLeft(b));
}

function inLastDays(iso: string, days: number): boolean {
  return Date.now() - new Date(iso).getTime() <= days * DAY;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export const isSameDay = isToday;

export function paidOrders(orders: SalesOrder[]): SalesOrder[] {
  return orders.filter((o) => o.status !== 'cancelled' && o.paymentStatus !== 'refunded');
}

export function salesTotal(orders: SalesOrder[]): number {
  return paidOrders(orders).reduce((s, o) => s + o.total, 0);
}

export function todaySales(db: BizPilotDB) {
  const todays = db.salesOrders.filter((o) => isToday(o.date));
  return { orders: todays.length, revenue: salesTotal(todays) };
}

export function salesLastNDays(db: BizPilotDB, days: number) {
  const orders = db.salesOrders.filter((o) => inLastDays(o.date, days));
  return { orders: orders.length, revenue: salesTotal(orders) };
}

export function awaitingFulfilment(db: BizPilotDB): SalesOrder[] {
  return db.salesOrders.filter((o) => o.status === 'awaiting_fulfilment');
}

export function grossProfitForOrder(db: BizPilotDB, o: SalesOrder): number {
  if (o.status === 'cancelled' || o.paymentStatus === 'refunded') return 0;
  return o.lines.reduce((gp, line) => {
    const prod = db.products.find((p) => p.id === line.productId);
    const cost = prod ? prod.unitCost : 0;
    return gp + (line.unitPrice - cost) * line.quantity;
  }, 0);
}

export function grossProfitLastNDays(db: BizPilotDB, days: number): number {
  return db.salesOrders
    .filter((o) => inLastDays(o.date, days))
    .reduce((s, o) => s + grossProfitForOrder(db, o), 0);
}

export function expensesLastNDays(db: BizPilotDB, days: number): number {
  return db.expenses
    .filter((e) => inLastDays(e.date, days))
    .reduce((s, e) => s + e.amount, 0);
}

export interface PnL {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  expenses: number;
  netProfit: number;
  periodDays: number;
}

export function profitAndLoss(db: BizPilotDB, days: number): PnL {
  const orders = db.salesOrders.filter((o) => inLastDays(o.date, days));
  const revenue = salesTotal(orders);
  const grossProfit = orders.reduce((s, o) => s + grossProfitForOrder(db, o), 0);
  const cogs = revenue - grossProfit;
  const expenses = expensesLastNDays(db, days);
  return {
    revenue,
    cogs,
    grossProfit,
    grossMarginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
    expenses,
    netProfit: grossProfit - expenses,
    periodDays: days,
  };
}

export interface ProductPerformance {
  product: Product;
  units: number;
  revenue: number;
  grossProfit: number;
  marginPct: number;
}

export function productPerformance(db: BizPilotDB, days: number): ProductPerformance[] {
  const map = new Map<string, { units: number; revenue: number; gp: number }>();
  for (const o of db.salesOrders.filter((x) => inLastDays(x.date, days))) {
    if (o.status === 'cancelled' || o.paymentStatus === 'refunded') continue;
    for (const line of o.lines) {
      if (!line.productId) continue;
      const prod = db.products.find((p) => p.id === line.productId);
      const cur = map.get(line.productId) ?? { units: 0, revenue: 0, gp: 0 };
      cur.units += line.quantity;
      cur.revenue += line.unitPrice * line.quantity;
      cur.gp += (line.unitPrice - (prod?.unitCost ?? 0)) * line.quantity;
      map.set(line.productId, cur);
    }
  }
  return db.products
    .filter((p) => map.has(p.id))
    .map((p) => {
      const m = map.get(p.id)!;
      return {
        product: p,
        units: m.units,
        revenue: m.revenue,
        grossProfit: m.gp,
        marginPct: p.price > 0 ? ((p.price - p.unitCost) / p.price) * 100 : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
}

export function overdueInvoices(db: BizPilotDB) {
  return db.invoices.filter((i) => i.status === 'overdue');
}

/** Unpaid supplier bills / expenses due within `days` days (blueprint D6). */
export function upcomingBills(db: BizPilotDB, days: number) {
  const limit = Date.now() + days * DAY;
  return db.expenses
    .filter((e) => !e.paid && e.dueDate && new Date(e.dueDate).getTime() <= limit)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
}

export function upcomingObligations(db: BizPilotDB, days: number) {
  const limit = Date.now() + days * DAY;
  return db.invoices
    .filter((i) => i.status === 'issued' && new Date(i.dueDate).getTime() <= limit)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function latePurchaseOrders(db: BizPilotDB) {
  return db.purchaseOrders.filter(
    (po) => po.status === 'ordered' && new Date(po.expectedDate).getTime() < Date.now(),
  );
}

export function reviewStats(reviews: Review[]) {
  const total = reviews.length;
  const neg = reviews.filter((r) => r.sentiment === 'negative');
  const pos = reviews.filter((r) => r.sentiment === 'positive');
  const byTopic = new Map<string, number>();
  for (const r of reviews) byTopic.set(r.topic, (byTopic.get(r.topic) ?? 0) + 1);
  const avg = total > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
  return {
    total,
    negative: neg,
    positive: pos,
    avgRating: avg,
    unresolved: reviews.filter((r) => r.status === 'new'),
    topics: [...byTopic.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/** Blueprint D4: selling price before tax = unit cost / (1 - target margin) */
export function suggestedPrice(unitCost: number, targetMarginPct: number): number {
  const m = targetMarginPct / 100;
  if (m >= 1) return NaN;
  return unitCost / (1 - m);
}

export function breakEvenPrice(p: Product): number {
  return p.unitCost; // minimum price to not lose money per unit (excl. fees/overheads)
}

/** Daily sales series for charts (last N days) */
export function dailySalesSeries(db: BizPilotDB, days: number) {
  const out: { date: string; label: string; online: number; retail: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY);
    const iso = d.toISOString().slice(0, 10);
    const dayOrders = db.salesOrders.filter((o) => o.date.slice(0, 10) === iso);
    out.push({
      date: iso,
      label: d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' }),
      online: salesTotal(dayOrders.filter((o) => o.channel === 'online')),
      retail: salesTotal(dayOrders.filter((o) => o.channel === 'retail')),
    });
  }
  return out;
}

export interface CashPosition {
  capital: number;
  capitalSet: boolean;
  salesIn: number;
  expensesOut: number;
  purchasesOut: number;
  balance: number;
}

/**
 * Money the business has left to work with: the owner's starting capital (modal)
 * from Settings, plus paid sales, minus paid expenses and placed purchase orders.
 * Stock purchases count as money out when the PO is placed.
 */
/** Paid invoices not tied to a sales order: the order already counts the money for the others. */
export function paidStandaloneInvoices(db: BizPilotDB): Invoice[] {
  return db.invoices.filter((i) => i.status === 'paid' && !i.orderId && i.type !== 'credit_note');
}

/** Orders whose money has actually arrived (pending payments are expected money in, not cash). */
export function cashReceivedOrders(orders: SalesOrder[]): SalesOrder[] {
  return orders.filter((o) => o.status !== 'cancelled' && o.paymentStatus === 'paid');
}

export function cashPosition(db: BizPilotDB): CashPosition {
  const salesIn = cashReceivedOrders(db.salesOrders).reduce((s, o) => s + o.total, 0) + paidStandaloneInvoices(db).reduce((s, i) => s + i.total, 0);
  const expensesOut = db.expenses.filter((e) => e.paid).reduce((s, e) => s + e.amount, 0);
  const purchasesOut = db.purchaseOrders
    .filter((p) => ['ordered', 'partially_received', 'received'].includes(p.status))
    .reduce((s, p) => s + p.totalCost, 0);
  const capital = Number(db.settings.openingCash) || 0;
  const balance = Math.round((capital + salesIn - expensesOut - purchasesOut) * 100) / 100;
  return { capital, capitalSet: Boolean(db.settings.openingCashDate), salesIn, expensesOut, purchasesOut, balance };
}

export interface CashEntry {
  date: string;
  label: string;
  amount: number; // + money in, − money out
  kind: 'capital' | 'sale' | 'expense' | 'purchase';
}

/** Every record behind cashPosition().balance, newest first, so the number can be checked. */
export function cashLedger(db: BizPilotDB): CashEntry[] {
  const out: CashEntry[] = [];
  const capital = Number(db.settings.openingCash) || 0;
  if (capital) out.push({ date: db.settings.openingCashDate || '', label: 'Starting capital (modal)', amount: capital, kind: 'capital' });
  for (const o of cashReceivedOrders(db.salesOrders)) out.push({ date: o.date, label: `Sale ${o.orderNumber}${o.customerName ? ` · ${o.customerName}` : ''}`, amount: o.total, kind: 'sale' });
  for (const i of paidStandaloneInvoices(db)) out.push({ date: i.paidDate || i.issuedDate, label: `Invoice ${i.invoiceNumber} paid · ${i.customerName}`, amount: i.total, kind: 'sale' });
  for (const e of db.expenses.filter((x) => x.paid)) out.push({ date: e.date, label: `Expense · ${e.category}: ${e.description}`, amount: -e.amount, kind: 'expense' });
  for (const p of db.purchaseOrders.filter((x) => ['ordered', 'partially_received', 'received'].includes(x.status))) {
    const sup = db.suppliers.find((x) => x.id === p.supplierId)?.name;
    out.push({ date: p.sentAt || p.createdAt, label: `Stock purchase ${p.poNumber}${sup ? ` · ${sup}` : ''} (${p.status.replace('_', ' ')})`, amount: -p.totalCost, kind: 'purchase' });
  }
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ---------------------------------------------------------------- inventory health (blueprint B2, B3, A5)

const EXPIRY_WARN_DAYS = 30;
const SLOW_MOVING_DAYS = 90;

/** Whole days from today until an ISO date (negative = already past). */
export function daysUntil(isoDate: string): number {
  const d = new Date(isoDate.length === 10 ? `${isoDate}T23:59:59` : isoDate).getTime();
  return Math.floor((d - Date.now()) / DAY);
}

export type InventoryAlertKind = 'out_of_stock' | 'low_stock' | 'expired' | 'expiring' | 'slow_moving' | 'no_sales' | 'held';

export interface InventoryAlert {
  product: Product;
  kind: InventoryAlertKind;
  severity: 'critical' | 'warning' | 'info';
  detail: string;
}

/** Deterministic stock alerts: re-running gives the same list for the same data. */
export function inventoryAlerts(db: BizPilotDB): InventoryAlert[] {
  const out: InventoryAlert[] = [];
  const lowDays = db.settings.lowStockThresholdDays;
  for (const p of db.products) {
    if (p.status === 'discontinued' || p.status === 'draft') continue;
    const avail = availableStock(p);
    const days = daysOfStockLeft(p);
    if (avail <= 0 && p.stock - p.reserved > 0) {
      out.push({ product: p, kind: 'out_of_stock', severity: 'critical', detail: `Nothing sellable: all ${p.stock} on hand are reserved or held.` });
    } else if (avail <= 0) {
      out.push({ product: p, kind: 'out_of_stock', severity: 'critical', detail: 'Out of stock.' });
    } else if (avail <= p.reorderLevel || days <= lowDays) {
      out.push({
        product: p,
        kind: 'low_stock',
        severity: 'warning',
        detail: `${avail} available${Number.isFinite(days) ? `, about ${days} day(s) left at ${p.avgDailySales}/day` : ''} (reorder level ${p.reorderLevel}).`,
      });
    }
    if (p.expiryDate && p.stock > 0) {
      const left = daysUntil(p.expiryDate);
      if (left < 0) {
        out.push({ product: p, kind: 'expired', severity: 'critical', detail: `Expired on ${p.expiryDate}. Move it to held stock or write it off.` });
      } else if (left <= EXPIRY_WARN_DAYS) {
        const sellable = p.avgDailySales * left;
        out.push({
          product: p,
          kind: 'expiring',
          severity: 'warning',
          detail: `Expires in ${left} day(s) (${p.expiryDate}). ${p.stock} on hand${p.avgDailySales > 0 ? `, about ${Math.floor(sellable)} will sell by then` : ', no recent sales'}.`,
        });
      }
    }
    if (p.stock > 0 && p.avgDailySales <= 0) {
      out.push({ product: p, kind: 'no_sales', severity: 'info', detail: `${p.stock} on hand and no sales in the last 28 days. Consider a promotion or stop reordering.` });
    } else if (Number.isFinite(days) && days > SLOW_MOVING_DAYS) {
      out.push({ product: p, kind: 'slow_moving', severity: 'info', detail: `${days} days of stock at the current sales rate: overstocked or slow-moving.` });
    }
    if ((p.unavailable || 0) > 0) {
      out.push({ product: p, kind: 'held', severity: 'info', detail: `${p.unavailable} unit(s) held as damaged, expired or quarantined (worth ${(p.unavailable * p.unitCost).toFixed(2)} at cost).` });
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface ValuationRow {
  product: Product;
  onHand: number;
  costValue: number;
  retailValue: number;
  heldValue: number;
}

/** Blueprint D3 "Inventory valuation": what stock on hand is worth at cost and at selling price. */
export function stockValuation(db: BizPilotDB) {
  const rows: ValuationRow[] = db.products
    .filter((p) => p.stock > 0)
    .map((p) => ({
      product: p,
      onHand: p.stock,
      costValue: p.stock * p.unitCost,
      retailValue: (p.stock - (p.unavailable || 0)) * p.price,
      heldValue: (p.unavailable || 0) * p.unitCost,
    }))
    .sort((a, b) => b.costValue - a.costValue);
  const sum = (k: keyof Omit<ValuationRow, 'product'>) => rows.reduce((s, r) => s + r[k], 0);
  return { rows, totalCost: sum('costValue'), totalRetail: sum('retailValue'), totalHeld: sum('heldValue'), units: sum('onHand') };
}

// ---------------------------------------------------------------- margins (blueprint D4)

export interface MarginRow {
  product: Product;
  marginPct: number;
  profitPerUnit: number;
  targetPrice: number;
  flag: 'below_cost' | 'below_target' | 'ok' | 'no_price';
}

/** Products selling below cost or under the owner's target margin. */
export function marginCheck(db: BizPilotDB): MarginRow[] {
  const target = Number(db.settings.targetMarginPct) || 30;
  const rank = { below_cost: 0, no_price: 1, below_target: 2, ok: 3 };
  return db.products
    .filter((p) => p.status !== 'discontinued')
    .map((p) => {
      const marginPct = p.price > 0 ? ((p.price - p.unitCost) / p.price) * 100 : 0;
      const flag: MarginRow['flag'] =
        p.price <= 0 ? 'no_price' : p.price < p.unitCost ? 'below_cost' : marginPct < target ? 'below_target' : 'ok';
      return {
        product: p,
        marginPct: Math.round(marginPct * 10) / 10,
        profitPerUnit: Math.round((p.price - p.unitCost) * 100) / 100,
        targetPrice: Math.ceil(suggestedPrice(p.unitCost, target) * 10) / 10,
        flag,
      };
    })
    .sort((a, b) => rank[a.flag] - rank[b.flag] || a.marginPct - b.marginPct);
}

/** Three launch price options (budget, standard, premium) around the target margin. */
export function priceOptions(unitCost: number, targetMarginPct: number) {
  const opts = [
    { label: 'Budget', margin: Math.max(5, targetMarginPct - 10) },
    { label: 'Standard', margin: targetMarginPct },
    { label: 'Premium', margin: Math.min(90, targetMarginPct + 15) },
  ];
  return opts.map((o) => ({ ...o, price: Math.ceil(suggestedPrice(unitCost, o.margin) * 10) / 10 }));
}

// ---------------------------------------------------------------- cash flow forecast (blueprint D6)

export interface CashFlowItem {
  label: string;
  amount: number;
  date: string;
  kind: 'actual' | 'estimated';
}

/**
 * Money expected in and out over the next `days` days, from records the owner
 * entered: unpaid invoices not tied to an order (in), unpaid bills and repeating
 * expenses (out). Repeating expenses are estimates from last month's amounts.
 */
export function cashFlowForecast(db: BizPilotDB, days = 30) {
  const position = cashPosition(db);
  const horizon = Date.now() + days * DAY;
  const inItems: CashFlowItem[] = [];
  const outItems: CashFlowItem[] = [];
  // Paid orders already count as cash (cashPosition). Expected money in: unpaid
  // orders (by their invoice due date when invoiced) and unpaid standalone invoices.
  const invoiced = new Set<string>();
  for (const i of db.invoices) {
    if ((i.status === 'issued' || i.status === 'overdue') && new Date(i.dueDate).getTime() <= horizon) {
      const order = i.orderId ? db.salesOrders.find((o) => o.id === i.orderId) : undefined;
      if (order && (order.status === 'cancelled' || order.paymentStatus !== 'pending')) continue;
      if (order) invoiced.add(order.id);
      inItems.push({ label: `${i.invoiceNumber} · ${i.customerName}${i.status === 'overdue' ? ' (overdue)' : ''}`, amount: i.total, date: i.dueDate, kind: 'actual' });
    }
  }
  for (const o of db.salesOrders) {
    if (o.status === 'cancelled' || o.paymentStatus !== 'pending' || invoiced.has(o.id)) continue;
    if (o.invoiceId && db.invoices.some((i) => i.id === o.invoiceId && (i.status === 'issued' || i.status === 'overdue'))) continue; // due after the horizon
    inItems.push({ label: `${o.orderNumber}${o.customerName ? ` · ${o.customerName}` : ''} (awaiting payment)`, amount: o.total, date: o.date, kind: 'actual' });
  }
  for (const e of db.expenses) {
    if (!e.paid && (!e.dueDate || new Date(e.dueDate).getTime() <= horizon)) {
      outItems.push({ label: `${e.category}: ${e.description || 'bill'}`, amount: e.amount, date: e.dueDate || e.date, kind: 'actual' });
    }
  }
  // Repeating costs paid in the last 30 days are expected again.
  const seen = new Set<string>();
  for (const e of db.expenses) {
    if (!e.recurring || !e.paid || Date.now() - new Date(e.date).getTime() > 30 * DAY) continue;
    const key = `${e.category}|${e.description}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const next = new Date(new Date(e.date).getTime() + 30 * DAY).toISOString();
    if (new Date(next).getTime() <= horizon) outItems.push({ label: `${e.category}: ${e.description || 'repeating cost'} (repeats monthly)`, amount: e.amount, date: next, kind: 'estimated' });
  }
  for (const po of db.purchaseOrders) {
    if (po.status === 'pending_approval' || po.status === 'approved') {
      outItems.push({ label: `${po.poNumber} (waiting to be placed)`, amount: po.totalCost, date: po.createdAt, kind: 'estimated' });
    }
  }
  const byDate = (a: CashFlowItem, b: CashFlowItem) => a.date.localeCompare(b.date);
  inItems.sort(byDate);
  outItems.sort(byDate);
  const totalIn = inItems.reduce((s, x) => s + x.amount, 0);
  const totalOut = outItems.reduce((s, x) => s + x.amount, 0);
  const projected = Math.round((position.balance + totalIn - totalOut) * 100) / 100;
  // Worst case: everything going out leaves before anything comes in.
  const worstCase = Math.round((position.balance - totalOut) * 100) / 100;
  return { days, position, inItems, outItems, totalIn, totalOut, projected, worstCase, lowCash: worstCase < 0 };
}

// ---------------------------------------------------------------- returns (blueprint A6)

export function returnStats(db: BizPilotDB, days = 90) {
  const recent = db.returns.filter((r) => Date.now() - new Date(r.createdAt).getTime() <= days * DAY);
  const byReason = new Map<string, number>();
  const byProduct = new Map<string, number>();
  for (const r of recent) {
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + r.quantity);
    if (r.productId) byProduct.set(r.productId, (byProduct.get(r.productId) ?? 0) + r.quantity);
  }
  const soldUnits = new Map<string, number>();
  for (const o of db.salesOrders) {
    if (o.status === 'cancelled' || Date.now() - new Date(o.date).getTime() > days * DAY) continue;
    for (const l of o.lines) if (l.productId) soldUnits.set(l.productId, (soldUnits.get(l.productId) ?? 0) + l.quantity);
  }
  const products = [...byProduct.entries()]
    .map(([id, qty]) => {
      const sold = soldUnits.get(id) ?? 0;
      return { productId: id, returned: qty, sold, ratePct: sold > 0 ? Math.round((qty / sold) * 1000) / 10 : null };
    })
    .sort((a, b) => b.returned - a.returned);
  return {
    days,
    open: db.returns.filter((r) => r.status === 'open').length,
    total: recent.length,
    reasons: [...byReason.entries()].sort((a, b) => b[1] - a[1]),
    products,
  };
}

// ---------------------------------------------------------------- ageing (blueprint D3: accounts receivable and payable)

export const AGEING_BUCKETS = ['Not due yet', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const;

function bucketOf(daysLate: number): number {
  return daysLate <= 0 ? 0 : daysLate <= 30 ? 1 : daysLate <= 60 ? 2 : daysLate <= 90 ? 3 : 4;
}

export interface AgeingRow<T> {
  name: string;
  amounts: number[]; // one per AGEING_BUCKETS entry
  total: number;
  oldestDaysLate: number;
  items: T[];
}

export interface Ageing<T> {
  totals: number[];
  total: number;
  overdue: number;
  rows: AgeingRow<T>[];
}

function age<T>(items: T[], name: (x: T) => string, due: (x: T) => string, amount: (x: T) => number, asOf: number): Ageing<T> {
  const totals = AGEING_BUCKETS.map(() => 0);
  const rows = new Map<string, AgeingRow<T>>();
  for (const x of items) {
    const late = Math.floor((asOf - new Date(due(x)).getTime()) / DAY);
    const b = bucketOf(late);
    const a = amount(x);
    totals[b] += a;
    const key = name(x).trim() || 'Unknown';
    const row = rows.get(key) ?? { name: key, amounts: AGEING_BUCKETS.map(() => 0), total: 0, oldestDaysLate: 0, items: [] };
    row.amounts[b] += a;
    row.total += a;
    row.oldestDaysLate = Math.max(row.oldestDaysLate, late);
    row.items.push(x);
    rows.set(key, row);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const total = r2(totals.reduce((s, n) => s + n, 0));
  return {
    totals: totals.map(r2),
    total,
    overdue: r2(total - totals[0]),
    rows: [...rows.values()].map((r) => ({ ...r, amounts: r.amounts.map(r2), total: r2(r.total) })).sort((a, b) => b.oldestDaysLate - a.oldestDaysLate || b.total - a.total),
  };
}

/** Money customers owe on issued, unpaid invoices, by how late it is. */
export function receivablesAgeing(db: BizPilotDB, asOf = Date.now()): Ageing<Invoice> {
  const open = db.invoices.filter((i) => (i.status === 'issued' || i.status === 'overdue') && i.type !== 'credit_note');
  return age(open, (i) => i.customerName, (i) => i.dueDate, (i) => i.total, asOf);
}

/** Bills the business has not paid yet, by how late they are. Undated bills count from their record date. */
export function payablesAgeing(db: BizPilotDB, asOf = Date.now()): Ageing<Expense> {
  const open = db.expenses.filter((e) => !e.paid);
  return age(open, (e) => e.description || e.category, (e) => e.dueDate || e.date, (e) => e.amount, asOf);
}

export interface BudgetRow { category: string; budget: number; actual: number; left: number; pct: number | null; projected: number }

/** Blueprint D: budget vs actual for one month ('YYYY-MM'), with a straight-line month-end projection. */
export function budgetVsActual(db: BizPilotDB, month = new Date().toISOString().slice(0, 7), now = Date.now()): { month: string; rows: BudgetRow[]; budget: number; actual: number } {
  const budgets = db.settings.budgets ?? {};
  const spent = new Map<string, number>();
  for (const e of db.expenses) {
    if (!e.date || e.date.slice(0, 7) !== month) continue;
    spent.set(e.category, (spent.get(e.category) ?? 0) + e.amount);
  }
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = new Date(now);
  const isCurrent = today.toISOString().slice(0, 7) === month;
  const elapsed = isCurrent ? Math.max(1, today.getUTCDate()) : daysInMonth;
  const cats = new Set([...Object.keys(budgets), ...spent.keys()]);
  const rows = [...cats].map((category) => {
    const budget = budgets[category] ?? 0;
    const actual = Math.round((spent.get(category) ?? 0) * 100) / 100;
    // Repeating costs land once a month, so only project the variable part.
    const repeating = db.expenses.filter((e) => e.category === category && e.recurring && e.date?.slice(0, 7) === month).reduce((s, e) => s + e.amount, 0);
    const projected = Math.round((repeating + ((actual - repeating) / elapsed) * daysInMonth) * 100) / 100;
    return { category, budget, actual, left: Math.round((budget - actual) * 100) / 100, pct: budget ? Math.round((actual / budget) * 100) : null, projected };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.actual - a.actual);
  return { month, rows, budget: rows.reduce((s, r) => s + r.budget, 0), actual: rows.reduce((s, r) => s + r.actual, 0) };
}
