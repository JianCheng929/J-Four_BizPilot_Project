import type {
  ApprovalRequest,
  ApprovalType,
  BizPilotDB,
  Campaign,
  ContentItem,
  Expense,
  Invoice,
  InvoiceLine,
  Product,
  PurchaseOrder,
  PurchaseOrderLine,
  Review,
  SalesOrder,
  SalesOrderLine,
  Sentiment,
  StockMovement,
  Supplier,
  SupportTicket,
} from './db/types';
import { newId } from './db/defaults';
import { cashPosition } from './metrics';

/**
 * Deterministic business operations (blueprint §15: the database and business
 * logic are the source of truth, not the AI).
 *
 * Every function mutates a draft BizPilotDB in place. The same functions are
 * used by the web app, by approval execution on the server, and by the tools
 * WorkBuddy calls, so a stock deduction or PO receipt behaves identically no
 * matter who triggers it.
 */

const DAY = 86_400_000;
const now = () => new Date().toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;

export class OpError extends Error {}

// ---------------------------------------------------------------- audit & alerts

export function audit(db: BizPilotDB, actor: string, action: string, entity: string, entityId: string, details: string) {
  db.auditLog.unshift({ id: newId(), actor, action, entity, entityId, details, at: now() });
}

export function notify(db: BizPilotDB, title: string, body: string, severity: 'info' | 'warning' | 'critical' = 'info') {
  db.notifications.unshift({ id: newId(), title, body, severity, at: now(), read: false });
}

// ---------------------------------------------------------------- lookups

export function findProduct(db: BizPilotDB, ref: string): Product | undefined {
  const r = ref.trim().toLowerCase();
  return (
    db.products.find((p) => p.id === ref) ??
    db.products.find((p) => p.sku.toLowerCase() === r) ??
    db.products.find((p) => p.barcode && p.barcode === ref) ??
    db.products.find((p) => p.name.toLowerCase() === r) ??
    db.products.find((p) => Object.values(p.channelSkus ?? {}).some((s) => s.toLowerCase() === r))
  );
}

export function requireProduct(db: BizPilotDB, ref: string): Product {
  const p = findProduct(db, ref);
  if (!p) throw new OpError(`No product matches "${ref}". Use an existing product id, SKU or exact name.`);
  return p;
}

export function findSupplier(db: BizPilotDB, ref: string): Supplier | undefined {
  const r = ref.trim().toLowerCase();
  return db.suppliers.find((s) => s.id === ref) ?? db.suppliers.find((s) => s.name.toLowerCase() === r);
}

function nextNumber(existing: string[], prefix: string): string {
  let max = 0;
  for (const n of existing) {
    const m = n.match(/(\d+)$/);
    if (n.startsWith(prefix) && m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(5, '0')}`;
}

export function skuFromName(db: BizPilotDB, name: string): string {
  const base =
    name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'ITEM';
  let sku = base;
  let i = 2;
  while (db.products.some((p) => p.sku === sku)) sku = `${base}-${i++}`;
  return sku;
}

// ---------------------------------------------------------------- products & stock

export interface ProductInput {
  name: string;
  sku?: string;
  category?: string;
  description?: string;
  barcode?: string;
  supplierId?: string | null;
  unitCost?: number;
  price?: number;
  weightKg?: number;
  reorderLevel?: number;
  status?: Product['status'];
  openingStock?: number;
  channelSkus?: Record<string, string>;
}

export function createProduct(db: BizPilotDB, input: ProductInput, actor: string): Product {
  if (!input.name?.trim()) throw new OpError('Product name is required.');
  const sku = input.sku?.trim() || skuFromName(db, input.name);
  if (db.products.some((p) => p.sku.toLowerCase() === sku.toLowerCase())) {
    throw new OpError(`SKU ${sku} already exists.`);
  }
  const product: Product = {
    id: newId(),
    sku,
    name: input.name.trim(),
    category: input.category?.trim() || 'Uncategorised',
    description: input.description ?? '',
    barcode: input.barcode ?? '',
    supplierId: input.supplierId ?? null,
    unitCost: input.unitCost ?? 0,
    price: input.price ?? 0,
    weightKg: input.weightKg ?? 0.5,
    stock: 0,
    reserved: 0,
    incoming: 0,
    reorderLevel: input.reorderLevel ?? 0,
    avgDailySales: 0,
    status: input.status ?? 'active',
    channelSkus: input.channelSkus ?? {},
  };
  db.products.push(product);
  audit(db, actor, 'create', 'product', product.sku, `Product added: ${product.name}`);
  if (input.openingStock && input.openingStock > 0) {
    recordStockMovement(db, product.id, 'in', input.openingStock, 'Opening stock', 'OPENING', actor);
  }
  return product;
}

export function updateProduct(db: BizPilotDB, id: string, patch: Partial<Product>, actor: string): Product {
  const p = db.products.find((x) => x.id === id);
  if (!p) throw new OpError('Product not found.');
  // Stock levels only change through stock movements, never by direct edit.
  const { stock: _s, reserved: _r, incoming: _i, id: _id, ...safe } = patch;
  Object.assign(p, safe);
  audit(db, actor, 'update', 'product', p.sku, `Product updated: ${Object.keys(safe).join(', ')}`);
  return p;
}

/**
 * The only way on-hand stock changes. 'in' adds, 'out' removes, 'adjustment'
 * applies a signed quantity (e.g. stock count correction).
 */
export function recordStockMovement(
  db: BizPilotDB,
  productId: string,
  type: StockMovement['type'],
  quantity: number,
  reason: string,
  reference: string,
  actor: string,
): StockMovement {
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw new OpError('Product not found for stock movement.');
  if (!Number.isFinite(quantity) || quantity === 0) throw new OpError('Quantity must be a non-zero number.');
  if (type !== 'adjustment' && quantity < 0) throw new OpError('Use a positive quantity for in/out movements.');
  const delta = type === 'in' ? quantity : type === 'out' ? -quantity : quantity;
  if (p.stock + delta < 0) {
    throw new OpError(`Not enough stock of ${p.name}: on hand ${p.stock}, requested ${Math.abs(delta)}.`);
  }
  const before = p.stock;
  p.stock += delta;
  const mv: StockMovement = { id: newId(), productId, type, quantity, reason, reference, date: now(), actor };
  db.stockMovements.unshift(mv);
  audit(db, actor, 'stock_' + type, 'product', p.sku, `${p.name}: ${before} → ${p.stock} (${reason})`);
  checkLowStock(db, p);
  return mv;
}

export function availableToSell(p: Product): number {
  return Math.max(0, p.stock - p.reserved);
}

function checkLowStock(db: BizPilotDB, p: Product) {
  if (p.status === 'discontinued') return;
  const avail = availableToSell(p);
  if (avail <= p.reorderLevel) {
    const already = db.notifications.some(
      (n) => !n.read && n.title === `Low stock: ${p.name}`,
    );
    if (!already) {
      notify(db, `Low stock: ${p.name}`, `${avail} available (reorder level ${p.reorderLevel}).`, avail === 0 ? 'critical' : 'warning');
    }
  }
}

/** Average units sold per day over the last `days` days, from real orders. */
export function recalcAvgDailySales(db: BizPilotDB, days = 28) {
  const since = Date.now() - days * DAY;
  const units = new Map<string, number>();
  for (const o of db.salesOrders) {
    if (o.status === 'cancelled' || o.paymentStatus === 'refunded') continue;
    if (new Date(o.date).getTime() < since) continue;
    for (const l of o.lines) if (l.productId) units.set(l.productId, (units.get(l.productId) ?? 0) + l.quantity);
  }
  for (const p of db.products) p.avgDailySales = round2((units.get(p.id) ?? 0) / days);
}

export interface ReorderSuggestion {
  product: Product;
  supplier: Supplier | undefined;
  available: number;
  daysLeft: number | null;
  suggestedQty: number;
  reason: string;
}

/** Products that need replenishing, with a suggested quantity (blueprint B3). */
export function reorderSuggestions(db: BizPilotDB): ReorderSuggestion[] {
  const out: ReorderSuggestion[] = [];
  for (const p of db.products) {
    if (p.status === 'discontinued' || p.status === 'draft') continue;
    const supplier = p.supplierId ? db.suppliers.find((s) => s.id === p.supplierId) : undefined;
    const lead = supplier?.leadTimeDays ?? 7;
    const avail = availableToSell(p);
    const daysLeft = p.avgDailySales > 0 ? Math.floor(avail / p.avgDailySales) : null;
    const projected = avail + p.incoming;
    const lowByLevel = projected <= p.reorderLevel;
    const lowByDays = daysLeft !== null && daysLeft <= Math.max(lead, db.settings.lowStockThresholdDays) && projected - p.avgDailySales * lead < p.reorderLevel + p.avgDailySales * 7;
    if (!lowByLevel && !lowByDays) continue;
    // Cover lead time + 30 days of demand, plus the reorder level as safety stock.
    const target = Math.ceil(p.avgDailySales * (lead + 30) + p.reorderLevel);
    let qty = Math.max(target - projected, p.reorderLevel > 0 ? p.reorderLevel : 1);
    if (supplier?.minOrderQty) qty = Math.max(qty, supplier.minOrderQty);
    out.push({
      product: p,
      supplier,
      available: avail,
      daysLeft,
      suggestedQty: qty,
      reason: lowByLevel
        ? `${projected} available+incoming ≤ reorder level ${p.reorderLevel}`
        : `~${daysLeft} days of stock left vs ${lead}-day lead time`,
    });
  }
  return out.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
}

// ---------------------------------------------------------------- suppliers & purchasing

export function createSupplier(db: BizPilotDB, input: Partial<Supplier> & { name: string }, actor: string): Supplier {
  if (!input.name?.trim()) throw new OpError('Supplier name is required.');
  const s: Supplier = {
    id: newId(),
    name: input.name.trim(),
    contactPerson: input.contactPerson ?? '',
    email: input.email ?? '',
    phone: input.phone ?? '',
    categories: input.categories ?? [],
    unitCost: input.unitCost ?? 0,
    minOrderQty: input.minOrderQty ?? 0,
    leadTimeDays: input.leadTimeDays ?? 7,
    paymentTerms: input.paymentTerms ?? '',
    reliabilityScore: 0,
    onTimeRate: 0,
    defectRate: input.defectRate ?? 0,
    notes: input.notes ?? '',
  };
  db.suppliers.push(s);
  audit(db, actor, 'create', 'supplier', s.id, `Supplier added: ${s.name}`);
  return s;
}

export function updateSupplier(db: BizPilotDB, id: string, patch: Partial<Supplier>, actor: string): Supplier {
  const s = db.suppliers.find((x) => x.id === id);
  if (!s) throw new OpError('Supplier not found.');
  const { id: _id, reliabilityScore: _r, onTimeRate: _o, ...safe } = patch;
  Object.assign(s, safe);
  audit(db, actor, 'update', 'supplier', s.id, `Supplier updated: ${s.name}`);
  return s;
}

/** On-time rate and reliability from real received POs. */
export function recalcSupplierStats(db: BizPilotDB) {
  for (const s of db.suppliers) {
    const received = db.purchaseOrders.filter((po) => po.supplierId === s.id && po.receivedAt);
    if (!received.length) continue;
    const onTime = received.filter((po) => new Date(po.receivedAt!).getTime() <= new Date(po.expectedDate).getTime() + DAY).length;
    let ordered = 0;
    let got = 0;
    for (const po of received) for (const l of po.lines) { ordered += l.quantity; got += Math.min(l.receivedQty ?? 0, l.quantity); }
    const fillRate = ordered ? got / ordered : 1;
    s.onTimeRate = round2(onTime / received.length);
    s.reliabilityScore = Math.round((s.onTimeRate * 0.6 + fillRate * 0.3 + (1 - s.defectRate) * 0.1) * 100);
  }
}

export interface POInput {
  supplierId: string;
  lines: PurchaseOrderLine[];
  note?: string;
  expectedDate?: string;
}

export function createPurchaseOrder(db: BizPilotDB, input: POInput, actor: string, status: PurchaseOrder['status'] = 'draft'): PurchaseOrder {
  const supplier = db.suppliers.find((s) => s.id === input.supplierId);
  if (!supplier) throw new OpError('Supplier not found.');
  if (!input.lines.length) throw new OpError('A purchase order needs at least one line.');
  for (const l of input.lines) {
    if (!db.products.some((p) => p.id === l.productId)) throw new OpError(`Unknown product ${l.productId}.`);
    if (!(l.quantity > 0)) throw new OpError('Line quantities must be positive.');
  }
  const po: PurchaseOrder = {
    id: newId(),
    poNumber: nextNumber(db.purchaseOrders.map((p) => p.poNumber), 'PO'),
    supplierId: supplier.id,
    lines: input.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, receivedQty: 0 })),
    status,
    totalCost: round2(input.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0)),
    expectedDate: input.expectedDate ?? new Date(Date.now() + supplier.leadTimeDays * DAY).toISOString(),
    createdAt: now(),
    receivedAt: null,
    sentAt: null,
    note: input.note ?? '',
  };
  db.purchaseOrders.unshift(po);
  audit(db, actor, 'create', 'purchase_order', po.poNumber, `${po.poNumber} for ${supplier.name} (RM${po.totalCost.toFixed(2)}) – ${status}`);
  return po;
}

/** Stock is paid for with real money: never place an order the business can't pay for. */
export function assertCashFor(db: BizPilotDB, amount: number, what: string) {
  const cash = cashPosition(db).balance;
  if (amount <= cash) return;
  throw new OpError(
    `Not enough cash for ${what}: it costs RM${amount.toFixed(2)} but only RM${cash.toFixed(2)} is available. ` +
    (db.settings.openingCashDate ? 'Record sales, add capital in Settings, or order less.' : 'Enter your starting capital in Settings → Business first.'),
  );
}

/** Approved PO is placed with the supplier: stock becomes "incoming". */
export function placePurchaseOrder(db: BizPilotDB, poId: string, actor: string): PurchaseOrder {
  const po = db.purchaseOrders.find((p) => p.id === poId);
  if (!po) throw new OpError('Purchase order not found.');
  if (!['draft', 'pending_approval', 'approved'].includes(po.status)) throw new OpError(`${po.poNumber} is already ${po.status}.`);
  assertCashFor(db, po.totalCost, po.poNumber);
  po.status = 'ordered';
  po.sentAt = now();
  for (const l of po.lines) {
    const p = db.products.find((x) => x.id === l.productId);
    if (p) p.incoming += l.quantity;
  }
  audit(db, actor, 'execute', 'purchase_order', po.poNumber, `${po.poNumber} placed with supplier`);
  return po;
}

/** Goods received: on-hand goes up, incoming goes down, supplier stats update. */
export function receivePurchaseOrder(
  db: BizPilotDB,
  poId: string,
  received: Record<string, number> | 'all',
  actor: string,
): PurchaseOrder {
  const po = db.purchaseOrders.find((p) => p.id === poId);
  if (!po) throw new OpError('Purchase order not found.');
  if (po.status !== 'ordered' && po.status !== 'partially_received') throw new OpError(`${po.poNumber} is ${po.status}; only ordered POs can be received.`);
  for (const l of po.lines) {
    const outstanding = l.quantity - (l.receivedQty ?? 0);
    const qty = received === 'all' ? outstanding : Math.min(received[l.productId] ?? 0, outstanding);
    if (qty <= 0) continue;
    l.receivedQty = (l.receivedQty ?? 0) + qty;
    const p = db.products.find((x) => x.id === l.productId);
    if (p) {
      p.incoming = Math.max(0, p.incoming - qty);
      if (l.unitCost > 0) {
        // weighted average cost
        const totalUnits = p.stock + qty;
        p.unitCost = round2(totalUnits > 0 ? (p.unitCost * p.stock + l.unitCost * qty) / totalUnits : l.unitCost);
      }
      recordStockMovement(db, p.id, 'in', qty, `Received ${po.poNumber}`, po.poNumber, actor);
    }
  }
  const complete = po.lines.every((l) => (l.receivedQty ?? 0) >= l.quantity);
  po.status = complete ? 'received' : 'partially_received';
  if (complete) po.receivedAt = now();
  recalcSupplierStats(db);
  audit(db, actor, 'receive', 'purchase_order', po.poNumber, `${po.poNumber} ${po.status}`);
  return po;
}

export function cancelPurchaseOrder(db: BizPilotDB, poId: string, actor: string) {
  const po = db.purchaseOrders.find((p) => p.id === poId);
  if (!po) throw new OpError('Purchase order not found.');
  if (po.status === 'received' || po.status === 'cancelled') throw new OpError(`${po.poNumber} is already ${po.status}.`);
  if (po.status === 'ordered' || po.status === 'partially_received') {
    for (const l of po.lines) {
      const p = db.products.find((x) => x.id === l.productId);
      if (p) p.incoming = Math.max(0, p.incoming - (l.quantity - (l.receivedQty ?? 0)));
    }
  }
  po.status = 'cancelled';
  audit(db, actor, 'cancel', 'purchase_order', po.poNumber, `${po.poNumber} cancelled`);
}

// ---------------------------------------------------------------- sales orders

export interface SalesOrderInput {
  channel: SalesOrder['channel'];
  source?: SalesOrder['source'];
  externalId?: string | null;
  orderNumber?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  shippingAddress?: string;
  shippingPostcode?: string;
  lines: SalesOrderLine[];
  paymentStatus?: SalesOrder['paymentStatus'];
  paymentMethod?: string;
  date?: string;
  /** POS / walk-in sales are handed over immediately */
  fulfilNow?: boolean;
}

export function createSalesOrder(db: BizPilotDB, input: SalesOrderInput, actor: string): SalesOrder {
  if (!input.lines.length) throw new OpError('An order needs at least one line.');
  if (input.externalId && db.salesOrders.some((o) => o.source === input.source && o.externalId === input.externalId)) {
    throw new OpError(`Order ${input.externalId} from ${input.source} was already imported.`);
  }
  const lines = input.lines.map((l) => {
    const p = l.productId ? db.products.find((x) => x.id === l.productId) : undefined;
    return { ...l, name: l.name ?? p?.name, sku: l.sku ?? p?.sku };
  });
  const prefix = input.channel === 'retail' ? 'POS' : 'SO';
  const order: SalesOrder = {
    id: newId(),
    orderNumber: input.orderNumber ?? nextNumber(db.salesOrders.map((o) => o.orderNumber), prefix),
    channel: input.channel,
    source: input.source ?? (input.channel === 'retail' ? 'pos' : 'manual'),
    externalId: input.externalId ?? null,
    customerName: input.customerName ?? (input.channel === 'retail' ? 'Walk-in customer' : ''),
    customerEmail: input.customerEmail ?? '',
    customerPhone: input.customerPhone ?? '',
    shippingAddress: input.shippingAddress ?? '',
    shippingPostcode: input.shippingPostcode ?? '',
    lines,
    total: round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)),
    status: 'awaiting_fulfilment',
    paymentStatus: input.paymentStatus ?? 'paid',
    paymentMethod: input.paymentMethod ?? '',
    date: input.date ?? now(),
    shipment: null,
    invoiceId: null,
  };
  // Reserve stock so it can't be oversold (blueprint B5)
  for (const l of order.lines) {
    if (!l.productId) continue;
    const p = db.products.find((x) => x.id === l.productId);
    if (p) p.reserved += l.quantity;
  }
  db.salesOrders.unshift(order);
  audit(db, actor, 'create', 'sales_order', order.orderNumber, `${order.orderNumber} ${order.source} RM${order.total.toFixed(2)}`);
  if (input.fulfilNow) fulfilSalesOrder(db, order.id, actor);
  recalcAvgDailySales(db);
  return order;
}

export function fulfilSalesOrder(db: BizPilotDB, orderId: string, actor: string): SalesOrder {
  const o = db.salesOrders.find((x) => x.id === orderId);
  if (!o) throw new OpError('Order not found.');
  if (o.status !== 'awaiting_fulfilment') throw new OpError(`${o.orderNumber} is ${o.status}.`);
  // Check everything first so a failure leaves no partial deduction
  for (const l of o.lines) {
    if (!l.productId) continue;
    const p = db.products.find((x) => x.id === l.productId);
    if (p && p.stock < l.quantity) throw new OpError(`Not enough ${p.name} on hand (${p.stock}) to fulfil ${o.orderNumber}.`);
  }
  for (const l of o.lines) {
    if (!l.productId) continue;
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) continue;
    p.reserved = Math.max(0, p.reserved - l.quantity);
    recordStockMovement(db, p.id, 'out', l.quantity, `Sold – ${o.orderNumber}`, o.orderNumber, actor);
  }
  o.status = 'fulfilled';
  audit(db, actor, 'fulfil', 'sales_order', o.orderNumber, `${o.orderNumber} fulfilled`);
  return o;
}

export function cancelSalesOrder(db: BizPilotDB, orderId: string, actor: string, refund = false): SalesOrder {
  const o = db.salesOrders.find((x) => x.id === orderId);
  if (!o) throw new OpError('Order not found.');
  if (o.status === 'cancelled') return o;
  for (const l of o.lines) {
    if (!l.productId) continue;
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) continue;
    if (o.status === 'awaiting_fulfilment') p.reserved = Math.max(0, p.reserved - l.quantity);
    else recordStockMovement(db, p.id, 'in', l.quantity, `Returned – ${o.orderNumber}`, o.orderNumber, actor);
  }
  o.status = 'cancelled';
  if (refund) o.paymentStatus = 'refunded';
  audit(db, actor, 'cancel', 'sales_order', o.orderNumber, `${o.orderNumber} cancelled${refund ? ' and refunded' : ''}`);
  recalcAvgDailySales(db);
  return o;
}

// ---------------------------------------------------------------- invoices

export interface InvoiceInput {
  type?: Invoice['type'];
  customerName: string;
  customerEmail?: string;
  customerTin?: string;
  customerBrn?: string;
  customerPhone?: string;
  customerAddress?: string;
  lines: InvoiceLine[];
  dueDays?: number;
  orderId?: string | null;
}

export function invoiceTotals(lines: InvoiceLine[]) {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const amt = l.quantity * l.unitPrice;
    subtotal += amt;
    tax += amt * ((l.taxRate ?? 0) / 100);
  }
  return { subtotal: round2(subtotal), taxTotal: round2(tax), total: round2(subtotal + tax) };
}

export function createInvoice(db: BizPilotDB, input: InvoiceInput, actor: string): Invoice {
  if (!input.lines.length) throw new OpError('An invoice needs at least one line.');
  const totals = invoiceTotals(input.lines);
  const prefix = input.type === 'credit_note' ? 'CN' : db.settings.invoicePrefix || 'INV';
  const inv: Invoice = {
    id: newId(),
    invoiceNumber: nextNumber(db.invoices.map((i) => i.invoiceNumber), prefix),
    type: input.type ?? 'invoice',
    customerName: input.customerName,
    customerEmail: input.customerEmail ?? '',
    customerTin: input.customerTin ?? '',
    customerBrn: input.customerBrn ?? '',
    customerPhone: input.customerPhone ?? '',
    customerAddress: input.customerAddress ?? '',
    lines: input.lines.map((l) => ({ ...l, classificationCode: l.classificationCode ?? '022' })),
    ...totals,
    status: 'draft',
    issuedDate: now(),
    dueDate: new Date(Date.now() + (input.dueDays ?? 30) * DAY).toISOString(),
    paidDate: null,
    orderId: input.orderId ?? null,
    einvoice: { status: 'not_submitted' },
  };
  db.invoices.unshift(inv);
  audit(db, actor, 'create', 'invoice', inv.invoiceNumber, `Draft ${inv.type} ${inv.invoiceNumber} RM${inv.total.toFixed(2)}`);
  return inv;
}

export function createInvoiceFromOrder(db: BizPilotDB, orderId: string, buyer: Partial<InvoiceInput>, actor: string): Invoice {
  const o = db.salesOrders.find((x) => x.id === orderId);
  if (!o) throw new OpError('Order not found.');
  if (o.invoiceId) throw new OpError(`${o.orderNumber} already has an invoice.`);
  const rate = db.settings.defaultTaxRate ?? 0;
  const inv = createInvoice(
    db,
    {
      customerName: buyer.customerName || o.customerName || 'Customer',
      customerEmail: buyer.customerEmail ?? o.customerEmail,
      customerPhone: buyer.customerPhone ?? o.customerPhone,
      customerAddress: buyer.customerAddress ?? o.shippingAddress,
      customerTin: buyer.customerTin,
      customerBrn: buyer.customerBrn,
      orderId: o.id,
      dueDays: o.paymentStatus === 'paid' ? 0 : buyer.dueDays ?? 30,
      lines: o.lines.map((l) => ({
        description: l.name ?? l.sku ?? 'Item',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRate: rate,
        productId: l.productId,
      })),
    },
    actor,
  );
  o.invoiceId = inv.id;
  return inv;
}

export function issueInvoice(db: BizPilotDB, invoiceId: string, actor: string): Invoice {
  const inv = db.invoices.find((i) => i.id === invoiceId);
  if (!inv) throw new OpError('Invoice not found.');
  if (inv.status !== 'draft') throw new OpError(`${inv.invoiceNumber} is already ${inv.status}.`);
  inv.status = 'issued';
  inv.issuedDate = now();
  const order = inv.orderId ? db.salesOrders.find((o) => o.id === inv.orderId) : undefined;
  if (order?.paymentStatus === 'paid') { inv.status = 'paid'; inv.paidDate = now(); }
  audit(db, actor, 'issue', 'invoice', inv.invoiceNumber, `${inv.invoiceNumber} issued`);
  return inv;
}

export function markInvoicePaid(db: BizPilotDB, invoiceId: string, actor: string): Invoice {
  const inv = db.invoices.find((i) => i.id === invoiceId);
  if (!inv) throw new OpError('Invoice not found.');
  if (inv.status === 'cancelled' || inv.status === 'draft') throw new OpError(`${inv.invoiceNumber} is ${inv.status}.`);
  inv.status = 'paid';
  inv.paidDate = now();
  audit(db, actor, 'paid', 'invoice', inv.invoiceNumber, `${inv.invoiceNumber} marked paid`);
  return inv;
}

/** Issued invoices past their due date become overdue (blueprint D6). */
export function refreshOverdue(db: BizPilotDB) {
  for (const inv of db.invoices) {
    if (inv.status === 'issued' && new Date(inv.dueDate).getTime() < Date.now() - DAY) {
      inv.status = 'overdue';
      notify(db, `Invoice overdue: ${inv.invoiceNumber}`, `${inv.customerName} owes RM${inv.total.toFixed(2)}.`, 'warning');
    }
  }
}

// ---------------------------------------------------------------- expenses

export function addExpense(db: BizPilotDB, e: Omit<Expense, 'id'>, actor: string): Expense {
  if (!(e.amount > 0)) throw new OpError('Expense amount must be positive.');
  const exp: Expense = { ...e, id: newId() };
  db.expenses.unshift(exp);
  audit(db, actor, 'create', 'expense', exp.id, `Expense RM${e.amount.toFixed(2)} (${e.category})`);
  return exp;
}

// ---------------------------------------------------------------- customer experience

const TOPIC_WORDS: [string, RegExp][] = [
  ['delivery', /deliver|shipping|courier|late|arriv|parcel|pos laju|j&t|ninja/i],
  ['packaging', /packag|box|wrap|bubble|dent|crush/i],
  ['quality', /quality|broke|broken|defect|fake|damage|tear|smell|taste|expired|rosak/i],
  ['price', /price|expensive|cheap|mahal|murah|worth/i],
  ['service', /service|seller|reply|respon|rude|staff|helpful|friendly/i],
  ['value', /value|recommend|repeat|again|best/i],
];

/** Rule-based first pass; WorkBuddy can re-tag with tag_review. */
export function classifyReview(rating: number, text: string): { sentiment: Sentiment; topic: string } {
  const sentiment: Sentiment = rating <= 2 ? 'negative' : rating >= 4 ? 'positive' : 'neutral';
  const topic = TOPIC_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
  return { sentiment, topic };
}

export function addReview(
  db: BizPilotDB,
  input: Pick<Review, 'source' | 'customerName' | 'rating' | 'text'> & Partial<Review>,
  actor: string,
): Review | null {
  if (input.externalId && db.reviews.some((r) => r.source === input.source && r.externalId === input.externalId)) {
    return null; // duplicate sync (blueprint E1)
  }
  const rating = Math.min(5, Math.max(1, Math.round(input.rating)));
  const auto = classifyReview(rating, input.text);
  const r: Review = {
    id: newId(),
    source: input.source,
    externalId: input.externalId ?? null,
    productId: input.productId ?? null,
    customerName: input.customerName,
    rating,
    text: input.text,
    sentiment: input.sentiment ?? auto.sentiment,
    topic: input.topic ?? auto.topic,
    status: 'new',
    date: input.date ?? now(),
  };
  db.reviews.unshift(r);
  audit(db, actor, 'create', 'review', r.id, `${r.rating}★ review from ${r.source}`);
  if (r.sentiment === 'negative') notify(db, `Negative review (${r.rating}★)`, `${r.customerName} on ${r.source}: ${r.text.slice(0, 80)}`, 'warning');
  return r;
}

export function addTicket(db: BizPilotDB, t: Pick<SupportTicket, 'subject'> & Partial<SupportTicket>, actor: string): SupportTicket {
  const ticket: SupportTicket = {
    id: newId(),
    subject: t.subject,
    customerName: t.customerName ?? '',
    customerEmail: t.customerEmail ?? '',
    body: t.body ?? '',
    priority: t.priority ?? 'medium',
    status: 'open',
    createdAt: now(),
    resolvedAt: null,
    notes: '',
  };
  db.tickets.unshift(ticket);
  audit(db, actor, 'create', 'ticket', ticket.id, `Ticket: ${ticket.subject}`);
  return ticket;
}

export function updateTicket(db: BizPilotDB, id: string, patch: Partial<SupportTicket>, actor: string): SupportTicket {
  const t = db.tickets.find((x) => x.id === id);
  if (!t) throw new OpError('Ticket not found.');
  Object.assign(t, patch);
  if (patch.status === 'resolved') t.resolvedAt = now();
  audit(db, actor, 'update', 'ticket', t.id, `Ticket ${t.subject}: ${t.status}`);
  return t;
}

// ---------------------------------------------------------------- marketing

export function addContentItem(db: BizPilotDB, c: Omit<ContentItem, 'id' | 'status'> & { status?: ContentItem['status'] }, actor: string): ContentItem {
  const item: ContentItem = { ...c, id: newId(), status: c.status ?? 'draft', imageUrl: c.imageUrl ?? '' };
  db.contentItems.unshift(item);
  audit(db, actor, 'create', 'content', item.id, `${item.platform} ${item.type} draft: ${item.title}`);
  return item;
}

export function addCampaign(db: BizPilotDB, c: Pick<Campaign, 'name'> & Partial<Campaign>, actor: string): Campaign {
  const camp: Campaign = {
    id: newId(),
    name: c.name,
    objective: c.objective ?? 'sales',
    platform: c.platform ?? '',
    budget: c.budget ?? 0,
    dailyCap: c.dailyCap ?? 0,
    spend: c.spend ?? 0,
    clicks: c.clicks ?? 0,
    impressions: c.impressions ?? 0,
    conversions: c.conversions ?? 0,
    revenue: c.revenue ?? 0,
    status: 'draft',
    startDate: c.startDate ?? null,
    endDate: c.endDate ?? null,
    externalId: c.externalId ?? null,
  };
  db.campaigns.unshift(camp);
  audit(db, actor, 'create', 'campaign', camp.id, `Campaign draft: ${camp.name}`);
  return camp;
}

// ---------------------------------------------------------------- approvals

export interface ApprovalInput {
  type: ApprovalType;
  title: string;
  description: string;
  payload: Record<string, unknown>;
  amount?: number;
  risk?: 'low' | 'medium' | 'high';
}

export function requestApproval(db: BizPilotDB, input: ApprovalInput, actor: string): ApprovalRequest {
  const limit = db.settings.approvalLimitAmount || 500;
  const req: ApprovalRequest = {
    id: newId(),
    type: input.type,
    title: input.title,
    description: input.description,
    payload: input.payload,
    amount: input.amount ?? null,
    risk: input.risk ?? (input.amount && input.amount > limit * 2 ? 'high' : input.amount && input.amount > limit ? 'medium' : 'low'),
    status: 'pending',
    executionStatus: 'not_started',
    executionResult: null,
    requestedBy: actor,
    createdAt: now(),
    decidedAt: null,
    decidedBy: null,
  };
  db.approvals.unshift(req);
  // keep PO status in sync with the approval queue
  if (input.type === 'purchase_order' && typeof input.payload.purchaseOrderId === 'string') {
    const po = db.purchaseOrders.find((p) => p.id === input.payload.purchaseOrderId);
    if (po && po.status === 'draft') po.status = 'pending_approval';
  }
  audit(db, actor, 'request', 'approval', req.id, `Approval requested: ${req.title}`);
  notify(db, 'Approval needed', req.title, req.risk === 'high' ? 'critical' : 'info');
  return req;
}

/**
 * Database side of an approved action. External side effects (publishing to
 * Meta, submitting to MyInvois, booking EasyParcel) are done by the server
 * before this runs; `external` carries what they returned.
 */
export function applyApprovedAction(db: BizPilotDB, req: ApprovalRequest, actor: string, external: Record<string, unknown> = {}): string {
  const p = req.payload as Record<string, any>;
  switch (req.type) {
    case 'purchase_order': {
      let poId = p.purchaseOrderId as string | undefined;
      if (!poId) poId = createPurchaseOrder(db, { supplierId: p.supplierId, lines: p.lines, note: p.note }, actor, 'approved').id;
      const po = placePurchaseOrder(db, poId, actor);
      return `${po.poNumber} placed (RM${po.totalCost.toFixed(2)}).`;
    }
    case 'price_change': {
      const prod = db.products.find((x) => x.id === p.productId);
      if (!prod) throw new OpError('Product no longer exists.');
      const old = prod.price;
      prod.price = round2(Number(p.newPrice));
      audit(db, actor, 'execute', 'product', prod.sku, `Price ${prod.name}: RM${old} → RM${prod.price}`);
      return `${prod.name} price changed RM${old} → RM${prod.price}.`;
    }
    case 'marketing_publish': {
      const c = db.contentItems.find((x) => x.id === p.contentId);
      if (!c) throw new OpError('Content item no longer exists.');
      if (external.postId) {
        c.status = 'published';
        c.externalPostId = String(external.postId);
        c.publishedAt = now();
        c.error = null;
        return `Published to ${c.platform} (post ${c.externalPostId}).`;
      }
      c.status = 'scheduled';
      return `${c.title} approved and scheduled for ${new Date(c.scheduledDate).toLocaleString('en-MY')}.`;
    }
    case 'review_response': {
      const r = db.reviews.find((x) => x.id === p.reviewId);
      if (!r) throw new OpError('Review no longer exists.');
      r.status = 'responded';
      r.postedResponse = String(p.response ?? r.draftResponse ?? '');
      r.draftResponse = r.postedResponse;
      return external.sentTo ? `Reply emailed to ${external.sentTo}.` : 'Reply approved and recorded. Post it on the platform if it has no reply API.';
    }
    case 'invoice_issue': {
      const inv = issueInvoice(db, p.invoiceId, actor);
      return `${inv.invoiceNumber} issued${external.sentTo ? ` and emailed to ${external.sentTo}` : ''}.`;
    }
    case 'einvoice_submit': {
      const inv = db.invoices.find((x) => x.id === p.invoiceId);
      if (!inv) throw new OpError('Invoice no longer exists.');
      inv.einvoice = { ...inv.einvoice, ...(external.einvoice as object) };
      if (inv.status === 'draft') issueInvoice(db, inv.id, actor);
      return `${inv.invoiceNumber} submitted to MyInvois (${inv.einvoice.status}).`;
    }
    case 'shipment_booking': {
      const o = db.salesOrders.find((x) => x.id === p.orderId);
      if (!o) throw new OpError('Order no longer exists.');
      o.shipment = { ...(o.shipment ?? { courier: String(p.courier ?? '') }), ...(external.shipment as object) } as SalesOrder['shipment'];
      audit(db, actor, 'execute', 'sales_order', o.orderNumber, `Shipment booked: ${o.shipment?.courier} ${o.shipment?.trackingNo ?? ''}`);
      return `Shipment booked for ${o.orderNumber}${o.shipment?.trackingNo ? `, tracking ${o.shipment.trackingNo}` : ''}.`;
    }
    case 'stock_adjustment': {
      const mv = recordStockMovement(db, p.productId, 'adjustment', Number(p.quantity), String(p.reason ?? 'Stock count adjustment'), 'ADJ', actor);
      return `Stock adjusted by ${mv.quantity}.`;
    }
    case 'customer_message': {
      return external.sentTo ? `Message emailed to ${external.sentTo}.` : 'Message approved.';
    }
  }
}
