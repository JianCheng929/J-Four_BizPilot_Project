import type {
  ApprovalRequest,
  ApprovalType,
  BizPilotDB,
  Campaign,
  ContentItem,
  Expense,
  Invoice,
  InvoiceLine,
  Location,
  StockCount,
  StockTransfer,
  Product,
  PurchaseOrder,
  ReturnCase,
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
  safetyStock?: number;
  maxStock?: number;
  orderMultiple?: number;
  expiryDate?: string;
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
    unavailable: 0,
    incoming: 0,
    reorderLevel: input.reorderLevel ?? 0,
    safetyStock: input.safetyStock ?? 0,
    maxStock: input.maxStock ?? 0,
    orderMultiple: Math.max(1, input.orderMultiple ?? 1),
    expiryDate: input.expiryDate ?? '',
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
  const { stock: _s, reserved: _r, incoming: _i, unavailable: _u, id: _id, ...safe } = patch;
  Object.assign(p, safe);
  if (!(p.orderMultiple >= 1)) p.orderMultiple = 1;
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
  opts: { locationId?: string | null; strict?: boolean } = {},
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
  const locationId = applyLocationDelta(db, p, delta, opts);
  p.stock += delta;
  // Writing off damaged or expired goods removes them from held stock first.
  if (type === 'out' && (p.unavailable || 0) > 0 && /damag|expir|quarantin|defect/i.test(reason)) {
    p.unavailable = Math.max(0, p.unavailable - quantity);
  }
  if ((p.unavailable || 0) > p.stock) p.unavailable = p.stock;
  const mv: StockMovement = { id: newId(), productId, type, quantity, reason, reference, date: now(), actor };
  if (locationId) mv.locationId = locationId;
  db.stockMovements.unshift(mv);
  const where = locationId ? ` at ${db.locations.find((l) => l.id === locationId)?.name ?? 'location'}` : '';
  audit(db, actor, 'stock_' + type, 'product', p.sku, `${p.name}: ${before} → ${p.stock}${where} (${reason})`);
  checkLowStock(db, p);
  return mv;
}

// ---------------------------------------------------------------- locations (blueprint §3, A5, B5)

/** Key in Product.locationStock for units on a transfer between locations. */
export const IN_TRANSIT = '__transit__';

export function defaultLocation(db: BizPilotDB): Location | null {
  return db.locations.find((l) => l.isDefault && l.active) ?? db.locations.find((l) => l.active) ?? null;
}

/** Units per location, with stock not yet assigned to a location counted at the default location. */
export function locationBreakdown(db: BizPilotDB, p: Product): Record<string, number> {
  const def = defaultLocation(db);
  const ls: Record<string, number> = { ...(p.locationStock ?? {}) };
  if (!def) return ls;
  const assigned = Object.values(ls).reduce((a, b) => a + b, 0);
  const loose = p.stock - assigned;
  if (loose !== 0) ls[def.id] = (ls[def.id] ?? 0) + loose;
  return ls;
}

/** Units of a product at one location. '' or no locations = the whole business. */
export function stockAt(db: BizPilotDB, p: Product, locationId?: string | null): number {
  if (!locationId || !db.locations.length) return p.stock;
  return Math.max(0, locationBreakdown(db, p)[locationId] ?? 0);
}

function tidy(ls: Record<string, number>) {
  for (const k of Object.keys(ls)) if (!ls[k]) delete ls[k];
  return ls;
}

/**
 * Apply a stock change to the per-location numbers. Units leave the chosen
 * location first; unless `strict`, any shortfall is taken from the other
 * locations with the most stock. Returns the location used, or null when the
 * business has no locations.
 */
function applyLocationDelta(db: BizPilotDB, p: Product, delta: number, opts: { locationId?: string | null; strict?: boolean }): string | null {
  const def = defaultLocation(db);
  if (!def) return null;
  const loc = opts.locationId || def.id;
  const location = db.locations.find((l) => l.id === loc);
  if (!location) throw new OpError('That location does not exist.');
  const ls = locationBreakdown(db, p);
  if (delta >= 0) {
    ls[loc] = (ls[loc] ?? 0) + delta;
  } else {
    let need = -delta;
    const here = Math.max(0, ls[loc] ?? 0);
    if (opts.strict && here < need) throw new OpError(`Only ${here} of ${p.name} at ${location.name}.`);
    const take = (id: string) => {
      const have = Math.max(0, ls[id] ?? 0);
      const t = Math.min(have, need);
      ls[id] = have - t;
      need -= t;
    };
    take(loc);
    const others = Object.keys(ls).filter((id) => id !== loc && id !== IN_TRANSIT).sort((a, b) => (ls[b] ?? 0) - (ls[a] ?? 0));
    for (const id of others) if (need > 0) take(id);
    if (need > 0) throw new OpError(`Not enough ${p.name} outside transfers in progress: ${need} more needed.`);
  }
  p.locationStock = tidy(ls);
  return loc;
}

export interface LocationInput {
  name: string;
  type?: Location['type'];
  address?: string;
  isDefault?: boolean;
}

export function createLocation(db: BizPilotDB, input: LocationInput, actor: string): Location {
  const name = input.name?.trim();
  if (!name) throw new OpError('Location name is required.');
  if (db.locations.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new OpError(`A location called ${name} already exists.`);
  const first = db.locations.length === 0;
  const loc: Location = { id: newId(), name, type: input.type ?? 'store', address: input.address?.trim() ?? '', isDefault: first, active: true, createdAt: now() };
  db.locations.push(loc);
  if (first) {
    // Everything already on hand is at the first location.
    for (const p of db.products) if (p.stock > 0) p.locationStock = { [loc.id]: p.stock };
  } else if (input.isDefault) setDefaultLocation(db, loc.id, actor);
  audit(db, actor, 'create', 'location', loc.id, `Location ${name} (${loc.type})${first ? ', default; all current stock placed here' : ''}`);
  return loc;
}

export function setDefaultLocation(db: BizPilotDB, id: string, actor: string) {
  const loc = db.locations.find((l) => l.id === id);
  if (!loc) throw new OpError('Location not found.');
  if (!loc.active) throw new OpError('Reactivate the location first.');
  // Pin unassigned units to the old default before switching, so nothing moves.
  for (const p of db.products) p.locationStock = tidy(locationBreakdown(db, p));
  db.locations.forEach((l) => (l.isDefault = l.id === id));
  audit(db, actor, 'update', 'location', id, `${loc.name} is now the default location`);
}

export function updateLocation(db: BizPilotDB, id: string, patch: Partial<Pick<Location, 'name' | 'type' | 'address' | 'active'>>, actor: string): Location {
  const loc = db.locations.find((l) => l.id === id);
  if (!loc) throw new OpError('Location not found.');
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) throw new OpError('Location name is required.');
    if (db.locations.some((l) => l.id !== id && l.name.toLowerCase() === n.toLowerCase())) throw new OpError(`A location called ${n} already exists.`);
    loc.name = n;
  }
  if (patch.type) loc.type = patch.type;
  if (patch.address !== undefined) loc.address = patch.address.trim();
  if (patch.active === false && loc.active) {
    const units = db.products.reduce((s, p) => s + stockAt(db, p, id), 0);
    if (units > 0) throw new OpError(`${loc.name} still holds ${units} unit(s). Transfer them out first.`);
    if (db.transfers.some((t) => t.status === 'in_transit' && (t.fromLocationId === id || t.toLocationId === id))) throw new OpError(`${loc.name} has transfers in progress.`);
    if (loc.isDefault) throw new OpError('Make another location the default first.');
    loc.active = false;
  } else if (patch.active === true) loc.active = true;
  audit(db, actor, 'update', 'location', id, `Location ${loc.name} updated`);
  return loc;
}

// ---------------------------------------------------------------- transfers

export interface TransferInput {
  fromLocationId: string;
  toLocationId: string;
  lines: { productId: string; quantity: number }[];
  note?: string;
}

export function createTransfer(db: BizPilotDB, input: TransferInput, actor: string, shipNow = false): StockTransfer {
  const from = db.locations.find((l) => l.id === input.fromLocationId && l.active);
  const to = db.locations.find((l) => l.id === input.toLocationId && l.active);
  if (!from || !to) throw new OpError('Choose two active locations.');
  if (from.id === to.id) throw new OpError('From and to must be different locations.');
  const lines = input.lines.filter((l) => l.quantity);
  if (!lines.length) throw new OpError('Add at least one product to transfer.');
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new OpError('Transfer quantities must be whole numbers above 0.');
    if (!db.products.some((p) => p.id === l.productId)) throw new OpError('Unknown product on the transfer.');
  }
  const t: StockTransfer = {
    id: newId(),
    transferNumber: nextNumber(db.transfers.map((x) => x.transferNumber), 'TRF'),
    fromLocationId: from.id,
    toLocationId: to.id,
    lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, receivedQty: 0 })),
    status: 'draft',
    note: input.note?.trim() ?? '',
    createdAt: now(),
    shippedAt: null,
    receivedAt: null,
    createdBy: actor,
  };
  db.transfers.unshift(t);
  audit(db, actor, 'create', 'transfer', t.transferNumber, `${t.transferNumber}: ${from.name} → ${to.name}, ${lines.length} line(s)`);
  if (shipNow) shipTransfer(db, t.id, actor);
  return t;
}

/** Goods leave the source location and are "in transit" until received. */
export function shipTransfer(db: BizPilotDB, id: string, actor: string): StockTransfer {
  const t = db.transfers.find((x) => x.id === id || x.transferNumber === id);
  if (!t) throw new OpError('Transfer not found.');
  if (t.status !== 'draft') throw new OpError(`${t.transferNumber} is already ${t.status.replace('_', ' ')}.`);
  const from = db.locations.find((l) => l.id === t.fromLocationId)!;
  const to = db.locations.find((l) => l.id === t.toLocationId)!;
  // Check every line first so a shortage leaves nothing half-moved.
  for (const l of t.lines) {
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) throw new OpError('A product on this transfer no longer exists.');
    const here = stockAt(db, p, from.id);
    if (here < l.quantity) throw new OpError(`Only ${here} of ${p.name} at ${from.name}; the transfer needs ${l.quantity}.`);
  }
  for (const l of t.lines) {
    const p = db.products.find((x) => x.id === l.productId)!;
    const ls = locationBreakdown(db, p);
    ls[from.id] = (ls[from.id] ?? 0) - l.quantity;
    ls[IN_TRANSIT] = (ls[IN_TRANSIT] ?? 0) + l.quantity;
    p.locationStock = tidy(ls);
    db.stockMovements.unshift({ id: newId(), productId: p.id, type: 'transfer', quantity: l.quantity, reason: `Shipped ${t.transferNumber} to ${to.name}`, reference: t.transferNumber, date: now(), actor, locationId: from.id, toLocationId: to.id });
  }
  t.status = 'in_transit';
  t.shippedAt = now();
  audit(db, actor, 'ship', 'transfer', t.transferNumber, `${t.transferNumber} left ${from.name}`);
  return t;
}

/**
 * Goods arrive. `received` gives units per product (default: everything sent).
 * Units sent but not received are written off as lost in transit and the owner is told.
 */
export function receiveTransfer(db: BizPilotDB, id: string, received: Record<string, number> | 'all', actor: string): StockTransfer {
  const t = db.transfers.find((x) => x.id === id || x.transferNumber === id);
  if (!t) throw new OpError('Transfer not found.');
  if (t.status !== 'in_transit') throw new OpError(`${t.transferNumber} is ${t.status.replace('_', ' ')}; only transfers in transit can be received.`);
  const to = db.locations.find((l) => l.id === t.toLocationId)!;
  const short: string[] = [];
  for (const l of t.lines) {
    const got = received === 'all' ? l.quantity : Math.max(0, Math.min(l.quantity, Math.floor(Number(received[l.productId] ?? 0))));
    l.receivedQty = got;
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) continue;
    const ls = locationBreakdown(db, p);
    ls[IN_TRANSIT] = Math.max(0, (ls[IN_TRANSIT] ?? 0) - l.quantity);
    ls[to.id] = (ls[to.id] ?? 0) + got;
    p.locationStock = tidy(ls);
    db.stockMovements.unshift({ id: newId(), productId: p.id, type: 'transfer', quantity: got, reason: `Received ${t.transferNumber} at ${to.name}`, reference: t.transferNumber, date: now(), actor, locationId: t.fromLocationId, toLocationId: to.id });
    const lost = l.quantity - got;
    if (lost > 0) {
      p.stock -= lost;
      if ((p.unavailable || 0) > p.stock) p.unavailable = p.stock;
      db.stockMovements.unshift({ id: newId(), productId: p.id, type: 'out', quantity: lost, reason: `Missing on ${t.transferNumber}`, reference: t.transferNumber, date: now(), actor, locationId: IN_TRANSIT });
      short.push(`${p.name} ${got} of ${l.quantity}`);
    }
  }
  t.status = 'received';
  t.receivedAt = now();
  if (short.length) notify(db, `Transfer short: ${t.transferNumber}`, `Received ${short.join(', ')}. The missing units were written off; check with whoever sent them.`, 'warning');
  audit(db, actor, 'receive', 'transfer', t.transferNumber, `${t.transferNumber} received at ${to.name}${short.length ? ` (short: ${short.join(', ')})` : ''}`);
  return t;
}

export function cancelTransfer(db: BizPilotDB, id: string, actor: string): StockTransfer {
  const t = db.transfers.find((x) => x.id === id || x.transferNumber === id);
  if (!t) throw new OpError('Transfer not found.');
  if (t.status === 'received' || t.status === 'cancelled') throw new OpError(`${t.transferNumber} is already ${t.status}.`);
  if (t.status === 'in_transit') {
    // Goods go back to where they came from.
    for (const l of t.lines) {
      const p = db.products.find((x) => x.id === l.productId);
      if (!p) continue;
      const ls = locationBreakdown(db, p);
      ls[IN_TRANSIT] = Math.max(0, (ls[IN_TRANSIT] ?? 0) - l.quantity);
      ls[t.fromLocationId] = (ls[t.fromLocationId] ?? 0) + l.quantity;
      p.locationStock = tidy(ls);
    }
  }
  t.status = 'cancelled';
  audit(db, actor, 'cancel', 'transfer', t.transferNumber, `${t.transferNumber} cancelled`);
  return t;
}

export interface TransferSuggestion {
  product: Product;
  from: Location;
  to: Location;
  quantity: number;
  reason: string;
}

/**
 * Blueprint workflow B step 2: before buying more, move stock from a location
 * that has spare to one that is below its reorder level.
 */
export function transferSuggestions(db: BizPilotDB): TransferSuggestion[] {
  const active = db.locations.filter((l) => l.active);
  if (active.length < 2) return [];
  const out: TransferSuggestion[] = [];
  for (const p of db.products.filter((x) => x.status === 'active' && x.reorderLevel > 0)) {
    const ls = locationBreakdown(db, p);
    const at = (l: Location) => Math.max(0, ls[l.id] ?? 0);
    const short = active.filter((l) => l.type !== 'warehouse' || active.every((x) => x.type === 'warehouse')).filter((l) => at(l) < p.reorderLevel);
    for (const to of short) {
      const need = p.reorderLevel + (p.safetyStock || 0) - at(to);
      const donor = active.filter((l) => l.id !== to.id && at(l) > p.reorderLevel).sort((a, b) => at(b) - at(a))[0];
      if (!donor || need <= 0) continue;
      const qty = Math.min(need, at(donor) - p.reorderLevel);
      if (qty <= 0) continue;
      out.push({ product: p, from: donor, to, quantity: qty, reason: `${to.name} has ${at(to)} (reorder level ${p.reorderLevel}); ${donor.name} has ${at(donor)}.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- stock counts (blueprint B4)

export function startStockCount(db: BizPilotDB, input: { locationId?: string | null; productIds?: string[]; blind?: boolean; note?: string }, actor: string): StockCount {
  const locationId = input.locationId || '';
  if (locationId && !db.locations.some((l) => l.id === locationId && l.active)) throw new OpError('Choose an active location.');
  const products = (input.productIds?.length ? db.products.filter((p) => input.productIds!.includes(p.id)) : db.products.filter((p) => p.status !== 'discontinued'));
  if (!products.length) throw new OpError('There are no products to count.');
  const c: StockCount = {
    id: newId(),
    countNumber: nextNumber(db.stockCounts.map((x) => x.countNumber), 'CNT'),
    locationId,
    blind: Boolean(input.blind),
    status: 'open',
    lines: products.map((p) => ({ productId: p.id, expected: stockAt(db, p, locationId), counted: null })),
    note: input.note?.trim() ?? '',
    createdAt: now(),
    submittedAt: null,
    decidedAt: null,
    createdBy: actor,
  };
  db.stockCounts.unshift(c);
  const where = locationId ? db.locations.find((l) => l.id === locationId)!.name : 'all stock';
  audit(db, actor, 'create', 'stock_count', c.countNumber, `${c.countNumber} started (${where}, ${c.lines.length} products${c.blind ? ', blind' : ''})`);
  return c;
}

export function recordCount(db: BizPilotDB, countId: string, productId: string, counted: number | null) {
  const c = db.stockCounts.find((x) => x.id === countId);
  if (!c) throw new OpError('Stock count not found.');
  if (c.status !== 'open') throw new OpError(`${c.countNumber} is already ${c.status}.`);
  const line = c.lines.find((l) => l.productId === productId);
  if (!line) throw new OpError('That product is not on this count.');
  if (counted !== null && (!Number.isInteger(counted) || counted < 0)) throw new OpError('Counts must be whole numbers, 0 or more.');
  line.counted = counted;
}

/** Differences go to Approvals as one request; a count with no differences closes straight away. */
export function submitStockCount(db: BizPilotDB, countId: string, actor: string): { count: StockCount; approval: ApprovalRequest | null } {
  const c = db.stockCounts.find((x) => x.id === countId || x.countNumber === countId);
  if (!c) throw new OpError('Stock count not found.');
  if (c.status !== 'open') throw new OpError(`${c.countNumber} is already ${c.status}.`);
  const counted = c.lines.filter((l) => l.counted !== null);
  if (!counted.length) throw new OpError('Enter at least one counted quantity.');
  c.submittedAt = now();
  const diffs = counted.filter((l) => l.counted !== l.expected);
  if (!diffs.length) {
    c.status = 'approved';
    c.decidedAt = now();
    audit(db, actor, 'submit', 'stock_count', c.countNumber, `${c.countNumber}: ${counted.length} product(s) counted, no differences`);
    return { count: c, approval: null };
  }
  c.status = 'submitted';
  const value = diffs.reduce((s, l) => s + Math.abs((l.counted ?? 0) - l.expected) * (db.products.find((p) => p.id === l.productId)?.unitCost ?? 0), 0);
  const where = c.locationId ? db.locations.find((l) => l.id === c.locationId)?.name ?? 'location' : 'all stock';
  const approval = requestApproval(db, {
    type: 'stock_count',
    title: `${c.countNumber}: correct ${diffs.length} stock difference(s) at ${where}`,
    description: diffs.slice(0, 15).map((l) => {
      const p = db.products.find((x) => x.id === l.productId);
      const d = (l.counted ?? 0) - l.expected;
      return `${p?.name ?? 'item'}: system ${l.expected}, counted ${l.counted} (${d > 0 ? '+' : ''}${d})`;
    }).join('\n') + (diffs.length > 15 ? `\n…and ${diffs.length - 15} more` : ''),
    payload: { countId: c.id },
    amount: round2(value),
  }, actor);
  audit(db, actor, 'submit', 'stock_count', c.countNumber, `${c.countNumber}: ${diffs.length} difference(s) worth RM${value.toFixed(2)} sent for approval`);
  return { count: c, approval };
}

/** On approval: adjust each counted product by (counted − expected at count start). */
export function applyStockCount(db: BizPilotDB, countId: string, actor: string): string {
  const c = db.stockCounts.find((x) => x.id === countId);
  if (!c) throw new OpError('Stock count no longer exists.');
  if (c.status !== 'submitted') return `${c.countNumber} was already ${c.status}.`;
  let changed = 0;
  for (const l of c.lines) {
    if (l.counted === null || l.counted === l.expected) continue;
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) continue;
    // Sales since the count started are already in the system, so apply the difference, not the count.
    const delta = Math.max(l.counted - l.expected, -stockAt(db, p, c.locationId));
    if (!delta) continue;
    recordStockMovement(db, p.id, 'adjustment', delta, `Stock count ${c.countNumber}`, c.countNumber, actor, { locationId: c.locationId || null, strict: Boolean(c.locationId) });
    changed++;
  }
  c.status = 'approved';
  c.decidedAt = now();
  return `${c.countNumber}: ${changed} product(s) corrected.`;
}

/** Blueprint B2: on hand − reserved − unavailable (damaged, expired, quarantined). */
export function availableToSell(p: Product): number {
  return Math.max(0, p.stock - p.reserved - (p.unavailable || 0));
}

/**
 * Set how many units on hand are not sellable (damaged, expired or
 * quarantined). They stay on hand until written off with a stock-out.
 */
export function setHeldStock(db: BizPilotDB, productId: string, quantity: number, reason: string, actor: string): Product {
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw new OpError('Product not found.');
  if (!Number.isInteger(quantity) || quantity < 0) throw new OpError('Held quantity must be a whole number, 0 or more.');
  if (quantity > p.stock) throw new OpError(`Only ${p.stock} of ${p.name} on hand.`);
  const before = p.unavailable || 0;
  p.unavailable = quantity;
  audit(db, actor, 'stock_hold', 'product', p.sku, `${p.name}: held ${before} → ${quantity} (${reason})`);
  checkLowStock(db, p);
  return p;
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

export type ReorderUrgency = 'stockout_risk' | 'reorder_now' | 'watch';

export interface ReorderSuggestion {
  product: Product;
  supplier: Supplier | undefined;
  available: number;
  daysLeft: number | null;
  suggestedQty: number;
  urgency: ReorderUrgency;
  stockoutDate: string | null; // projected date available stock runs out
  reason: string;
}

const REVIEW_DAYS = 30; // order enough to last the lead time plus a month

/**
 * Products that need replenishing, with a suggested quantity (blueprint B3).
 * Uses each product's reorder level, safety stock, max stock and order
 * multiple, and the supplier's lead time and minimum order quantity.
 */
export function reorderSuggestions(db: BizPilotDB): ReorderSuggestion[] {
  const out: ReorderSuggestion[] = [];
  for (const p of db.products) {
    if (p.status === 'discontinued' || p.status === 'draft') continue;
    const supplier = p.supplierId ? db.suppliers.find((s) => s.id === p.supplierId) : undefined;
    const lead = supplier?.leadTimeDays ?? 7;
    const demand = p.avgDailySales;
    const avail = availableToSell(p);
    const daysLeft = demand > 0 ? Math.floor(avail / demand) : null;
    const projected = avail + p.incoming;
    const safety = p.safetyStock || p.reorderLevel;
    const atArrival = projected - demand * lead;
    const reasons: string[] = [];

    let urgency: ReorderUrgency | null = null;
    if (avail <= 0 && p.incoming <= 0) {
      urgency = 'stockout_risk';
      reasons.push('No sellable stock and nothing incoming.');
    } else if (demand > 0 && atArrival <= 0) {
      urgency = 'stockout_risk';
      reasons.push(`Runs out in ~${daysLeft} day(s), before a new order could arrive (${lead}-day lead time).`);
    } else if (projected <= p.reorderLevel) {
      urgency = 'reorder_now';
      reasons.push(`${projected} available + incoming is at or below the reorder level of ${p.reorderLevel}.`);
    } else if (demand > 0 && atArrival <= safety) {
      urgency = 'watch';
      reasons.push(`By the time a new order arrives only ~${Math.max(0, Math.floor(atArrival))} would be left (safety stock ${safety}).`);
    } else if (daysLeft !== null && daysLeft <= db.settings.lowStockThresholdDays) {
      urgency = 'watch';
      reasons.push(`~${daysLeft} day(s) of stock left.`);
    }
    if (!urgency) continue;

    let qty = Math.ceil(demand * (lead + REVIEW_DAYS) + safety - projected);
    if (qty <= 0) qty = Math.max(p.reorderLevel - projected + 1, p.reorderLevel, 1);
    if (supplier?.minOrderQty && qty < supplier.minOrderQty) {
      reasons.push(`Raised to the supplier minimum of ${supplier.minOrderQty}.`);
      qty = supplier.minOrderQty;
    }
    const multiple = p.orderMultiple > 1 ? p.orderMultiple : 1;
    if (multiple > 1 && qty % multiple) {
      qty = Math.ceil(qty / multiple) * multiple;
      reasons.push(`Rounded up to packs of ${multiple}.`);
    }
    if (p.maxStock > 0 && projected + qty > p.maxStock) {
      const room = Math.max(0, p.maxStock - projected);
      const capped = multiple > 1 ? Math.floor(room / multiple) * multiple : room;
      reasons.push(`Capped so stock stays within the maximum of ${p.maxStock}.`);
      qty = capped;
    }
    if (qty <= 0) continue;
    if (p.incoming > 0) reasons.push(`${p.incoming} already incoming.`);
    out.push({
      product: p,
      supplier,
      available: avail,
      daysLeft,
      suggestedQty: qty,
      urgency,
      stockoutDate: demand > 0 ? new Date(Date.now() + (avail / demand) * DAY).toISOString().slice(0, 10) : null,
      reason: reasons.join(' '),
    });
  }
  const rank = { stockout_risk: 0, reorder_now: 1, watch: 2 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
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
  /** Deliver to this location (default location if empty) */
  locationId?: string | null;
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
  if (input.locationId) {
    if (!db.locations.some((l) => l.id === input.locationId && l.active)) throw new OpError('Choose an active delivery location.');
    po.locationId = input.locationId;
  }
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
      recordStockMovement(db, p.id, 'in', qty, `Received ${po.poNumber}`, po.poNumber, actor, { locationId: po.locationId });
    }
  }
  const complete = po.lines.every((l) => (l.receivedQty ?? 0) >= l.quantity);
  if (!complete) {
    const short = po.lines
      .filter((l) => (l.receivedQty ?? 0) < l.quantity)
      .map((l) => `${db.products.find((x) => x.id === l.productId)?.name ?? 'item'} ${l.receivedQty ?? 0} of ${l.quantity}`);
    notify(db, `Short delivery: ${po.poNumber}`, `Received so far: ${short.join(', ')}. Check with the supplier before paying the full bill.`, 'warning');
  }
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
  /** Shop or warehouse the goods leave from (default location if empty) */
  locationId?: string | null;
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
  if (input.locationId) {
    if (!db.locations.some((l) => l.id === input.locationId && l.active)) throw new OpError('Choose an active location for this sale.');
    order.locationId = input.locationId;
  }
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
    recordStockMovement(db, p.id, 'out', l.quantity, `Sold – ${o.orderNumber}`, o.orderNumber, actor, { locationId: o.locationId });
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
    else recordStockMovement(db, p.id, 'in', l.quantity, `Returned – ${o.orderNumber}`, o.orderNumber, actor, { locationId: o.locationId });
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
    case 'stock_count':
      return applyStockCount(db, String(p.countId), actor);
    case 'refund': {
      const ret = db.returns.find((x) => x.id === p.returnId);
      if (!ret) throw new OpError('Return case no longer exists.');
      if (ret.refundStatus === 'refunded') return `${ret.returnNumber} was already refunded.`;
      const amount = round2(Number(p.amount ?? ret.refundAmount));
      ret.refundStatus = 'refunded';
      ret.refundAmount = amount;
      addExpense(db, { category: 'Refunds', description: `Refund for ${ret.returnNumber}${ret.customerName ? ` (${ret.customerName})` : ''}`, amount, date: now(), recurring: false, paid: true, dueDate: null }, actor);
      audit(db, actor, 'execute', 'return', ret.returnNumber, `Refunded RM${amount.toFixed(2)}`);
      return `Refund of RM${amount.toFixed(2)} recorded for ${ret.returnNumber}. Pay the customer through your payment channel.`;
    }
  }
}

// ---------------------------------------------------------------- returns (blueprint A6)

export interface ReturnInput {
  orderId?: string | null;
  productId?: string | null;
  customerName?: string;
  quantity: number;
  reason: ReturnCase['reason'];
  condition: ReturnCase['condition'];
  notes?: string;
  photoUrl?: string;
}

export function createReturn(db: BizPilotDB, input: ReturnInput, actor: string): ReturnCase {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new OpError('Quantity must be a whole number above 0.');
  const order = input.orderId ? db.salesOrders.find((o) => o.id === input.orderId || o.orderNumber === input.orderId) : undefined;
  if (input.orderId && !order) throw new OpError('Order not found.');
  const product = input.productId ? findProduct(db, input.productId) : undefined;
  if (input.productId && !product) throw new OpError('Product not found.');
  if (order && product) {
    const line = order.lines.find((l) => l.productId === product.id);
    if (!line) throw new OpError(`${order.orderNumber} has no ${product.name}.`);
    if (input.quantity > line.quantity) throw new OpError(`${order.orderNumber} only had ${line.quantity} × ${product.name}.`);
  }
  const ret: ReturnCase = {
    id: newId(),
    returnNumber: nextNumber(db.returns.map((r) => r.returnNumber), 'RET'),
    orderId: order?.id ?? null,
    productId: product?.id ?? null,
    customerName: input.customerName?.trim() || order?.customerName || '',
    quantity: input.quantity,
    reason: input.reason,
    condition: input.condition,
    notes: input.notes ?? '',
    photoUrl: input.photoUrl ?? '',
    status: 'open',
    resolution: null,
    refundAmount: 0,
    refundStatus: 'none',
    createdAt: now(),
    resolvedAt: null,
  };
  db.returns.unshift(ret);
  audit(db, actor, 'create', 'return', ret.returnNumber, `${ret.quantity} × ${product?.name ?? 'item'}: ${ret.reason}`);
  // Blueprint A6: flag product-quality patterns.
  if (product) {
    const recent = db.returns.filter((r) => r.productId === product.id && ['damaged', 'defective'].includes(r.reason) && Date.now() - new Date(r.createdAt).getTime() < 30 * DAY);
    if (recent.length >= 3) notify(db, `Quality issue: ${product.name}`, `${recent.length} damaged/defective returns in 30 days. Check the batch, packaging or supplier.`, 'warning');
  }
  return ret;
}

/**
 * Close a return: what happens to the goods (restock, quarantine, dispose,
 * send back to supplier) and an optional refund, which goes to Approvals.
 */
export function resolveReturn(
  db: BizPilotDB,
  id: string,
  resolution: ReturnCase['resolution'],
  refundAmount: number,
  actor: string,
): { ret: ReturnCase; approval: ApprovalRequest | null } {
  const ret = db.returns.find((r) => r.id === id || r.returnNumber === id);
  if (!ret) throw new OpError('Return case not found.');
  if (ret.status !== 'open') throw new OpError(`${ret.returnNumber} is already ${ret.status}.`);
  if (!resolution) throw new OpError('Choose what happens to the goods.');
  if (!(refundAmount >= 0)) throw new OpError('Refund must be 0 or more.');
  const order = ret.orderId ? db.salesOrders.find((o) => o.id === ret.orderId) : undefined;
  if (order && refundAmount > order.total) throw new OpError(`Refund is more than the order total of RM${order.total.toFixed(2)}.`);
  const p = ret.productId ? db.products.find((x) => x.id === ret.productId) : undefined;
  if (p && (resolution === 'restock' || resolution === 'quarantine')) {
    recordStockMovement(db, p.id, 'in', ret.quantity, `Customer return ${ret.returnNumber}${resolution === 'quarantine' ? ' (quarantined)' : ''}`, ret.returnNumber, actor, { locationId: order?.locationId });
    if (resolution === 'quarantine') p.unavailable = Math.min(p.stock, (p.unavailable || 0) + ret.quantity);
  }
  ret.resolution = resolution;
  ret.status = 'resolved';
  ret.resolvedAt = now();
  let approval: ApprovalRequest | null = null;
  if (refundAmount > 0) {
    ret.refundAmount = round2(refundAmount);
    ret.refundStatus = 'pending_approval';
    approval = requestApproval(db, {
      type: 'refund',
      title: `Refund ${ret.returnNumber}: RM${ret.refundAmount.toFixed(2)}${ret.customerName ? ` to ${ret.customerName}` : ''}`,
      description: `${ret.quantity} × ${p?.name ?? 'item'} returned (${ret.reason.replace(/_/g, ' ')}, ${ret.condition}). Goods: ${resolution.replace('_', ' ')}.${order ? ` Order ${order.orderNumber}, total RM${order.total.toFixed(2)}.` : ''}`,
      payload: { returnId: ret.id, amount: ret.refundAmount },
      amount: ret.refundAmount,
    }, actor);
  }
  audit(db, actor, 'resolve', 'return', ret.returnNumber, `Goods ${resolution}${refundAmount > 0 ? `, refund RM${refundAmount} requested` : ''}`);
  return { ret, approval };
}

export function rejectReturn(db: BizPilotDB, id: string, why: string, actor: string): ReturnCase {
  const ret = db.returns.find((r) => r.id === id);
  if (!ret) throw new OpError('Return case not found.');
  ret.status = 'rejected';
  ret.resolvedAt = now();
  ret.notes = [ret.notes, `Rejected: ${why}`].filter(Boolean).join('\n');
  audit(db, actor, 'reject', 'return', ret.returnNumber, why);
  return ret;
}
