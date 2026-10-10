import type { BizPilotDB, SalesOrder } from './db/types';

/**
 * Blueprint §8 D3 and §13.9: period reports with filters, a comparison with the
 * previous period of the same length, and the data notes every report must carry
 * (period, sources, assumptions, missing data, actual vs estimated).
 * Deterministic: the web app and the AI agent both call this.
 */

const DAY = 86_400_000;

export interface ReportFilter {
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
  channel?: 'all' | 'online' | 'retail';
  source?: 'all' | SalesOrder['source'];
  productId?: string | null;
}

export interface PeriodTotals {
  orders: number;
  units: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  expenses: number;
  netProfit: number;
  avgOrderValue: number;
}

export interface ProductRow {
  productId: string;
  sku: string;
  name: string;
  units: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
}

export interface PeriodReport {
  filter: Required<Omit<ReportFilter, 'productId'>> & { productId: string | null };
  days: number;
  current: PeriodTotals;
  previous: PeriodTotals;
  previousRange: { from: string; to: string };
  change: { revenuePct: number | null; grossProfitPct: number | null; ordersPct: number | null; netProfitPct: number | null };
  byChannel: { key: string; orders: number; revenue: number }[];
  bySource: { key: string; orders: number; revenue: number }[];
  products: ProductRow[];
  expensesByCategory: { category: string; amount: number; unpaid: number }[];
  /** Cash spent on stock in the period (purchase orders placed). Not an expense: it becomes cost of goods when sold. */
  stockPurchases: { count: number; amount: number };
  daily: { date: string; revenue: number; orders: number; grossProfit: number }[];
  notes: string[];
  generatedAt: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const startOf = (d: string) => new Date(`${d}T00:00:00`).getTime();
const endOf = (d: string) => new Date(`${d}T23:59:59.999`).getTime();
const ymd = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const changePct = (now: number, before: number) => (before === 0 ? null : r2(((now - before) / Math.abs(before)) * 100));

export function dateRangeFor(preset: 'today' | '7d' | '30d' | '90d' | 'mtd' | 'last_month' | 'ytd', today = new Date()): { from: string; to: string } {
  const t = today.getTime();
  const y = today.getFullYear();
  const mo = today.getMonth();
  switch (preset) {
    case 'today': return { from: ymd(t), to: ymd(t) };
    case '7d': return { from: ymd(t - 6 * DAY), to: ymd(t) };
    case '30d': return { from: ymd(t - 29 * DAY), to: ymd(t) };
    case '90d': return { from: ymd(t - 89 * DAY), to: ymd(t) };
    case 'mtd': return { from: ymd(new Date(y, mo, 1).getTime()), to: ymd(t) };
    case 'last_month': return { from: ymd(new Date(y, mo - 1, 1).getTime()), to: ymd(new Date(y, mo, 0).getTime()) };
    case 'ytd': return { from: ymd(new Date(y, 0, 1).getTime()), to: ymd(t) };
  }
}

function counted(o: SalesOrder) {
  return o.status !== 'cancelled' && o.paymentStatus !== 'refunded';
}

function totalsFor(db: BizPilotDB, f: ReportFilter, fromT: number, toT: number, collect?: {
  products: Map<string, ProductRow>; channel: Map<string, { orders: number; revenue: number }>;
  source: Map<string, { orders: number; revenue: number }>; daily: Map<string, { revenue: number; orders: number; grossProfit: number }>;
  unmatched: { lines: number }; noCost: Set<string>;
}): PeriodTotals {
  const cost = new Map(db.products.map((p) => [p.id, p]));
  let orders = 0, units = 0, revenue = 0, cogs = 0;
  for (const o of db.salesOrders) {
    const t = new Date(o.date).getTime();
    if (t < fromT || t > toT || !counted(o)) continue;
    if (f.channel && f.channel !== 'all' && o.channel !== f.channel) continue;
    if (f.source && f.source !== 'all' && o.source !== f.source) continue;
    const lines = f.productId ? o.lines.filter((l) => l.productId === f.productId) : o.lines;
    if (!lines.length) continue;
    // Whole orders use the order total (matches invoices and P&L); a product filter uses its line amounts.
    const orderRevenue = f.productId ? lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) : o.total;
    let orderCogs = 0;
    for (const l of lines) {
      const p = l.productId ? cost.get(l.productId) : undefined;
      units += l.quantity;
      if (!p) { if (collect) collect.unmatched.lines += 1; continue; }
      if (!p.unitCost && collect) collect.noCost.add(p.name);
      orderCogs += p.unitCost * l.quantity;
      if (collect) {
        const row = collect.products.get(p.id) ?? { productId: p.id, sku: p.sku, name: p.name, units: 0, revenue: 0, cogs: 0, grossProfit: 0, marginPct: 0 };
        row.units += l.quantity;
        row.revenue += l.unitPrice * l.quantity;
        row.cogs += p.unitCost * l.quantity;
        collect.products.set(p.id, row);
      }
    }
    orders += 1;
    revenue += orderRevenue;
    cogs += orderCogs;
    if (collect) {
      const ch = collect.channel.get(o.channel) ?? { orders: 0, revenue: 0 };
      ch.orders += 1; ch.revenue += orderRevenue; collect.channel.set(o.channel, ch);
      const src = collect.source.get(o.source) ?? { orders: 0, revenue: 0 };
      src.orders += 1; src.revenue += orderRevenue; collect.source.set(o.source, src);
      const day = ymd(t);
      const d = collect.daily.get(day) ?? { revenue: 0, orders: 0, grossProfit: 0 };
      d.revenue += orderRevenue; d.orders += 1; d.grossProfit += orderRevenue - orderCogs; collect.daily.set(day, d);
    }
  }
  // Operating expenses belong to the whole business, so a product filter leaves them out.
  const expenses = f.productId ? 0 : db.expenses
    .filter((e) => { const t = new Date(e.date).getTime(); return t >= fromT && t <= toT; })
    .reduce((s, e) => s + e.amount, 0);
  const grossProfit = revenue - cogs;
  return {
    orders, units, revenue: r2(revenue), cogs: r2(cogs), grossProfit: r2(grossProfit),
    grossMarginPct: revenue > 0 ? r2((grossProfit / revenue) * 100) : 0,
    expenses: r2(expenses), netProfit: r2(grossProfit - expenses), avgOrderValue: orders ? r2(revenue / orders) : 0,
  };
}

export function periodReport(db: BizPilotDB, filter: ReportFilter): PeriodReport {
  const f = { channel: 'all' as const, source: 'all' as const, productId: null, ...filter };
  let fromT = startOf(f.from);
  let toT = endOf(f.to);
  if (!Number.isFinite(fromT) || !Number.isFinite(toT)) throw new Error('Choose a valid start and end date.');
  if (fromT > toT) [fromT, toT] = [startOf(f.to), endOf(f.from)];
  const days = Math.round((toT - fromT) / DAY);
  const prevTo = fromT - 1;
  const prevFrom = fromT - days * DAY;

  const collect = {
    products: new Map<string, ProductRow>(), channel: new Map(), source: new Map(), daily: new Map(),
    unmatched: { lines: 0 }, noCost: new Set<string>(),
  };
  const current = totalsFor(db, f, fromT, toT, collect);
  const previous = totalsFor(db, f, prevFrom, prevTo);

  const products = [...collect.products.values()].map((p) => ({
    ...p, revenue: r2(p.revenue), cogs: r2(p.cogs), grossProfit: r2(p.revenue - p.cogs),
    marginPct: p.revenue > 0 ? r2(((p.revenue - p.cogs) / p.revenue) * 100) : 0,
  })).sort((a, b) => b.grossProfit - a.grossProfit);

  const exp = new Map<string, { amount: number; unpaid: number }>();
  if (!f.productId) {
    for (const e of db.expenses) {
      const t = new Date(e.date).getTime();
      if (t < fromT || t > toT) continue;
      const row = exp.get(e.category || 'Other') ?? { amount: 0, unpaid: 0 };
      row.amount += e.amount;
      if (!e.paid) row.unpaid += e.amount;
      exp.set(e.category || 'Other', row);
    }
  }

  const placed = f.productId ? [] : db.purchaseOrders.filter((p) => {
    if (!['ordered', 'partially_received', 'received'].includes(p.status)) return false;
    const t = new Date(p.sentAt || p.createdAt).getTime();
    return t >= fromT && t <= toT;
  });
  const stockPurchases = { count: placed.length, amount: r2(placed.reduce((s, p) => s + p.totalCost, 0)) };

  const daily: PeriodReport['daily'] = [];
  for (let t = fromT; t <= toT && daily.length < 400; t += DAY) {
    const d = collect.daily.get(ymd(t));
    daily.push({ date: ymd(t), revenue: r2(d?.revenue ?? 0), orders: d?.orders ?? 0, grossProfit: r2(d?.grossProfit ?? 0) });
  }

  const notes = [
    `Period: ${ymd(fromT)} to ${ymd(toT)} (${days} days), compared with ${ymd(prevFrom)} to ${ymd(prevTo)}. All values are actual recorded figures, not estimates.`,
    'Sources: BizPilot sales orders (manual, POS and synced marketplaces), expenses and the product catalogue.',
    'Cancelled and refunded orders are excluded. Revenue is the order total as recorded.',
    'Cost of goods uses each product\'s current unit cost, not the cost at the time of sale.',
  ];
  if (stockPurchases.count) notes.push(`Cash spent on stock in this period: ${stockPurchases.count} purchase order(s), RM${stockPurchases.amount.toFixed(2)}. This lowers money available (Finance → Cash flow) but is not an expense here; it becomes cost of goods when the stock sells.`);
  if (f.productId) notes.push('Product filter: revenue is that product\'s line amounts; operating expenses are not allocated to products, so net profit equals gross profit.');
  if (collect.unmatched.lines) notes.push(`Missing data: ${collect.unmatched.lines} order line(s) are not linked to a product, so their cost is counted as RM0.`);
  if (collect.noCost.size) notes.push(`Missing data: no unit cost set for ${[...collect.noCost].slice(0, 5).join(', ')}${collect.noCost.size > 5 ? ` and ${collect.noCost.size - 5} more` : ''}, so their margin is overstated.`);
  if (db.salesOrders.length >= 5000) notes.push('Only the latest 5,000 orders are loaded, so very old periods may be incomplete.');

  return {
    filter: f,
    days,
    current,
    previous,
    previousRange: { from: ymd(prevFrom), to: ymd(prevTo) },
    change: {
      revenuePct: changePct(current.revenue, previous.revenue),
      grossProfitPct: changePct(current.grossProfit, previous.grossProfit),
      ordersPct: changePct(current.orders, previous.orders),
      netProfitPct: changePct(current.netProfit, previous.netProfit),
    },
    byChannel: [...collect.channel.entries()].map(([key, v]) => ({ key, orders: v.orders, revenue: r2(v.revenue) })),
    bySource: [...collect.source.entries()].map(([key, v]) => ({ key, orders: v.orders, revenue: r2(v.revenue) })).sort((a, b) => b.revenue - a.revenue),
    products,
    stockPurchases,
    expensesByCategory: [...exp.entries()].map(([category, v]) => ({ category, amount: r2(v.amount), unpaid: r2(v.unpaid) })).sort((a, b) => b.amount - a.amount),
    daily,
    notes,
    generatedAt: new Date().toISOString(),
  };
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = (r: unknown[][]) => r.map((x) => x.map(cell).join(',')).join('\r\n');

/** The whole report as one CSV file (sections separated by blank lines). */
export function reportToCsv(r: PeriodReport, businessName: string): string {
  const c = r.current, p = r.previous;
  return [
    rows([[`${businessName} report`, `${r.filter.from} to ${r.filter.to}`], ['Channel', r.filter.channel], ['Source', r.filter.source], ['Generated', r.generatedAt]]),
    rows([['Summary', 'This period', 'Previous period'],
      ['Orders', c.orders, p.orders], ['Units', c.units, p.units], ['Revenue (RM)', c.revenue, p.revenue], ['Cost of goods (RM)', c.cogs, p.cogs],
      ['Gross profit (RM)', c.grossProfit, p.grossProfit], ['Gross margin %', c.grossMarginPct, p.grossMarginPct], ['Expenses (RM)', c.expenses, p.expenses],
      ['Net profit (RM)', c.netProfit, p.netProfit], ['Average order (RM)', c.avgOrderValue, p.avgOrderValue]]),
    rows([['Product', 'SKU', 'Units', 'Revenue (RM)', 'Cost (RM)', 'Gross profit (RM)', 'Margin %'], ...r.products.map((x) => [x.name, x.sku, x.units, x.revenue, x.cogs, x.grossProfit, x.marginPct])]),
    rows([['Expense category', 'Amount (RM)', 'Unpaid (RM)'], ...r.expensesByCategory.map((x) => [x.category, x.amount, x.unpaid])]),
    rows([['Cash spent on stock (not an expense)', 'Purchase orders', 'Amount (RM)'], ['', r.stockPurchases.count, r.stockPurchases.amount]]),
    rows([['Date', 'Orders', 'Revenue (RM)', 'Gross profit (RM)'], ...r.daily.map((x) => [x.date, x.orders, x.revenue, x.grossProfit])]),
    rows([['Notes'], ...r.notes.map((n) => [n])]),
  ].join('\r\n\r\n');
}
