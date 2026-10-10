import type { BizPilotDB } from './db/types';
import { checkCompliance } from './compliance';
import { cashPosition } from './metrics';

/**
 * Quality control for the agent team (rubric: self-validation). Re-reads the
 * records an agent run created or changed and checks them with fixed rules,
 * so the final answer only reports work that is complete and consistent.
 */

export interface Check { area: string; item: string; ok: boolean; problem?: string; fix?: string; severity?: 'error' | 'warning' }
export interface Verification { passed: boolean; errors: number; warnings: number; checked: number; checks: Check[]; pendingApprovals: { id: string; title: string; risk: string }[] }

const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.05;

export function verifyWork(db: BizPilotDB, since: string, actor = 'WorkBuddy agent'): Verification {
  const touched = (entity: string) => new Set(db.auditLog.filter((a) => a.at >= since && a.actor.startsWith(actor) && a.entity === entity).map((a) => a.entityId));
  const checks: Check[] = [];
  const add = (c: Check) => checks.push({ severity: c.ok ? undefined : c.severity ?? 'error', ...c });

  // Products: sellable with a real margin
  const skus = touched('product');
  for (const p of db.products.filter((x) => skus.has(x.sku))) {
    const item = `${p.name} (${p.sku})`;
    if (!(p.price > 0)) add({ area: 'product', item, ok: false, problem: 'no selling price', fix: 'update_product with a price (or request_price_change)' });
    else if (!(p.unitCost > 0)) add({ area: 'product', item, ok: false, problem: 'no unit cost, so margin and stock value are unknown', fix: 'update_product with the cost from the supplier quote', severity: 'warning' });
    else if (p.price <= p.unitCost) add({ area: 'product', item, ok: false, problem: `sells at RM${p.price} but costs RM${p.unitCost} (loss)`, fix: 'request_price_change or find a cheaper supplier' });
    else add({ area: 'product', item, ok: true });
    if (p.stock < 0 || p.reserved > p.stock + p.incoming + 1e-9) add({ area: 'stock', item, ok: false, problem: `stock ${p.stock}, reserved ${p.reserved}`, fix: 'check orders and stock movements', severity: 'warning' });
  }

  // Purchase orders: real supplier, lines that add up, affordable
  const pos = touched('purchase_order');
  const cash = cashPosition(db).balance;
  for (const po of db.purchaseOrders.filter((x) => pos.has(x.poNumber) && x.status !== 'cancelled')) {
    const item = po.poNumber;
    const sup = db.suppliers.find((s) => s.id === po.supplierId);
    const sum = r2(po.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0));
    if (!sup) add({ area: 'purchase order', item, ok: false, problem: 'supplier not found', fix: 'cancel_purchase_order and draft it again for a saved supplier' });
    else if (!po.lines.length || po.lines.some((l) => !(l.quantity > 0) || !(l.unitCost > 0) || !db.products.some((p) => p.id === l.productId))) add({ area: 'purchase order', item, ok: false, problem: 'a line has no product, quantity or cost', fix: 'cancel_purchase_order and draft it again' });
    else if (!near(sum, po.totalCost)) add({ area: 'purchase order', item, ok: false, problem: `lines add up to RM${sum} but the total says RM${po.totalCost}` });
    else if (po.status === 'draft' && po.totalCost > cash) add({ area: 'purchase order', item, ok: false, problem: `RM${po.totalCost} is more than the RM${cash} available`, fix: 'reduce the quantity or tell the owner', severity: 'warning' });
    else add({ area: 'purchase order', item, ok: true });
    if (sup && !sup.email) add({ area: 'supplier', item: sup.name, ok: false, problem: 'no email, so the PO cannot be sent', fix: 'update_supplier with an email found on its website', severity: 'warning' });
  }

  // Invoices and quotations: totals match their lines, customer named
  const docs = [
    ...db.invoices.filter((x) => touched('invoice').has(x.invoiceNumber) && x.status !== 'cancelled').map((x) => ({ kind: 'invoice', no: x.invoiceNumber, d: x })),
    ...db.quotations.filter((x) => touched('quotation').has(x.quoteNumber)).map((x) => ({ kind: 'quotation', no: x.quoteNumber, d: x })),
  ];
  for (const { kind, no, d } of docs) {
    const sub = r2(d.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
    if (!d.customerName.trim()) add({ area: kind, item: no, ok: false, problem: 'no customer name', fix: 'add the buyer before it is issued' });
    else if (!d.lines.length || d.lines.some((l) => !(l.quantity > 0) || l.unitPrice < 0)) add({ area: kind, item: no, ok: false, problem: 'empty or invalid line' });
    else if (!near(sub, d.subtotal)) add({ area: kind, item: no, ok: false, problem: `lines add up to RM${sub} but subtotal is RM${d.subtotal}` });
    else if ('dueDate' in d && d.dueDate && d.dueDate < d.issuedDate) add({ area: kind, item: no, ok: false, problem: 'due date is before the issue date' });
    else add({ area: kind, item: no, ok: true });
  }

  // Sales orders: total matches lines
  const sos = touched('sales_order');
  for (const o of db.salesOrders.filter((x) => sos.has(x.orderNumber))) {
    const sum = r2(o.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
    add(near(sum, o.total) ? { area: 'sales order', item: o.orderNumber, ok: true } : { area: 'sales order', item: o.orderNumber, ok: false, problem: `lines add up to RM${sum}, total RM${o.total}` });
  }

  // Marketing content: complete and compliant
  const content = touched('content');
  for (const c of db.contentItems.filter((x) => content.has(x.id))) {
    const blocks = checkCompliance(`${c.title}\n${c.body}`, db).filter((i) => i.level === 'block');
    if (!c.body.trim() || c.body.trim().length < 40) add({ area: 'content', item: c.title, ok: false, problem: 'the text is missing or too short to publish', fix: 'update_content with the full caption' });
    else if (blocks.length) add({ area: 'content', item: c.title, ok: false, problem: `breaks a rule: ${blocks.map((b) => b.match).join(', ')}`, fix: 'update_content and rewrite those words' });
    else if (/\[(product|price|name|link)\]|lorem ipsum|TODO/i.test(c.body)) add({ area: 'content', item: c.title, ok: false, problem: 'still has placeholder text', fix: 'update_content with the real details' });
    else add({ area: 'content', item: c.title, ok: true });
  }

  const pendingApprovals = db.approvals
    .filter((a) => a.status === 'pending' && a.createdAt >= since)
    .map((a) => ({ id: a.id, title: a.title, risk: a.risk }));
  const errors = checks.filter((c) => !c.ok && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warning').length;
  return { passed: errors === 0, errors, warnings, checked: checks.length, checks: checks.filter((c) => !c.ok).concat(checks.filter((c) => c.ok).slice(0, 20)), pendingApprovals };
}
