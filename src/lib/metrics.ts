import type {
  BizPilotDB,
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

export function availableStock(p: Product): number {
  return Math.max(0, p.stock - p.reserved);
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
export function cashPosition(db: BizPilotDB): CashPosition {
  const salesIn = paidOrders(db.salesOrders).reduce((s, o) => s + o.total, 0);
  const expensesOut = db.expenses.filter((e) => e.paid).reduce((s, e) => s + e.amount, 0);
  const purchasesOut = db.purchaseOrders
    .filter((p) => ['ordered', 'partially_received', 'received'].includes(p.status))
    .reduce((s, p) => s + p.totalCost, 0);
  const capital = Number(db.settings.openingCash) || 0;
  const balance = Math.round((capital + salesIn - expensesOut - purchasesOut) * 100) / 100;
  return { capital, capitalSet: Boolean(db.settings.openingCashDate), salesIn, expensesOut, purchasesOut, balance };
}
