import type { SalesOrder } from './db/types';

export interface CustomerSummary {
  key: string;
  name: string;
  email: string;
  phone: string;
  orders: number;
  totalSpend: number;
  firstOrder: string;
  lastOrder: string;
  repeat: boolean;
  atRisk: boolean;
  channels: string[];
}

const DAY = 86400000;
export const AT_RISK_DAYS = 60;

/**
 * Customers derived from real sales orders (walk-in / anonymous sales are
 * excluded). Orders are grouped by email, then phone, then name.
 */
export function deriveCustomers(orders: SalesOrder[]): CustomerSummary[] {
  const map = new Map<string, CustomerSummary>();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const name = o.customerName?.trim() ?? '';
    if (!name || name.toLowerCase() === 'walk-in customer') {
      if (!o.customerEmail && !o.customerPhone) continue;
    }
    const email = o.customerEmail?.trim().toLowerCase() ?? '';
    const phone = (o.customerPhone ?? '').replace(/\D/g, '');
    const key = email ? `e:${email}` : phone ? `p:${phone}` : `n:${name.toLowerCase()}`;
    const cur = map.get(key);
    const spend = o.paymentStatus === 'refunded' ? 0 : o.total;
    if (!cur) {
      map.set(key, {
        key,
        name: name && name.toLowerCase() !== 'walk-in customer' ? name : o.customerEmail || o.customerPhone,
        email: o.customerEmail ?? '',
        phone: o.customerPhone ?? '',
        orders: 1,
        totalSpend: spend,
        firstOrder: o.date,
        lastOrder: o.date,
        repeat: false,
        atRisk: false,
        channels: [o.source],
      });
    } else {
      cur.orders += 1;
      cur.totalSpend += spend;
      if (o.date < cur.firstOrder) cur.firstOrder = o.date;
      if (o.date > cur.lastOrder) cur.lastOrder = o.date;
      if (!cur.email && o.customerEmail) cur.email = o.customerEmail;
      if (!cur.phone && o.customerPhone) cur.phone = o.customerPhone;
      if (!cur.channels.includes(o.source)) cur.channels.push(o.source);
    }
  }
  const now = Date.now();
  return [...map.values()]
    .map((c) => ({ ...c, repeat: c.orders >= 2, atRisk: now - new Date(c.lastOrder).getTime() > AT_RISK_DAYS * DAY }))
    .sort((a, b) => b.totalSpend - a.totalSpend);
}
