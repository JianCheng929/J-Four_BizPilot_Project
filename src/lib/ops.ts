import type {
  ApprovalRequest,
  ApprovalType,
  BizPilotDB,
  Campaign,
  ContentItem,
  Expense,
  Invoice,
  InvoiceLine,
  InvoiceRecurrence,
  Quotation,
  Location,
  StockCount,
  StockTransfer,
  Product,
  ProductionOrder,
  PurchaseOrder,
  ReturnCase,
  PurchaseOrderLine,
  Review,
  SalesOrder,
  SalesOrderLine,
  Sentiment,
  StockBatch,
  StockMovement,
  Supplier,
  SupportTicket,
  StaffTask,
  Consent,
} from './db/types';
import { newId } from './db/defaults';
import { cashPosition } from './metrics';
import { checkCompliance } from './compliance';

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
  /** Track stock in batches with their own expiry (opening stock becomes the first batch). */
  trackBatches?: boolean;
  openingBatch?: string;
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
  if (input.trackBatches) {
    product.trackBatches = true;
    product.batches = [];
  }
  db.products.push(product);
  audit(db, actor, 'create', 'product', product.sku, `Product added: ${product.name}`);
  if (input.openingStock && input.openingStock > 0) {
    recordStockMovement(db, product.id, 'in', input.openingStock, 'Opening stock', 'OPENING', actor, { batch: input.openingBatch || 'OPENING', expiry: input.expiryDate || undefined });
  }
  return product;
}

export function updateProduct(db: BizPilotDB, id: string, patch: Partial<Product>, actor: string): Product {
  const p = db.products.find((x) => x.id === id);
  if (!p) throw new OpError('Product not found.');
  // Stock levels only change through stock movements, never by direct edit.
  const { stock: _s, reserved: _r, incoming: _i, unavailable: _u, id: _id, batches: _b, trackBatches: _t, ...safe } = patch;
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
  opts: { locationId?: string | null; strict?: boolean; batch?: string; expiry?: string } = {},
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
  const batchNote = p.trackBatches ? applyBatchDelta(p, delta, opts) : null;
  p.stock += delta;
  // Writing off damaged or expired goods removes them from held stock first.
  if (type === 'out' && (p.unavailable || 0) > 0 && /damag|expir|quarantin|defect/i.test(reason)) {
    p.unavailable = Math.max(0, p.unavailable - quantity);
  }
  if ((p.unavailable || 0) > p.stock) p.unavailable = p.stock;
  const mv: StockMovement = { id: newId(), productId, type, quantity, reason, reference, date: now(), actor };
  if (locationId) mv.locationId = locationId;
  if (batchNote) mv.batch = batchNote;
  db.stockMovements.unshift(mv);
  const where = locationId ? ` at ${db.locations.find((l) => l.id === locationId)?.name ?? 'location'}` : '';
  audit(db, actor, 'stock_' + type, 'product', p.sku, `${p.name}: ${before} → ${p.stock}${where} (${reason})`);
  checkLowStock(db, p);
  return mv;
}

// ---------------------------------------------------------------- batches and expiry (blueprint B1, A5)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Units on hand that are not in any batch (stock from before tracking was switched on). */
export function unbatchedQty(p: Product): number {
  return Math.max(0, p.stock - (p.batches ?? []).reduce((s, b) => s + b.qty, 0));
}

/** Batches in the order they should leave: earliest expiry first, then oldest received (FEFO). */
export function batchesFefo(p: Product): StockBatch[] {
  return [...(p.batches ?? [])].filter((b) => b.qty > 0).sort((a, b) =>
    (a.expiry || '9999-12-31').localeCompare(b.expiry || '9999-12-31') || a.receivedAt.localeCompare(b.receivedAt));
}

/**
 * Apply a stock change to the product's batches. Incoming units go into the
 * named batch (or a dated lot); outgoing units leave the named batch first,
 * then by earliest expiry. Returns a note for the movement, e.g. "L1×3, L2×2".
 */
function applyBatchDelta(p: Product, delta: number, opts: { batch?: string; expiry?: string }): string | null {
  const batches = (p.batches ?? []).map((b) => ({ ...b }));
  const expiry = opts.expiry?.trim() ?? '';
  if (expiry && !DATE_RE.test(expiry)) throw new OpError('Expiry date must be YYYY-MM-DD.');
  let note: string;
  if (delta > 0) {
    const name = opts.batch?.trim() || `LOT-${now().slice(0, 10).replace(/-/g, '')}`;
    const same = batches.find((b) => b.batch === name && b.expiry === expiry);
    if (same) same.qty += delta;
    else batches.push({ batch: name, expiry, qty: delta, receivedAt: now() });
    note = `${name}×${delta}`;
  } else {
    let need = -delta;
    const taken: string[] = [];
    const named = opts.batch?.trim();
    if (named && !batches.some((b) => b.batch === named && b.qty > 0)) throw new OpError(`No stock in batch ${named} of ${p.name}.`);
    const order = [...batches.filter((b) => b.batch === named), ...batchesFefo({ ...p, batches }).filter((b) => b.batch !== named)];
    for (const b of order) {
      if (need <= 0) break;
      const real = batches.find((x) => x.batch === b.batch && x.expiry === b.expiry)!;
      const t = Math.min(real.qty, need);
      if (t <= 0) continue;
      real.qty -= t;
      need -= t;
      taken.push(`${real.batch}×${t}`);
    }
    if (need > 0) taken.push(`no batch×${need}`); // stock from before batches were tracked
    note = taken.join(', ');
  }
  p.batches = batches.filter((b) => b.qty > 0);
  const dated = p.batches.filter((b) => b.expiry).map((b) => b.expiry).sort();
  p.expiryDate = dated[0] ?? '';
  return note;
}

/** Switch batch tracking on (current stock becomes one opening batch) or off (batches are dropped). */
export function setTrackBatches(db: BizPilotDB, productId: string, on: boolean, actor: string, opening?: { batch?: string; expiry?: string }): Product {
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw new OpError('Product not found.');
  if (Boolean(p.trackBatches) === on) return p;
  if (on) {
    const expiry = opening?.expiry ?? p.expiryDate ?? '';
    if (expiry && !DATE_RE.test(expiry)) throw new OpError('Expiry date must be YYYY-MM-DD.');
    p.batches = p.stock > 0 ? [{ batch: opening?.batch?.trim() || 'OPENING', expiry, qty: p.stock, receivedAt: now() }] : [];
    p.trackBatches = true;
  } else {
    p.trackBatches = false;
    p.batches = [];
  }
  audit(db, actor, 'update', 'product', p.sku, `${p.name}: batch tracking ${on ? 'on' : 'off'}`);
  return p;
}

export interface ExpiringBatch {
  product: Product;
  batch: StockBatch;
  daysLeft: number;
}

/** Batches that have expired or expire within `days` days, soonest first. */
export function expiringBatches(db: BizPilotDB, days = 30): ExpiringBatch[] {
  const today = Date.parse(`${now().slice(0, 10)}T00:00:00Z`);
  const out: ExpiringBatch[] = [];
  for (const p of db.products) {
    for (const b of p.batches ?? []) {
      if (!b.expiry || b.qty <= 0) continue;
      const left = Math.round((Date.parse(`${b.expiry}T00:00:00Z`) - today) / DAY);
      if (left <= days) out.push({ product: p, batch: b, daysLeft: left });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

// ---------------------------------------------------------------- variants (blueprint B1)

export interface VariantOption {
  name: string; // e.g. Size
  values: string[]; // e.g. S, M, L
}

/** Every combination of option values, e.g. Size × Colour. */
export function variantCombinations(options: VariantOption[]): Record<string, string>[] {
  const clean = options.map((o) => ({ name: o.name.trim(), values: [...new Set(o.values.map((v) => v.trim()).filter(Boolean))] })).filter((o) => o.name && o.values.length);
  let out: Record<string, string>[] = [{}];
  for (const o of clean) out = out.flatMap((c) => o.values.map((v) => ({ ...c, [o.name]: v })));
  return clean.length ? out : [];
}

export const variantLabel = (v: Record<string, string> | null | undefined) => Object.values(v ?? {}).join(' / ');

export function variantsOf(db: BizPilotDB, productId: string): Product[] {
  return db.products.filter((p) => p.parentId === productId);
}

/**
 * Create one product per combination (e.g. T-shirt S/Red, S/Blue, M/Red…),
 * each with its own SKU, stock, barcode and channel SKUs, copying price,
 * cost, supplier and reorder settings from the main product. The main
 * product becomes the family heading; if it has no stock it is set to draft
 * so it is not sold or reordered by itself.
 */
export function createVariants(db: BizPilotDB, productId: string, options: VariantOption[], actor: string, overrides: Record<string, { price?: number; unitCost?: number; openingStock?: number; barcode?: string }> = {}): Product[] {
  const base = db.products.find((x) => x.id === productId);
  if (!base) throw new OpError('Product not found.');
  if (base.parentId) throw new OpError(`${base.name} is itself a variant. Add variants to the main product.`);
  if (base.bom?.length) throw new OpError(`${base.name} has a recipe. Give each variant its own recipe instead.`);
  const combos = variantCombinations(options);
  if (!combos.length) throw new OpError('Add at least one option with values, e.g. Size: S, M, L.');
  if (combos.length > 100) throw new OpError(`That makes ${combos.length} variants; the limit is 100.`);
  const existing = new Set(variantsOf(db, base.id).map((v) => variantLabel(v.variantOptions).toLowerCase()));
  const made: Product[] = [];
  for (const combo of combos) {
    const label = variantLabel(combo);
    if (existing.has(label.toLowerCase())) continue;
    const o = overrides[label] ?? {};
    const sku = `${base.sku}-${Object.values(combo).map((v) => v.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'X').join('-')}`;
    const v = createProduct(db, {
      name: `${base.name} - ${label}`,
      sku: db.products.some((p) => p.sku.toLowerCase() === sku.toLowerCase()) ? undefined : sku,
      category: base.category,
      description: base.description,
      barcode: o.barcode ?? '',
      supplierId: base.supplierId,
      unitCost: o.unitCost ?? base.unitCost,
      price: o.price ?? base.price,
      weightKg: base.weightKg,
      reorderLevel: base.reorderLevel,
      safetyStock: base.safetyStock,
      maxStock: base.maxStock,
      orderMultiple: base.orderMultiple,
      status: base.status === 'draft' ? 'active' : base.status,
      openingStock: o.openingStock,
      trackBatches: base.trackBatches,
    }, actor);
    v.parentId = base.id;
    v.variantOptions = combo;
    made.push(v);
  }
  if (!made.length) throw new OpError('Those variants already exist.');
  if (base.stock === 0 && base.reserved === 0 && base.incoming === 0) base.status = 'draft';
  audit(db, actor, 'create', 'product', base.sku, `${made.length} variant(s) of ${base.name}: ${made.map((v) => variantLabel(v.variantOptions)).join(', ')}`);
  return made;
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
  addStaffTask(db, { kind: 'receive', title: `Receive ${t.transferNumber} from ${from.name}`, detail: t.lines.map((l) => `${l.quantity}× ${db.products.find((x) => x.id === l.productId)?.name ?? 'item'}`).join(', '), locationId: to.id, ref: t.transferNumber }, actor);
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
  closeStaffTasks(db, t.transferNumber, actor);
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
  dropStaffTasks(db, t.transferNumber);
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
  addStaffTask(db, { kind: 'count', title: `Count stock for ${c.countNumber}`, detail: `${c.lines.length} products at ${locationId ? db.locations.find((l) => l.id === locationId)!.name : 'all stock'}${c.blind ? ' (blind count: system quantities hidden)' : ''}. Enter the counts in Inventory → Stock counts.`, locationId, ref: c.countNumber }, actor);
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

export function cancelStockCount(db: BizPilotDB, countId: string, actor: string): StockCount {
  const c = db.stockCounts.find((x) => x.id === countId || x.countNumber === countId);
  if (!c) throw new OpError('Stock count not found.');
  if (c.status !== 'open') throw new OpError(`${c.countNumber} is already ${c.status}.`);
  c.status = 'cancelled';
  dropStaffTasks(db, c.countNumber);
  audit(db, actor, 'cancel', 'stock_count', c.countNumber, `${c.countNumber} cancelled`);
  return c;
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
  closeStaffTasks(db, c.countNumber, actor);
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
  /** Made in-house from a recipe: replenish with a production order, not a PO. */
  make: boolean;
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
    const make = Boolean(p.bom?.length);
    const supplier = !make && p.supplierId ? db.suppliers.find((s) => s.id === p.supplierId) : undefined;
    const lead = supplier?.leadTimeDays ?? 7;
    const demand = p.avgDailySales;
    const avail = availableToSell(p);
    const daysLeft = demand > 0 ? Math.floor(avail / demand) : null;
    const planned = plannedOutput(db, p.id);
    const incoming = p.incoming + planned;
    const projected = avail + incoming;
    const safety = p.safetyStock || p.reorderLevel;
    const atArrival = projected - demand * lead;
    const reasons: string[] = [];

    let urgency: ReorderUrgency | null = null;
    if (avail <= 0 && incoming <= 0) {
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
    if (planned > 0) reasons.push(`${planned} already planned in production.`);
    out.push({
      product: p,
      supplier,
      available: avail,
      daysLeft,
      suggestedQty: qty,
      urgency,
      stockoutDate: demand > 0 ? new Date(Date.now() + (avail / demand) * DAY).toISOString().slice(0, 10) : null,
      reason: reasons.join(' '),
      make,
    });
  }
  const rank = { stockout_risk: 0, reorder_now: 1, watch: 2 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
}

// ---------------------------------------------------------------- manufacturing (blueprint A2)

/** Production orders that will still add finished goods (approved or running). */
const OPEN_PRODUCTION: ProductionOrder['status'][] = ['pending_approval', 'approved', 'in_progress'];

/** Finished units still to come from open production orders. */
export function plannedOutput(db: BizPilotDB, productId: string): number {
  return (db.productionOrders ?? []).filter((o) => o.productId === productId && OPEN_PRODUCTION.includes(o.status)).reduce((s, o) => s + o.quantity, 0);
}

/** True when `componentId` is `productId`, or is itself made (through its BOM) from `productId`. */
function madeFrom(db: BizPilotDB, componentId: string, productId: string, seen = new Set<string>()): boolean {
  if (componentId === productId) return true;
  if (seen.has(componentId)) return false;
  seen.add(componentId);
  const c = db.products.find((x) => x.id === componentId);
  return (c?.bom ?? []).some((l) => madeFrom(db, l.productId, productId, seen));
}

export interface BomInput {
  lines: { productId: string; quantity: number }[];
  labourCost?: number;
  overheadCost?: number;
}

/** Set what one unit of a product is made from. An empty list means the product is bought in, not made. */
export function setBom(db: BizPilotDB, productId: string, input: BomInput, actor: string): Product {
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw new OpError('Product not found.');
  const merged = new Map<string, number>();
  for (const l of input.lines) {
    const c = db.products.find((x) => x.id === l.productId);
    if (!c) throw new OpError('A material in the recipe no longer exists.');
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new OpError(`Enter a quantity above 0 for ${c.name}.`);
    if (madeFrom(db, c.id, p.id)) throw new OpError(`${c.name} can't be a material of ${p.name}: it is ${c.id === p.id ? 'the same product' : `made from ${p.name}`}.`);
    merged.set(c.id, Math.round(((merged.get(c.id) ?? 0) + l.quantity) * 10000) / 10000);
  }
  const labour = input.labourCost ?? p.labourCost ?? 0;
  const overhead = input.overheadCost ?? p.overheadCost ?? 0;
  if (labour < 0 || overhead < 0) throw new OpError('Labour and overhead cost cannot be negative.');
  p.bom = [...merged].map(([id, quantity]) => ({ productId: id, quantity }));
  p.labourCost = round2(labour);
  p.overheadCost = round2(overhead);
  if (p.bom.length) p.unitCost = p.unitCost || plannedUnitCost(db, p);
  audit(db, actor, 'update', 'product', p.sku, p.bom.length
    ? `Recipe for ${p.name}: ${p.bom.map((l) => `${l.quantity}× ${db.products.find((x) => x.id === l.productId)?.name}`).join(', ')}; labour RM${p.labourCost}, overhead RM${p.overheadCost} per unit`
    : `Recipe removed from ${p.name}`);
  return p;
}

/** Material cost of one unit at today's material costs. */
export function materialCostPerUnit(db: BizPilotDB, p: Product): number {
  return round2((p.bom ?? []).reduce((s, l) => s + l.quantity * (db.products.find((x) => x.id === l.productId)?.unitCost ?? 0), 0));
}

/** Materials + labour + overhead for one unit (blueprint A2 "estimate production cost per unit"). */
export function plannedUnitCost(db: BizPilotDB, p: Product): number {
  return round2(materialCostPerUnit(db, p) + (p.labourCost ?? 0) + (p.overheadCost ?? 0));
}

export interface MaterialNeed {
  product: Product;
  perUnit: number;
  required: number;
  /** Sellable units at the location, less what approved production orders have not yet taken. */
  available: number;
  shortage: number;
  supplier?: Supplier;
}

/**
 * Materials needed to make `quantity` units and whether there are enough
 * (blueprint A2: "check material availability before production begins").
 */
export function materialRequirements(db: BizPilotDB, productId: string, quantity: number, locationId = '', excludeOrderId = ''): MaterialNeed[] {
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw new OpError('Product not found.');
  const committed = new Map<string, number>();
  for (const o of db.productionOrders ?? []) {
    if (o.id === excludeOrderId || (o.status !== 'approved' && o.status !== 'pending_approval')) continue;
    for (const m of o.materials) committed.set(m.productId, (committed.get(m.productId) ?? 0) + m.required);
  }
  return (p.bom ?? []).map((l) => {
    const c = db.products.find((x) => x.id === l.productId);
    if (!c) throw new OpError(`A material of ${p.name} no longer exists. Edit its recipe.`);
    const required = Math.ceil(l.quantity * quantity - 1e-9);
    const onHand = Math.min(stockAt(db, c, locationId), availableToSell(c));
    const available = Math.max(0, onHand - (committed.get(c.id) ?? 0));
    return {
      product: c,
      perUnit: l.quantity,
      required,
      available,
      shortage: Math.max(0, required - available),
      supplier: c.supplierId ? db.suppliers.find((s) => s.id === c.supplierId) : undefined,
    };
  });
}

/** Most units that can be made from materials on hand. */
export function maxProducible(db: BizPilotDB, p: Product, locationId = ''): number {
  if (!p.bom?.length) return 0;
  return Math.max(0, Math.min(...materialRequirements(db, p.id, 1, locationId).map((m) => Math.floor((m.available + 1e-9) / m.perUnit))));
}

export interface ProductionInput {
  productId: string;
  quantity: number;
  locationId?: string | null;
  dueDate?: string;
  batchNumber?: string;
  note?: string;
}

/**
 * Plan a production run (blueprint A2 workflow steps 2–4). It waits in
 * Approvals; materials are only taken from stock when production starts.
 */
export function createProductionOrder(db: BizPilotDB, input: ProductionInput, actor: string): { order: ProductionOrder; approval: ApprovalRequest } {
  const p = db.products.find((x) => x.id === input.productId);
  if (!p) throw new OpError('Product not found.');
  if (!p.bom?.length) throw new OpError(`${p.name} has no recipe yet. Add the materials it is made from first.`);
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new OpError('Quantity must be a whole number above 0.');
  const locationId = input.locationId || '';
  if (locationId && !db.locations.some((l) => l.id === locationId && l.active)) throw new OpError('Choose an active location.');
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new OpError('Due date must be YYYY-MM-DD.');
  const needs = materialRequirements(db, p.id, input.quantity, locationId);
  const orderNumber = nextNumber((db.productionOrders ?? []).map((o) => o.orderNumber), 'MO');
  const unit = plannedUnitCost(db, p);
  const order: ProductionOrder = {
    id: newId(),
    orderNumber,
    productId: p.id,
    quantity: input.quantity,
    locationId,
    status: 'pending_approval',
    materials: needs.map((m) => ({ productId: m.product.id, required: m.required, consumed: 0, unitCost: m.product.unitCost })),
    plannedUnitCost: unit,
    actualUnitCost: 0,
    labourCost: round2((p.labourCost ?? 0) * input.quantity),
    overheadCost: round2((p.overheadCost ?? 0) * input.quantity),
    goodQty: 0,
    rejectedQty: 0,
    batchNumber: input.batchNumber?.trim() || orderNumber,
    qcNotes: '',
    dueDate: input.dueDate ?? '',
    note: input.note?.trim() ?? '',
    createdAt: now(),
    startedAt: null,
    completedAt: null,
    createdBy: actor,
  };
  db.productionOrders.unshift(order);
  const short = needs.filter((m) => m.shortage > 0);
  const approval = requestApproval(db, {
    type: 'production_order',
    title: `${orderNumber}: make ${input.quantity}× ${p.name} (≈RM${(unit * input.quantity).toFixed(2)})`,
    description: [
      `Materials: ${needs.map((m) => `${m.required} ${m.product.name}${m.shortage ? ` (short ${m.shortage})` : ''}`).join(', ')}.`,
      `Planned cost RM${unit.toFixed(2)} per unit (materials RM${materialCostPerUnit(db, p).toFixed(2)}, labour RM${(p.labourCost ?? 0).toFixed(2)}, overhead RM${(p.overheadCost ?? 0).toFixed(2)}).`,
      short.length ? `Not enough materials yet: buy them before starting (draft material POs from the production order).` : 'All materials are in stock.',
      input.dueDate ? `Due ${input.dueDate}.` : '',
      order.note,
    ].filter(Boolean).join('\n'),
    payload: { productionOrderId: order.id },
    amount: round2(unit * input.quantity),
  }, actor);
  audit(db, actor, 'create', 'production_order', orderNumber, `${orderNumber}: ${input.quantity}× ${p.name} planned${short.length ? `, short of ${short.length} material(s)` : ''}`);
  return { order, approval };
}

function findProductionOrder(db: BizPilotDB, ref: string): ProductionOrder {
  const o = (db.productionOrders ?? []).find((x) => x.id === ref || x.orderNumber.toLowerCase() === ref.trim().toLowerCase());
  if (!o) throw new OpError('Production order not found.');
  return o;
}

/** On approval: the run may start once materials are in. */
export function approveProductionOrder(db: BizPilotDB, id: string, actor: string): string {
  const o = findProductionOrder(db, id);
  if (o.status !== 'pending_approval') return `${o.orderNumber} is already ${o.status.replace('_', ' ')}.`;
  o.status = 'approved';
  const short = materialRequirements(db, o.productId, o.quantity, o.locationId, o.id).filter((m) => m.shortage > 0);
  audit(db, actor, 'approve', 'production_order', o.orderNumber, `${o.orderNumber} approved`);
  return `${o.orderNumber} approved.${short.length ? ` Still short of ${short.map((m) => `${m.shortage} ${m.product.name}`).join(', ')}.` : ' Ready to start.'}`;
}

/** Start production: materials leave stock now (work in progress). Refuses if anything is short. */
export function startProduction(db: BizPilotDB, id: string, actor: string): ProductionOrder {
  const o = findProductionOrder(db, id);
  if (o.status === 'pending_approval') throw new OpError(`${o.orderNumber} is waiting for approval.`);
  if (o.status !== 'approved') throw new OpError(`${o.orderNumber} is already ${o.status.replace('_', ' ')}.`);
  const needs = materialRequirements(db, o.productId, o.quantity, o.locationId, o.id);
  const short = needs.filter((m) => m.shortage > 0);
  if (short.length) throw new OpError(`Not enough materials for ${o.orderNumber}: ${short.map((m) => `${m.product.name} needs ${m.required}, ${m.available} available`).join('; ')}.`);
  o.materials = needs.map((m) => {
    recordStockMovement(db, m.product.id, 'out', m.required, `Used in production ${o.orderNumber}`, o.orderNumber, actor, { locationId: o.locationId || null, strict: Boolean(o.locationId) });
    return { productId: m.product.id, required: m.required, consumed: m.required, unitCost: m.product.unitCost };
  });
  o.status = 'in_progress';
  o.startedAt = now();
  audit(db, actor, 'start', 'production_order', o.orderNumber, `${o.orderNumber} started; materials taken from stock`);
  return o;
}

export interface CompleteProductionInput {
  goodQty: number;
  rejectedQty?: number;
  qcNotes?: string;
  batchNumber?: string;
  expiryDate?: string;
}

/**
 * Record what was made (blueprint A2: QC, finished-goods registration, actual
 * vs planned cost). Good units go into stock; the product's cost becomes the
 * weighted average of existing stock and this batch.
 */
export function completeProduction(db: BizPilotDB, id: string, input: CompleteProductionInput, actor: string): ProductionOrder {
  const o = findProductionOrder(db, id);
  if (o.status !== 'in_progress') throw new OpError(`${o.orderNumber} is ${o.status.replace('_', ' ')}; only a running order can be completed.`);
  const good = input.goodQty;
  const rejected = input.rejectedQty ?? 0;
  if (!Number.isInteger(good) || good < 0 || !Number.isInteger(rejected) || rejected < 0) throw new OpError('Good and rejected quantities must be whole numbers, 0 or more.');
  if (good + rejected === 0) throw new OpError('Enter how many units were made.');
  if (good + rejected > o.quantity) throw new OpError(`${o.orderNumber} was for ${o.quantity} units; good + rejected can't be more.`);
  if (input.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiryDate)) throw new OpError('Expiry date must be YYYY-MM-DD.');
  const p = db.products.find((x) => x.id === o.productId);
  if (!p) throw new OpError('The product of this order no longer exists.');
  const total = o.materials.reduce((s, m) => s + m.consumed * m.unitCost, 0) + o.labourCost + o.overheadCost;
  o.goodQty = good;
  o.rejectedQty = rejected;
  o.qcNotes = input.qcNotes?.trim() ?? '';
  if (input.batchNumber?.trim()) o.batchNumber = input.batchNumber.trim();
  o.actualUnitCost = good ? round2(total / good) : 0;
  if (good) {
    const before = Math.max(0, p.stock);
    p.unitCost = round2((before * p.unitCost + good * o.actualUnitCost) / (before + good));
    recordStockMovement(db, p.id, 'in', good, `Made in ${o.orderNumber} (batch ${o.batchNumber})`, o.orderNumber, actor, { locationId: o.locationId || null, batch: o.batchNumber, expiry: input.expiryDate });
    if (!p.trackBatches && input.expiryDate && (!p.expiryDate || input.expiryDate < p.expiryDate)) p.expiryDate = input.expiryDate;
  }
  o.status = 'completed';
  o.completedAt = now();
  if (rejected) notify(db, `QC rejects in ${o.orderNumber}`, `${rejected} of ${good + rejected} ${p.name} rejected${o.qcNotes ? `: ${o.qcNotes}` : ''}.`, rejected / (good + rejected) > 0.1 ? 'warning' : 'info');
  if (good && o.plannedUnitCost && o.actualUnitCost > o.plannedUnitCost * 1.05) {
    notify(db, `Production cost over plan: ${p.name}`, `${o.orderNumber} cost RM${o.actualUnitCost.toFixed(2)} per good unit vs RM${o.plannedUnitCost.toFixed(2)} planned (${Math.round((o.actualUnitCost / o.plannedUnitCost - 1) * 100)}% over).`, 'warning');
  }
  audit(db, actor, 'complete', 'production_order', o.orderNumber, `${o.orderNumber}: ${good} good, ${rejected} rejected, RM${o.actualUnitCost.toFixed(2)} per unit (planned RM${o.plannedUnitCost.toFixed(2)})`);
  return o;
}

/** Cancel a run. Materials already taken are returned to stock; write off any that were wasted with a stock-out. */
export function cancelProduction(db: BizPilotDB, id: string, actor: string): ProductionOrder {
  const o = findProductionOrder(db, id);
  if (o.status === 'completed' || o.status === 'cancelled') throw new OpError(`${o.orderNumber} is already ${o.status}.`);
  if (o.status === 'in_progress') {
    for (const m of o.materials) {
      if (m.consumed > 0) recordStockMovement(db, m.productId, 'in', m.consumed, `Returned from cancelled ${o.orderNumber}`, o.orderNumber, actor, { locationId: o.locationId || null });
      m.consumed = 0;
    }
  }
  o.status = 'cancelled';
  audit(db, actor, 'cancel', 'production_order', o.orderNumber, `${o.orderNumber} cancelled`);
  return o;
}

/**
 * Draft purchase orders for missing materials, one per supplier, each sent
 * to Approvals (blueprint A2 step 3: purchase requisitions for shortages).
 */
export function draftMaterialPurchases(db: BizPilotDB, id: string, actor: string): { purchaseOrders: PurchaseOrder[]; noSupplier: string[] } {
  const o = findProductionOrder(db, id);
  if (!['pending_approval', 'approved'].includes(o.status)) throw new OpError(`${o.orderNumber} is ${o.status.replace('_', ' ')}.`);
  const bySupplier = new Map<string, PurchaseOrderLine[]>();
  const noSupplier: string[] = [];
  for (const m of materialRequirements(db, o.productId, o.quantity, o.locationId, o.id)) {
    let qty = m.shortage - m.product.incoming;
    if (qty <= 0) continue;
    if (!m.supplier) { noSupplier.push(m.product.name); continue; }
    const multiple = m.product.orderMultiple > 1 ? m.product.orderMultiple : 1;
    qty = Math.max(qty, m.supplier.minOrderQty || 0);
    qty = Math.ceil(qty / multiple) * multiple;
    bySupplier.set(m.supplier.id, [...(bySupplier.get(m.supplier.id) ?? []), { productId: m.product.id, quantity: qty, unitCost: m.product.unitCost || m.supplier.unitCost || 0 }]);
  }
  const purchaseOrders: PurchaseOrder[] = [];
  for (const [supplierId, lines] of bySupplier) {
    const po = createPurchaseOrder(db, { supplierId, lines, note: `Materials for ${o.orderNumber}`, locationId: o.locationId || null }, actor);
    const s = db.suppliers.find((x) => x.id === supplierId)!;
    requestApproval(db, {
      type: 'purchase_order',
      title: `${po.poNumber} to ${s.name} (RM${po.totalCost.toFixed(2)})`,
      description: lines.map((l) => `${l.quantity}× ${db.products.find((p) => p.id === l.productId)?.name} @ RM${l.unitCost}`).join('; ') + ` — materials for ${o.orderNumber}`,
      payload: { purchaseOrderId: po.id },
      amount: po.totalCost,
    }, actor);
    purchaseOrders.push(po);
  }
  if (!purchaseOrders.length && !noSupplier.length) throw new OpError(`Nothing to buy for ${o.orderNumber}: materials are in stock or already on order.`);
  return { purchaseOrders, noSupplier };
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
  const supplier = db.suppliers.find((x) => x.id === po.supplierId)?.name ?? 'the supplier';
  addStaffTask(db, { kind: 'receive', title: `Receive ${po.poNumber} from ${supplier}`, detail: `${po.lines.map((l) => `${l.quantity}× ${db.products.find((x) => x.id === l.productId)?.name ?? 'item'}`).join(', ')}. Check quantities and condition, then record the delivery in Supply Chain.`, locationId: po.locationId ?? '', ref: po.poNumber, dueDate: po.expectedDate ?? null }, actor);
  audit(db, actor, 'execute', 'purchase_order', po.poNumber, `${po.poNumber} placed with supplier`);
  return po;
}

/** Goods received: on-hand goes up, incoming goes down, supplier stats update. */
export function receivePurchaseOrder(
  db: BizPilotDB,
  poId: string,
  received: Record<string, number> | 'all',
  actor: string,
  batches: Record<string, { batch?: string; expiry?: string }> = {},
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
      recordStockMovement(db, p.id, 'in', qty, `Received ${po.poNumber}`, po.poNumber, actor, { locationId: po.locationId, batch: batches[p.id]?.batch || (p.trackBatches ? po.poNumber : undefined), expiry: batches[p.id]?.expiry });
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
  if (po.status === 'received') closeStaffTasks(db, po.poNumber, actor);
  audit(db, actor, 'receive', 'purchase_order', po.poNumber, `${po.poNumber} ${po.status}`);
  return po;
}

/**
 * A purchase the owner already made and paid (from a receipt or supplier invoice they sent):
 * recorded as a placed PO so the cash ledger counts it, and received when the goods are in.
 * No approval and no cash check: the money is already spent.
 */
export function recordCompletedPurchase(db: BizPilotDB, input: POInput & { received: boolean; reference?: string }, actor: string): PurchaseOrder {
  const ref = input.reference?.trim();
  if (ref) {
    const dup = db.purchaseOrders.find((p) => p.supplierId === input.supplierId && p.status !== 'cancelled' && (p.note ?? '').includes(`Ref ${ref}`));
    if (dup) throw new OpError(`Supplier document ${ref} is already recorded as ${dup.poNumber}.`);
  }
  const po = createPurchaseOrder(db, { ...input, note: [ref ? `Ref ${ref}` : '', 'Recorded from the owner\'s receipt', input.note ?? ''].filter(Boolean).join(' · ') }, actor, 'approved');
  po.status = 'ordered';
  po.sentAt = now();
  for (const l of po.lines) {
    const p = db.products.find((x) => x.id === l.productId);
    if (p) p.incoming += l.quantity;
  }
  audit(db, actor, 'execute', 'purchase_order', po.poNumber, `${po.poNumber} recorded as already bought (RM${po.totalCost.toFixed(2)})`);
  if (input.received) receivePurchaseOrder(db, po.id, 'all', actor);
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
  dropStaffTasks(db, po.poNumber);
  for (const a of db.approvals) {
    if (a.status === 'pending' && a.type === 'purchase_order' && a.payload?.purchaseOrderId === po.id) {
      a.status = 'rejected'; a.decidedAt = now(); a.decidedBy = actor; a.executionResult = `${po.poNumber} was cancelled`;
    }
  }
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
  closeStaffTasks(db, o.orderNumber, actor);
  audit(db, actor, 'fulfil', 'sales_order', o.orderNumber, `${o.orderNumber} fulfilled`);
  return o;
}

export function cancelSalesOrder(db: BizPilotDB, orderId: string, actor: string, refund = false): SalesOrder {
  const o = db.salesOrders.find((x) => x.id === orderId || x.orderNumber === orderId);
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
  if (o.pickStatus) o.pickStatus = null;
  dropStaffTasks(db, o.orderNumber);
  if (refund) o.paymentStatus = 'refunded';
  const inv = o.invoiceId ? db.invoices.find((i) => i.id === o.invoiceId) : undefined;
  if (inv && (inv.status === 'draft' || inv.status === 'issued' || inv.status === 'overdue') && inv.einvoice?.status !== 'valid') {
    inv.status = 'cancelled';
    notify(db, `${inv.invoiceNumber} cancelled with ${o.orderNumber}`, refund ? 'Issue a credit note if the customer already received the invoice.' : 'The order was cancelled, so its unpaid invoice was cancelled too.', 'info');
  } else if (inv && inv.einvoice?.status === 'valid') {
    notify(db, `${o.orderNumber} cancelled: e-invoice needs action`, `${inv.invoiceNumber} is a validated e-invoice. Cancel it on MyInvois (within 72 hours) or issue a credit note.`, 'warning');
  }
  audit(db, actor, 'cancel', 'sales_order', o.orderNumber, `${o.orderNumber} cancelled${refund ? ' and refunded' : ''}`);
  recalcAvgDailySales(db);
  return o;
}

/**
 * Cancel an order. Without a refund it happens straight away; giving money back
 * to a paid customer is a refund, which the owner approves first (blueprint §12).
 */
export function requestOrderCancel(db: BizPilotDB, orderId: string, reason: string, actor: string): { order: SalesOrder; approval: ApprovalRequest | null } {
  const o = db.salesOrders.find((x) => x.id === orderId || x.orderNumber === orderId);
  if (!o) throw new OpError('Order not found.');
  if (o.status === 'cancelled') throw new OpError(`${o.orderNumber} is already cancelled.`);
  if (o.paymentStatus !== 'paid') return { order: cancelSalesOrder(db, o.id, actor, false), approval: null };
  if (db.approvals.some((a) => a.status === 'pending' && a.type === 'refund' && a.payload?.orderId === o.id)) throw new OpError(`A refund for ${o.orderNumber} is already waiting for approval.`);
  const approval = requestApproval(db, {
    type: 'refund', title: `Cancel ${o.orderNumber} and refund RM${o.total.toFixed(2)}`,
    description: `${o.customerName || 'Customer'}: ${reason}. Reserved stock is released (or returned to stock if already shipped).`,
    payload: { orderId: o.id, amount: o.total }, amount: o.total, risk: o.total > db.settings.approvalLimitAmount ? 'high' : 'medium',
  }, actor);
  return { order: o, approval };
}

/** Submit a content draft for publishing approval (compliance blocks stop it). */
export function submitContentForPublish(db: BizPilotDB, contentId: string, actor: string, opts: { autoPublish?: boolean } = {}): ApprovalRequest {
  const x = db.contentItems.find((y) => y.id === contentId);
  if (!x) throw new OpError('Content not found.');
  if (x.status === 'published') throw new OpError(`"${x.title}" is already published.`);
  if (db.approvals.some((a) => a.status === 'pending' && a.type === 'marketing_publish' && a.payload?.contentId === x.id)) throw new OpError(`"${x.title}" is already waiting for approval.`);
  const issues = checkCompliance(`${x.title}\n${x.body}`, db);
  const blocks = issues.filter((i) => i.level === 'block');
  if (blocks.length) throw new OpError(`Fix before submitting: ${blocks.map((i) => `${i.rule} ("${i.match}")`).join(', ')}`);
  const flagged = issues.map((i) => `${i.rule}: "${i.match}"`);
  x.status = 'in_review';
  x.error = null;
  return requestApproval(db, {
    type: 'marketing_publish',
    title: `Publish to ${x.platform}: ${x.title}`,
    description: `${x.type.replace('_', ' ')} scheduled ${new Date(x.scheduledDate).toLocaleString('en-MY')}${opts.autoPublish ? ' (auto-publish)' : ' (post manually)'}.\n\n${x.body.slice(0, 400)}${x.body.length > 400 ? '…' : ''}${x.imageUrl ? `\n\nImage: ${x.imageUrl}` : ''}${flagged.length ? `\n\n⚠ Compliance warnings: ${flagged.join('; ')}` : ''}`,
    payload: { contentId: x.id },
    risk: flagged.length ? 'medium' : 'low',
  }, actor);
}

export type CampaignPatch = Partial<Pick<Campaign, 'name' | 'objective' | 'platform' | 'budget' | 'dailyCap' | 'spend' | 'clicks' | 'impressions' | 'conversions' | 'revenue' | 'status' | 'startDate' | 'endDate'>>;

/**
 * Update a campaign. Starting it, or raising its budget, spends money, so that
 * goes to Approvals; pausing, ending and recording results happen straight away.
 */
export function updateCampaign(db: BizPilotDB, id: string, patch: CampaignPatch, actor: string): { campaign: Campaign; approval: ApprovalRequest | null } {
  const c = db.campaigns.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!c) throw new OpError('Campaign not found.');
  const { status, budget, dailyCap, ...rest } = patch;
  Object.assign(c, rest);
  const spendUp = (budget !== undefined && budget > c.budget) || (dailyCap !== undefined && dailyCap > c.dailyCap);
  const launch = status === 'active' && c.status !== 'active';
  if (budget !== undefined && !spendUp) c.budget = budget;
  if (dailyCap !== undefined && !spendUp) c.dailyCap = dailyCap;
  if (status && status !== 'active') c.status = status;
  let approval: ApprovalRequest | null = null;
  if (launch || spendUp) {
    const newBudget = budget ?? c.budget;
    approval = requestApproval(db, {
      type: 'campaign_launch',
      title: launch ? `Start campaign ${c.name} (RM${newBudget.toFixed(2)})` : `Raise ${c.name} budget to RM${newBudget.toFixed(2)}`,
      description: `${c.platform}, ${c.objective}. Budget RM${newBudget.toFixed(2)}, daily cap RM${(dailyCap ?? c.dailyCap).toFixed(2)}.`,
      payload: { campaignId: c.id, activate: launch || c.status === 'active', budget: newBudget, dailyCap: dailyCap ?? c.dailyCap },
      amount: newBudget,
    }, actor);
  }
  audit(db, actor, 'update', 'campaign', c.id, `Campaign updated: ${c.name}${approval ? ' (spend change sent to Approvals)' : ''}`);
  return { campaign: c, approval };
}

/** Business settings the agent may change. Automation level, approval limit and capital stay with the owner. */
export const AGENT_SETTINGS = ['brandVoice', 'targetAudience', 'prohibitedClaims', 'brandDifferentiators', 'brandStyle', 'brandLanguages', 'brandCompetitors', 'targetMarginPct', 'lowStockThresholdDays', 'shipFromPostcode', 'msicCode', 'msicDescription', 'addressLine', 'city', 'postcode', 'phone', 'email', 'deliveryInfo'] as const;
export type AgentSettingsPatch = Partial<Pick<BizPilotDB['settings'], (typeof AGENT_SETTINGS)[number]>>;

export function updateBusinessSettings(db: BizPilotDB, patch: AgentSettingsPatch, actor: string) {
  const keys = Object.keys(patch).filter((k) => (AGENT_SETTINGS as readonly string[]).includes(k) && (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) throw new OpError(`Nothing to change. Allowed: ${AGENT_SETTINGS.join(', ')}.`);
  for (const k of keys) (db.settings as unknown as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
  audit(db, actor, 'update', 'settings', 'business', `Settings updated: ${keys.join(', ')}`);
  return keys;
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
  const inv = db.invoices.find((i) => i.id === invoiceId || i.invoiceNumber === invoiceId);
  if (!inv) throw new OpError('Invoice not found.');
  if (inv.status === 'cancelled' || inv.status === 'draft') throw new OpError(`${inv.invoiceNumber} is ${inv.status}.`);
  inv.status = 'paid';
  inv.paidDate = now();
  // The order behind the invoice is paid too (its money is counted once, on the order).
  const order = inv.orderId ? db.salesOrders.find((o) => o.id === inv.orderId) : undefined;
  if (order && order.paymentStatus === 'pending') order.paymentStatus = 'paid';
  audit(db, actor, 'paid', 'invoice', inv.invoiceNumber, `${inv.invoiceNumber} marked paid`);
  return inv;
}

/** Customer paid for an order: the order and its issued invoice are both settled. */
export function recordOrderPayment(db: BizPilotDB, orderId: string, actor: string): SalesOrder {
  const o = db.salesOrders.find((x) => x.id === orderId || x.orderNumber === orderId);
  if (!o) throw new OpError('Order not found.');
  if (o.status === 'cancelled') throw new OpError(`${o.orderNumber} is cancelled.`);
  if (o.paymentStatus === 'paid') return o;
  o.paymentStatus = 'paid';
  const inv = o.invoiceId ? db.invoices.find((i) => i.id === o.invoiceId) : undefined;
  if (inv && (inv.status === 'issued' || inv.status === 'overdue')) { inv.status = 'paid'; inv.paidDate = now(); }
  audit(db, actor, 'paid', 'sales_order', o.orderNumber, `${o.orderNumber} payment received${inv ? ` (${inv.invoiceNumber} settled)` : ''}`);
  return o;
}

export function cancelInvoice(db: BizPilotDB, invoiceId: string, actor: string): Invoice {
  const x = db.invoices.find((i) => i.id === invoiceId || i.invoiceNumber === invoiceId);
  if (!x) throw new OpError('Invoice not found.');
  if (x.status === 'paid' || x.status === 'cancelled') throw new OpError(`${x.invoiceNumber} is ${x.status}; issue a credit note instead.`);
  if (x.einvoice?.status === 'valid') throw new OpError('Cancel the e-invoice on MyInvois first.');
  x.status = 'cancelled';
  if (x.recurrence?.active) x.recurrence = { ...x.recurrence, active: false };
  for (const o of db.salesOrders) if (o.invoiceId === x.id) o.invoiceId = null;
  audit(db, actor, 'cancel', 'invoice', x.invoiceNumber, `${x.invoiceNumber} cancelled`);
  return x;
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

// ---------------------------------------------------------------- quotations, reminders, recurring invoices (blueprint D5)

export interface QuotationInput {
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  customerTin?: string;
  customerBrn?: string;
  lines: InvoiceLine[];
  validDays?: number;
  paymentDays?: number;
  note?: string;
}

function checkLines(lines: InvoiceLine[]) {
  if (!lines.length) throw new OpError('Add at least one line.');
  for (const l of lines) {
    if (!l.description?.trim()) throw new OpError('Every line needs a description.');
    if (!(l.quantity > 0)) throw new OpError('Quantities must be above 0.');
    if (!(l.unitPrice >= 0)) throw new OpError('Unit prices must be 0 or more.');
  }
}

export function createQuotation(db: BizPilotDB, input: QuotationInput, actor: string): Quotation {
  if (!input.customerName?.trim()) throw new OpError('Customer name is required.');
  checkLines(input.lines);
  const validDays = input.validDays ?? 14;
  if (!(validDays >= 1)) throw new OpError('A quotation must be valid for at least 1 day.');
  const q: Quotation = {
    id: newId(),
    quoteNumber: nextNumber(db.quotations.map((x) => x.quoteNumber), 'QT'),
    customerName: input.customerName.trim(),
    customerEmail: input.customerEmail?.trim() ?? '',
    customerPhone: input.customerPhone?.trim() ?? '',
    customerAddress: input.customerAddress?.trim() ?? '',
    customerTin: input.customerTin?.trim() ?? '',
    customerBrn: input.customerBrn?.trim() ?? '',
    lines: input.lines.map((l) => ({ ...l, description: l.description.trim(), classificationCode: l.classificationCode ?? '022' })),
    ...invoiceTotals(input.lines),
    status: 'draft',
    issuedDate: now(),
    validUntil: new Date(Date.now() + validDays * DAY).toISOString(),
    paymentDays: Math.max(0, Math.round(input.paymentDays ?? 30)),
    note: input.note?.trim() ?? '',
    invoiceId: null,
    createdBy: actor,
  };
  db.quotations.unshift(q);
  audit(db, actor, 'create', 'quotation', q.quoteNumber, `Quotation ${q.quoteNumber} for ${q.customerName} RM${q.total.toFixed(2)}`);
  return q;
}

export function findQuotation(db: BizPilotDB, ref: string): Quotation {
  const r = ref.trim().toLowerCase();
  const q = db.quotations.find((x) => x.id === ref || x.quoteNumber.toLowerCase() === r);
  if (!q) throw new OpError('Quotation not found.');
  return q;
}

/** Edit a quotation that has not been sent yet. */
export function updateQuotation(db: BizPilotDB, id: string, input: QuotationInput, actor: string): Quotation {
  const q = findQuotation(db, id);
  if (q.status !== 'draft') throw new OpError(`${q.quoteNumber} is ${q.status}; only drafts can be edited.`);
  if (!input.customerName?.trim()) throw new OpError('Customer name is required.');
  checkLines(input.lines);
  Object.assign(q, {
    customerName: input.customerName.trim(),
    customerEmail: input.customerEmail?.trim() ?? '',
    customerPhone: input.customerPhone?.trim() ?? '',
    customerAddress: input.customerAddress?.trim() ?? '',
    customerTin: input.customerTin?.trim() ?? '',
    customerBrn: input.customerBrn?.trim() ?? '',
    lines: input.lines.map((l) => ({ ...l, description: l.description.trim(), classificationCode: l.classificationCode ?? '022' })),
    ...invoiceTotals(input.lines),
    validUntil: new Date(new Date(q.issuedDate).getTime() + (input.validDays ?? 14) * DAY).toISOString(),
    paymentDays: Math.max(0, Math.round(input.paymentDays ?? q.paymentDays)),
    note: input.note?.trim() ?? q.note,
  });
  audit(db, actor, 'update', 'quotation', q.quoteNumber, `Draft ${q.quoteNumber} edited (RM${q.total.toFixed(2)})`);
  return q;
}

/** Record that the quotation went to the customer (by email after approval, or sent by hand). */
export function markQuotationSent(db: BizPilotDB, id: string, actor: string): Quotation {
  const q = findQuotation(db, id);
  if (q.status !== 'draft') throw new OpError(`${q.quoteNumber} is already ${q.status}.`);
  q.status = 'sent';
  q.issuedDate = now();
  audit(db, actor, 'send', 'quotation', q.quoteNumber, `${q.quoteNumber} sent to ${q.customerName}`);
  return q;
}

export function requestQuotationSend(db: BizPilotDB, id: string, actor: string): ApprovalRequest {
  const q = findQuotation(db, id);
  if (q.status !== 'draft') throw new OpError(`${q.quoteNumber} is already ${q.status}.`);
  if (db.approvals.some((a) => a.status === 'pending' && a.type === 'quotation_send' && a.payload.quotationId === q.id)) throw new OpError(`${q.quoteNumber} is already waiting in Approvals.`);
  return requestApproval(db, {
    type: 'quotation_send',
    title: `Send quotation ${q.quoteNumber} to ${q.customerName} (RM${q.total.toFixed(2)})`,
    description: `${q.lines.map((l) => `${l.quantity}× ${l.description} @ RM${l.unitPrice}`).join('; ')}. Valid until ${q.validUntil.slice(0, 10)}.` +
      (q.customerEmail ? ` Will be emailed to ${q.customerEmail}.` : ' No customer email: approve, then share the PDF yourself.'),
    payload: { quotationId: q.id },
    amount: q.total,
    risk: 'low',
  }, actor);
}

export function setQuotationOutcome(db: BizPilotDB, id: string, outcome: 'accepted' | 'declined', actor: string): Quotation {
  const q = findQuotation(db, id);
  if (q.status === 'converted' || q.status === outcome) throw new OpError(`${q.quoteNumber} is already ${q.status}.`);
  q.status = outcome;
  audit(db, actor, outcome, 'quotation', q.quoteNumber, `${q.quoteNumber} ${outcome} by ${q.customerName}`);
  return q;
}

/** An accepted quotation becomes a draft invoice with the same customer, lines and payment terms. */
export function convertQuotationToInvoice(db: BizPilotDB, id: string, actor: string): Invoice {
  const q = findQuotation(db, id);
  if (q.status === 'converted') throw new OpError(`${q.quoteNumber} is already invoiced.`);
  if (q.status === 'declined') throw new OpError(`${q.quoteNumber} was declined.`);
  const inv = createInvoice(db, {
    customerName: q.customerName, customerEmail: q.customerEmail, customerPhone: q.customerPhone, customerAddress: q.customerAddress,
    customerTin: q.customerTin, customerBrn: q.customerBrn, lines: q.lines, dueDays: q.paymentDays,
  }, actor);
  inv.quotationId = q.id;
  q.status = 'converted';
  q.invoiceId = inv.id;
  audit(db, actor, 'convert', 'quotation', q.quoteNumber, `${q.quoteNumber} accepted and turned into ${inv.invoiceNumber}`);
  return inv;
}

/** Drafts and sent quotations past their valid-until date become expired. */
export function refreshExpiredQuotations(db: BizPilotDB) {
  for (const q of db.quotations) {
    if ((q.status === 'draft' || q.status === 'sent') && new Date(q.validUntil).getTime() < Date.now() - DAY) q.status = 'expired';
  }
}

/** Polite first, firmer later (blueprint D5 payment reminders). */
export function reminderText(db: BizPilotDB, inv: Invoice): { subject: string; body: string } {
  const s = db.settings;
  const from = s.legalName || s.name || 'us';
  const late = Math.floor((Date.now() - new Date(inv.dueDate).getTime()) / DAY);
  const n = inv.remindersSent ?? 0;
  const amount = `RM${inv.total.toFixed(2)}`;
  const due = inv.dueDate.slice(0, 10);
  const contact = [s.phone, s.email].filter(Boolean).join(' or ');
  const opening = late <= 0
    ? `This is a friendly reminder that invoice ${inv.invoiceNumber} for ${amount} is due on ${due}.`
    : n === 0
      ? `Our records show invoice ${inv.invoiceNumber} for ${amount}, due on ${due}, is still unpaid (${late} day${late === 1 ? '' : 's'} overdue). It may simply have been missed.`
      : n === 1
        ? `This is a second reminder: invoice ${inv.invoiceNumber} for ${amount} was due on ${due} and is now ${late} days overdue.`
        : `Invoice ${inv.invoiceNumber} for ${amount} is now ${late} days overdue despite earlier reminders. Please settle it as soon as possible or contact us to agree a payment date.`;
  return {
    subject: `${late > 0 ? 'Overdue: ' : 'Reminder: '}invoice ${inv.invoiceNumber} from ${from}`,
    body: [
      `Dear ${inv.customerName},`,
      '',
      opening,
      'If you have already paid, please ignore this message and accept our thanks.',
      contact ? `For any questions, contact us at ${contact}.` : '',
      '',
      `Thank you,`,
      from,
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
  };
}

/** Draft a payment reminder and send it to Approvals; it is emailed (or shown to copy) once approved. */
export function requestPaymentReminder(db: BizPilotDB, invoiceId: string, actor: string, text?: { subject?: string; body?: string }): ApprovalRequest {
  const inv = db.invoices.find((i) => i.id === invoiceId || i.invoiceNumber.toLowerCase() === invoiceId.trim().toLowerCase());
  if (!inv) throw new OpError('Invoice not found.');
  if (inv.status !== 'issued' && inv.status !== 'overdue') throw new OpError(`${inv.invoiceNumber} is ${inv.status}; only unpaid issued invoices get reminders.`);
  if (db.approvals.some((a) => a.status === 'pending' && a.type === 'payment_reminder' && a.payload.invoiceId === inv.id)) throw new OpError(`A reminder for ${inv.invoiceNumber} is already waiting in Approvals.`);
  const t = reminderText(db, inv);
  const subject = text?.subject?.trim() || t.subject;
  const body = text?.body?.trim() || t.body;
  return requestApproval(db, {
    type: 'payment_reminder',
    title: `Payment reminder ${(inv.remindersSent ?? 0) + 1} for ${inv.invoiceNumber} to ${inv.customerName} (RM${inv.total.toFixed(2)})`,
    description: `${inv.customerEmail ? `Email to ${inv.customerEmail}` : 'No customer email: copy the text and send it by WhatsApp or SMS'}.\n\nSubject: ${subject}\n\n${body}`,
    payload: { invoiceId: inv.id, to: inv.customerEmail, subject, body },
    amount: inv.total,
    risk: 'low',
  }, actor);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function addPeriod(date: string, every: InvoiceRecurrence['every']): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (every === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else {
    const months = every === 'month' ? 1 : every === 'quarter' ? 3 : 12;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return isoDay(d);
}

/** Repeat an invoice every week, month, quarter or year; null stops it. */
export function setInvoiceRecurrence(db: BizPilotDB, invoiceId: string, every: InvoiceRecurrence['every'] | null, actor: string, startDate?: string): Invoice {
  const inv = db.invoices.find((i) => i.id === invoiceId);
  if (!inv) throw new OpError('Invoice not found.');
  if (!every) {
    if (inv.recurrence?.active) {
      inv.recurrence = { ...inv.recurrence, active: false };
      audit(db, actor, 'update', 'invoice', inv.invoiceNumber, `${inv.invoiceNumber} stopped repeating`);
    }
    return inv;
  }
  if (inv.type !== 'invoice') throw new OpError('Only normal invoices can repeat.');
  if (inv.status === 'cancelled') throw new OpError(`${inv.invoiceNumber} is cancelled.`);
  if (inv.recurringFrom) throw new OpError(`${inv.invoiceNumber} is a copy of a repeating invoice; change the original instead.`);
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new OpError('Next date must be YYYY-MM-DD.');
  inv.recurrence = { every, nextDate: startDate || addPeriod(inv.issuedDate, every), active: true };
  audit(db, actor, 'update', 'invoice', inv.invoiceNumber, `${inv.invoiceNumber} repeats every ${every}, next on ${inv.recurrence.nextDate}`);
  return inv;
}

/**
 * Make the copies of repeating invoices that are due (run daily by the
 * server). Each copy is a draft that goes to Approvals to be issued. Missed
 * periods (server asleep) produce one copy, not a burst.
 */
export function runRecurringInvoices(db: BizPilotDB, actor: string, today = isoDay(new Date())): Invoice[] {
  const made: Invoice[] = [];
  for (const src of [...db.invoices]) {
    const r = src.recurrence;
    if (!r?.active || r.nextDate > today || src.status === 'cancelled') continue;
    const terms = Math.max(0, Math.round((new Date(src.dueDate).getTime() - new Date(src.issuedDate).getTime()) / DAY));
    const copy = createInvoice(db, {
      customerName: src.customerName, customerEmail: src.customerEmail, customerPhone: src.customerPhone, customerAddress: src.customerAddress,
      customerTin: src.customerTin, customerBrn: src.customerBrn, lines: src.lines, dueDays: terms,
    }, actor);
    copy.recurringFrom = src.id;
    requestApproval(db, {
      type: 'invoice_issue',
      title: `Issue ${copy.invoiceNumber} to ${copy.customerName} (RM${copy.total.toFixed(2)}), repeat of ${src.invoiceNumber}`,
      description: `Every ${r.every}. ${copy.lines.length} line(s), subtotal RM${copy.subtotal.toFixed(2)} + tax RM${copy.taxTotal.toFixed(2)}.${copy.customerEmail ? ` Will be sent to ${copy.customerEmail}.` : ''}`,
      payload: { invoiceId: copy.id },
      amount: copy.total,
      risk: 'low',
    }, actor);
    let next = r.nextDate;
    while (next <= today) next = addPeriod(next, r.every);
    src.recurrence = { ...r, nextDate: next };
    made.push(copy);
  }
  return made;
}

export function payExpense(db: BizPilotDB, expenseId: string, actor: string): Expense {
  const x = db.expenses.find((e) => e.id === expenseId);
  if (!x) throw new OpError('Expense not found.');
  if (x.paid) throw new OpError(`${x.description} is already paid.`);
  x.paid = true;
  audit(db, actor, 'paid', 'expense', x.id, `Bill paid: ${x.description} RM${x.amount.toFixed(2)}`);
  return x;
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
    case 'production_order':
      return approveProductionOrder(db, String(p.productionOrderId), actor);
    case 'payment_reminder': {
      const inv = db.invoices.find((x) => x.id === p.invoiceId);
      if (!inv) throw new OpError('Invoice no longer exists.');
      inv.remindersSent = (inv.remindersSent ?? 0) + 1;
      inv.lastReminderAt = now();
      audit(db, actor, 'remind', 'invoice', inv.invoiceNumber, `Payment reminder ${inv.remindersSent} ${external.sentTo ? `emailed to ${external.sentTo}` : 'approved for manual sending'}`);
      return external.sentTo
        ? `Reminder emailed to ${external.sentTo}.`
        : 'Reminder approved. No email was sent (no customer email, or email is not set up in Settings): copy the text above and send it by WhatsApp or SMS.';
    }
    case 'quotation_send': {
      const q = markQuotationSent(db, String(p.quotationId), actor);
      return external.sentTo ? `${q.quoteNumber} emailed to ${external.sentTo}.` : `${q.quoteNumber} marked as sent. Print it as PDF from Finance → Quotations and share it with the customer.`;
    }
    case 'campaign_launch': {
      const c = db.campaigns.find((x) => x.id === p.campaignId);
      if (!c) throw new OpError('Campaign no longer exists.');
      c.budget = round2(Number(p.budget ?? c.budget));
      c.dailyCap = round2(Number(p.dailyCap ?? c.dailyCap));
      if (p.activate) c.status = 'active';
      audit(db, actor, 'execute', 'campaign', c.id, `Campaign ${c.name}: ${c.status}, budget RM${c.budget.toFixed(2)}`);
      return `${c.name} is ${c.status} with a RM${c.budget.toFixed(2)} budget. Start or adjust it in the ad platform; record spend and results here.`;
    }
    case 'data_erasure': {
      const n = eraseCustomerData(db, String(p.customer), actor);
      return `Personal data erased from ${n} record(s). Amounts on invoices are kept for tax records (7 years).`;
    }
    case 'refund': {
      if (p.orderId) {
        const o = cancelSalesOrder(db, String(p.orderId), actor, true);
        return `${o.orderNumber} cancelled and RM${Number(p.amount ?? o.total).toFixed(2)} marked refunded. Pay the customer back through your payment channel.`;
      }
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
  const ret = db.returns.find((r) => r.id === id || r.returnNumber === id);
  if (!ret) throw new OpError('Return case not found.');
  ret.status = 'rejected';
  ret.resolvedAt = now();
  ret.notes = [ret.notes, `Rejected: ${why}`].filter(Boolean).join('\n');
  audit(db, actor, 'reject', 'return', ret.returnNumber, why);
  return ret;
}


// ---------------------------------------------------------------- warehouse (blueprint §5 A3)

/** Shelf/bin code of a product at a location ('' = default location). */
export function binOf(db: BizPilotDB, p: Product, locationId?: string | null): string {
  const bins = p.bins ?? {};
  const loc = locationId || defaultLocation(db)?.id || '';
  return bins[loc] ?? bins[''] ?? '';
}

export function setBin(db: BizPilotDB, productId: string, locationId: string | null, bin: string, actor: string): Product {
  const p = requireProduct(db, productId);
  const code = bin.trim().toUpperCase();
  const key = locationId || '';
  if (key && !db.locations.some((l) => l.id === key)) throw new OpError('Location not found.');
  const bins = { ...(p.bins ?? {}) };
  if (code) bins[key] = code; else delete bins[key];
  p.bins = bins;
  audit(db, actor, 'update', 'product', p.sku, `${p.name}: bin ${code || 'cleared'}${key ? ` at ${db.locations.find((l) => l.id === key)?.name}` : ''}`);
  return p;
}

export interface PickLine { product: Product; bin: string; quantity: number; orders: string[] }

/** One walk through the shelves: every line of the orders, grouped by product and sorted by bin. */
export function pickList(db: BizPilotDB, orderIds?: string[]): { orders: SalesOrder[]; lines: PickLine[] } {
  const orders = db.salesOrders.filter((o) => o.status === 'awaiting_fulfilment' && o.pickStatus !== 'picked' && o.pickStatus !== 'packed'
    && (!orderIds?.length || orderIds.includes(o.id) || orderIds.includes(o.orderNumber)));
  const map = new Map<string, PickLine>();
  for (const o of orders) {
    for (const l of o.lines) {
      const p = l.productId ? db.products.find((x) => x.id === l.productId) : undefined;
      if (!p) continue;
      const key = `${p.id}|${o.locationId ?? ''}`;
      const line = map.get(key) ?? { product: p, bin: binOf(db, p, o.locationId), quantity: 0, orders: [] };
      line.quantity += l.quantity;
      if (!line.orders.includes(o.orderNumber)) line.orders.push(o.orderNumber);
      map.set(key, line);
    }
  }
  const lines = [...map.values()].sort((a, b) => (a.bin || '~').localeCompare(b.bin || '~') || a.product.name.localeCompare(b.product.name));
  return { orders, lines };
}

/** Start a pick run: orders move to "picking" and one pick task lists every shelf to visit. */
export function startPickRun(db: BizPilotDB, orderIds: string[] | undefined, actor: string, assignee = ''): { task: StaffTask; orders: SalesOrder[] } {
  const { orders } = pickList(db, orderIds);
  const todo = orders.filter((o) => o.pickStatus !== 'picking');
  if (!todo.length) throw new OpError('No orders are waiting to be picked.');
  const run = pickList(db, todo.map((o) => o.id));
  for (const o of todo) o.pickStatus = 'picking';
  const task = addStaffTask(db, {
    kind: 'pick', assignee, locationId: todo[0].locationId ?? '',
    title: `Pick ${todo.length} order(s)`,
    detail: run.lines.map((l) => `${l.bin || 'no bin'}: ${l.quantity}× ${l.product.name} (${l.product.sku}) for ${l.orders.join(', ')}`).join('\n'),
    ref: todo.map((o) => o.orderNumber).join(', '),
  }, actor);
  return { task, orders: todo };
}

export function markPicked(db: BizPilotDB, orderId: string, actor: string): SalesOrder {
  const o = db.salesOrders.find((x) => x.id === orderId || x.orderNumber === orderId);
  if (!o) throw new OpError('Order not found.');
  if (o.status !== 'awaiting_fulfilment') throw new OpError(`${o.orderNumber} is ${o.status}.`);
  if (o.pickStatus === 'picked' || o.pickStatus === 'packed') return o;
  for (const l of o.lines) {
    const p = l.productId ? db.products.find((x) => x.id === l.productId) : undefined;
    if (p && p.stock < l.quantity) throw new OpError(`Only ${p.stock} ${p.name} on hand; ${o.orderNumber} needs ${l.quantity}.`);
  }
  o.pickStatus = 'picked';
  o.pickedAt = now();
  audit(db, actor, 'pick', 'sales_order', o.orderNumber, `${o.orderNumber} picked`);
  return o;
}

/** Packed and labelled: ready for the courier or the counter. A pack task follows for online orders without a booking. */
export function markPacked(db: BizPilotDB, orderId: string, actor: string): SalesOrder {
  const o = db.salesOrders.find((x) => x.id === orderId || x.orderNumber === orderId);
  if (!o) throw new OpError('Order not found.');
  if (o.status !== 'awaiting_fulfilment') throw new OpError(`${o.orderNumber} is ${o.status}.`);
  if (o.pickStatus !== 'picked' && o.pickStatus !== 'picking') markPicked(db, o.id, actor);
  o.pickStatus = 'packed';
  o.packedAt = now();
  o.packedBy = actor;
  closeStaffTasks(db, o.orderNumber, actor);
  audit(db, actor, 'pack', 'sales_order', o.orderNumber, `${o.orderNumber} packed`);
  return o;
}

/** Barcode scan: the product with this barcode or SKU. */
export function findByCode(db: BizPilotDB, code: string): Product | undefined {
  const c = code.trim();
  if (!c) return undefined;
  const lc = c.toLowerCase();
  return db.products.find((p) => p.barcode && p.barcode === c) ?? db.products.find((p) => p.sku.toLowerCase() === lc);
}

export interface StaffTaskInput { kind: StaffTask['kind']; title: string; detail?: string; assignee?: string; locationId?: string | null; ref?: string; dueDate?: string | null }

export function addStaffTask(db: BizPilotDB, input: StaffTaskInput, actor: string): StaffTask {
  const list = (db.staffTasks ??= []);
  const t: StaffTask = {
    id: newId(),
    taskNumber: nextNumber(list.map((x) => x.taskNumber), 'TSK'),
    title: input.title.trim(),
    detail: input.detail?.trim() ?? '',
    kind: input.kind,
    assignee: input.assignee?.trim().toLowerCase() ?? '',
    locationId: input.locationId ?? '',
    ref: input.ref ?? '',
    dueDate: input.dueDate || null,
    status: 'open',
    createdAt: now(),
    completedAt: null,
    createdBy: actor,
    doneBy: '',
  };
  if (!t.title) throw new OpError('Give the task a title.');
  list.unshift(t);
  return t;
}

export function updateStaffTask(db: BizPilotDB, id: string, patch: Partial<Pick<StaffTask, 'status' | 'assignee' | 'dueDate' | 'title' | 'detail'>>, actor: string): StaffTask {
  const t = (db.staffTasks ?? []).find((x) => x.id === id || x.taskNumber === id);
  if (!t) throw new OpError('Task not found.');
  if (patch.title !== undefined) t.title = patch.title.trim() || t.title;
  if (patch.detail !== undefined) t.detail = patch.detail;
  if (patch.assignee !== undefined) t.assignee = patch.assignee.trim().toLowerCase();
  if (patch.dueDate !== undefined) t.dueDate = patch.dueDate || null;
  if (patch.status && patch.status !== t.status) {
    t.status = patch.status;
    if (patch.status === 'done') { t.completedAt = now(); t.doneBy = actor; }
    audit(db, actor, 'update', 'task', t.taskNumber, `${t.taskNumber} ${patch.status}: ${t.title}`);
  }
  return t;
}

/** The work was called off: its open tasks are cancelled. */
function dropStaffTasks(db: BizPilotDB, ref: string) {
  for (const t of db.staffTasks ?? []) {
    if ((t.status === 'open' || t.status === 'in_progress') && t.ref.split(',').map((x) => x.trim()).includes(ref)) {
      const rest = t.ref.split(',').map((x) => x.trim()).filter((x) => x && x !== ref);
      if (rest.length) t.ref = rest.join(', '); else t.status = 'cancelled';
    }
  }
}

/** Work that is finished in the records closes its open task (receive, count, pick). */
function closeStaffTasks(db: BizPilotDB, ref: string, actor: string) {
  for (const t of db.staffTasks ?? []) {
    if (t.status === 'done' || t.status === 'cancelled') continue;
    const refs = t.ref.split(',').map((x) => x.trim()).filter(Boolean);
    if (!refs.includes(ref)) continue;
    const allDone = refs.every((r) => {
      const o = db.salesOrders.find((x) => x.orderNumber === r);
      if (!o) return r === ref;
      return o.status !== 'awaiting_fulfilment' || (t.kind === 'pick' ? o.pickStatus === 'picked' || o.pickStatus === 'packed' : o.pickStatus === 'packed');
    });
    if (allDone) { t.status = 'done'; t.completedAt = now(); t.doneBy = actor; }
  }
}

// ---------------------------------------------------------------- "BizPilot noticed"

/** Clear a noticed item; it stays hidden for 30 days. Old entries are pruned. */
export function dismissSignal(db: BizPilotDB, key: string, actor: string) {
  const at = Date.now();
  const kept = Object.entries(db.settings.dismissedSignals ?? {}).filter(([, t]) => at - Date.parse(t) < 30 * 86_400_000);
  db.settings.dismissedSignals = { ...Object.fromEntries(kept), [key]: new Date(at).toISOString() };
  audit(db, actor, 'update', 'settings', 'noticed', `Cleared "${key}"`);
}

// ---------------------------------------------------------------- finance extras (blueprint §8 D)

export function setBudget(db: BizPilotDB, category: string, monthly: number, actor: string) {
  const cat = category.trim();
  if (!cat) throw new OpError('Give the expense category.');
  if (!(monthly >= 0)) throw new OpError('The budget must be 0 or more.');
  const budgets = { ...(db.settings.budgets ?? {}) };
  if (monthly === 0) delete budgets[cat]; else budgets[cat] = round2(monthly);
  db.settings.budgets = budgets;
  audit(db, actor, 'update', 'settings', 'budget', monthly ? `Budget ${cat}: RM${monthly.toFixed(2)}/month` : `Budget ${cat} removed`);
  return budgets;
}

export function attachReceipt(db: BizPilotDB, expenseId: string, path: string, actor: string): Expense {
  const x = db.expenses.find((e) => e.id === expenseId);
  if (!x) throw new OpError('Expense not found.');
  x.receiptUrl = path;
  audit(db, actor, 'update', 'expense', x.id, `Receipt ${path ? 'attached to' : 'removed from'} ${x.description}`);
  return x;
}

// ---------------------------------------------------------------- PDPA (blueprint §17)

export const customerKeyOf = (email?: string, phone?: string) =>
  (email?.trim().toLowerCase() || (phone ?? '').replace(/\D/g, '')).trim();

export interface ConsentInput { customerName?: string; email?: string; phone?: string; purpose: Consent['purpose']; channel?: Consent['channel']; status: Consent['status']; source: string; note?: string }

/** Consent history is kept: each change is a new record; the latest one counts. */
export function recordConsent(db: BizPilotDB, input: ConsentInput, actor: string): Consent {
  const key = customerKeyOf(input.email, input.phone);
  if (!key) throw new OpError('Give the customer\'s email or phone number.');
  if (!input.source.trim()) throw new OpError('Say how the consent was given (e.g. "signed up at the counter", "WhatsApp reply").');
  const c: Consent = {
    id: newId(), customerKey: key, customerName: input.customerName?.trim() ?? '', email: input.email?.trim() ?? '', phone: input.phone?.trim() ?? '',
    purpose: input.purpose, channel: input.channel ?? 'any', status: input.status, source: input.source.trim(), note: input.note?.trim() ?? '', at: now(), recordedBy: actor,
  };
  (db.consents ??= []).unshift(c);
  audit(db, actor, 'consent', 'customer', key, `${input.purpose} consent ${input.status} (${c.source})`);
  return c;
}

/** Latest consent for this customer and purpose (and channel, if given). */
export function consentStatus(db: BizPilotDB, emailOrPhone: string, purpose: Consent['purpose'], channel?: Consent['channel']): Consent | null {
  const key = emailOrPhone.includes('@') ? emailOrPhone.trim().toLowerCase() : emailOrPhone.replace(/\D/g, '');
  if (!key) return null;
  const list = (db.consents ?? []).filter((c) => c.customerKey === key && c.purpose === purpose && (!channel || c.channel === 'any' || c.channel === channel));
  return list.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/** Marketing messages need recorded, un-withdrawn consent (PDPA s.43 and the opt-out rule). */
export function assertMarketingConsent(db: BizPilotDB, emailOrPhone: string, channel: Consent['channel']) {
  const c = consentStatus(db, emailOrPhone, 'marketing', channel);
  if (!c || c.status !== 'granted') throw new OpError(`${emailOrPhone} has ${c ? 'withdrawn' : 'not given'} consent to marketing messages. Only service messages (orders, invoices, support) may be sent.`);
}

const matchesCustomer = (key: string, email?: string, phone?: string, name?: string) => {
  const k = key.trim().toLowerCase();
  if (!k) return false;
  if (k.includes('@')) return (email ?? '').trim().toLowerCase() === k;
  const digits = k.replace(/\D/g, '');
  if (digits.length >= 6) return (phone ?? '').replace(/\D/g, '') === digits;
  return (name ?? '').trim().toLowerCase() === k;
};

/** Everything BizPilot holds about one customer (PDPA access request). */
export function customerDataExport(db: BizPilotDB, key: string) {
  return {
    customer: key,
    exportedAt: now(),
    orders: db.salesOrders.filter((o) => matchesCustomer(key, o.customerEmail, o.customerPhone, o.customerName)).map((o) => ({ orderNumber: o.orderNumber, date: o.date, name: o.customerName, email: o.customerEmail, phone: o.customerPhone, address: o.shippingAddress, total: o.total, lines: o.lines })),
    invoices: db.invoices.filter((i) => matchesCustomer(key, i.customerEmail, i.customerPhone, i.customerName)).map((i) => ({ invoiceNumber: i.invoiceNumber, date: i.issuedDate, name: i.customerName, email: i.customerEmail, phone: i.customerPhone, address: i.customerAddress, tin: i.customerTin, total: i.total })),
    quotations: db.quotations.filter((q) => matchesCustomer(key, q.customerEmail, q.customerPhone, q.customerName)).map((q) => ({ quoteNumber: q.quoteNumber, name: q.customerName, email: q.customerEmail, total: q.total })),
    tickets: db.tickets.filter((t) => matchesCustomer(key, t.customerEmail, undefined, t.customerName)).map((t) => ({ subject: t.subject, body: t.body, status: t.status })),
    reviews: db.reviews.filter((r) => matchesCustomer(key, undefined, undefined, r.customerName)).map((r) => ({ source: r.source, rating: r.rating, text: r.text, date: r.date })),
    consents: (db.consents ?? []).filter((c) => matchesCustomer(key, c.email, c.phone, c.customerName)),
  };
}

/** Request to delete a customer's personal data: irreversible, so the owner approves it. */
export function requestDataErasure(db: BizPilotDB, key: string, reason: string, actor: string): ApprovalRequest {
  const found = customerDataExport(db, key);
  const n = found.orders.length + found.invoices.length + found.quotations.length + found.tickets.length + found.reviews.length + found.consents.length;
  if (!n) throw new OpError(`No records found for ${key}.`);
  return requestApproval(db, {
    type: 'data_erasure', title: `Erase personal data of ${key}`,
    description: `${reason}. Removes name, email, phone and address from ${n} record(s). Order and invoice amounts stay for tax records. This cannot be undone.`,
    payload: { customer: key }, risk: 'high',
  }, actor);
}

export function eraseCustomerData(db: BizPilotDB, key: string, actor: string): number {
  let n = 0;
  const label = 'Erased customer';
  for (const o of db.salesOrders) if (matchesCustomer(key, o.customerEmail, o.customerPhone, o.customerName)) { o.customerName = label; o.customerEmail = ''; o.customerPhone = ''; o.shippingAddress = ''; n++; }
  for (const i of db.invoices) if (matchesCustomer(key, i.customerEmail, i.customerPhone, i.customerName) && i.status !== 'paid' && i.einvoice?.status !== 'valid') { i.customerEmail = ''; i.customerPhone = ''; n++; }
  for (const q of db.quotations) if (matchesCustomer(key, q.customerEmail, q.customerPhone, q.customerName)) { q.customerName = label; q.customerEmail = ''; q.customerPhone = ''; q.customerAddress = ''; n++; }
  for (const t of db.tickets) if (matchesCustomer(key, t.customerEmail, undefined, t.customerName)) { t.customerName = label; t.customerEmail = ''; n++; }
  for (const r of db.reviews) if (matchesCustomer(key, undefined, undefined, r.customerName)) { r.customerName = label; n++; }
  for (const c of db.consents ?? []) if (matchesCustomer(key, c.email, c.phone, c.customerName)) { c.customerName = ''; c.email = ''; c.phone = ''; n++; }
  audit(db, actor, 'erase', 'customer', 'personal data', `Personal data erased from ${n} record(s)`);
  return n;
}

// ---------------------------------------------------------------- branch comparison (blueprint §8 D, §9 F)

export interface BranchRow { locationId: string; name: string; orders: number; revenue: number; grossProfit: number; marginPct: number; expenses: number; netProfit: number; stockValue: number; avgOrder: number }

export function branchComparison(db: BizPilotDB, days = 30, now = Date.now()): BranchRow[] {
  const since = new Date(now - days * 86_400_000).toISOString();
  const def = defaultLocation(db)?.id ?? '';
  const locs = db.locations.length ? db.locations : [{ id: '', name: db.settings.name || 'Main' } as Location];
  return locs.map((l) => {
    const orders = db.salesOrders.filter((o) => o.date >= since && o.status !== 'cancelled' && o.paymentStatus !== 'refunded' && (o.locationId || def) === l.id);
    const revenue = orders.reduce((s, o) => s + o.total, 0);
    const cost = orders.reduce((s, o) => s + o.lines.reduce((c, line) => c + (db.products.find((p) => p.id === line.productId)?.unitCost ?? 0) * line.quantity, 0), 0);
    // Costs not tied to a branch (head office, software) are left out of every branch.
    const expenses = db.expenses.filter((e) => e.date >= since && (!db.locations.length || e.locationId === l.id)).reduce((s, e) => s + e.amount, 0);
    const stockValue = db.products.reduce((s, p) => s + stockAt(db, p, l.id || null) * p.unitCost, 0);
    const gp = revenue - cost;
    return {
      locationId: l.id, name: l.name, orders: orders.length, revenue: round2(revenue), grossProfit: round2(gp),
      marginPct: revenue ? Math.round((gp / revenue) * 1000) / 10 : 0, expenses: round2(expenses), netProfit: round2(gp - expenses),
      stockValue: round2(stockValue), avgOrder: orders.length ? round2(revenue / orders.length) : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue);
}
