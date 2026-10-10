import type { BizPilotDB, Product } from './db/types';
import * as ops from './ops';

/**
 * Product catalogue CSV import/export (blueprint §19 Phase 1 and B1).
 * Import checks every row first and changes nothing if any row is invalid.
 */

export const PRODUCT_COLUMNS = [
  'sku', 'name', 'category', 'barcode', 'supplier', 'unit_cost', 'price', 'reorder_level', 'safety_stock',
  'max_stock', 'order_multiple', 'expiry_date', 'weight_kg', 'status', 'description', 'opening_stock',
] as const;

const STATUSES: Product['status'][] = ['active', 'discontinued', 'seasonal', 'draft'];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function productsToCsv(db: BizPilotDB): string {
  const rows = db.products.map((p) => [
    p.sku, p.name, p.category, p.barcode, db.suppliers.find((s) => s.id === p.supplierId)?.name ?? '', p.unitCost, p.price,
    p.reorderLevel, p.safetyStock ?? 0, p.maxStock ?? 0, p.orderMultiple || 1, p.expiryDate ?? '', p.weightKg, p.status, p.description, '',
  ]);
  return [PRODUCT_COLUMNS.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
}

/** RFC 4180 parser: quoted fields, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export interface ImportResult {
  created: number;
  updated: number;
  errors: string[];
}

/** Validate every row; apply only when all rows are valid. Existing SKUs are updated (stock is never changed). */
export function importProductsCsv(db: BizPilotDB, text: string, actor: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { created: 0, updated: 0, errors: ['The file has no product rows.'] };
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (!head.includes('name')) return { created: 0, updated: 0, errors: ['The first row must be the header and include a "name" column. Export first to get the template.'] };
  const get = (r: string[], k: string) => (head.indexOf(k) >= 0 ? (r[head.indexOf(k)] ?? '').trim() : '');
  const errors: string[] = [];
  const seen = new Set<string>();
  const plan: { row: number; existing?: Product; input: ops.ProductInput }[] = [];

  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const name = get(r, 'name');
    const sku = get(r, 'sku');
    if (!name) { errors.push(`Row ${line}: name is required.`); return; }
    const numberOf = (k: string, opts: { int?: boolean; min?: number; dflt?: number } = {}) => {
      const raw = get(r, k).replace(/^RM\s*/i, '').replace(/,/g, '');
      if (raw === '') return opts.dflt;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < (opts.min ?? 0) || (opts.int && !Number.isInteger(n))) {
        errors.push(`Row ${line}: ${k} "${get(r, k)}" is not a valid ${opts.int ? 'whole number' : 'number'}.`);
        return undefined;
      }
      return n;
    };
    const status = (get(r, 'status').toLowerCase() || undefined) as Product['status'] | undefined;
    if (status && !STATUSES.includes(status)) errors.push(`Row ${line}: status must be one of ${STATUSES.join(', ')}.`);
    const expiry = get(r, 'expiry_date');
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) errors.push(`Row ${line}: expiry_date must look like 2026-12-31.`);
    const supplierName = get(r, 'supplier');
    const supplier = supplierName ? ops.findSupplier(db, supplierName) : undefined;
    if (supplierName && !supplier) errors.push(`Row ${line}: supplier "${supplierName}" not found. Add the supplier first.`);
    const key = (sku || name).toLowerCase();
    if (seen.has(key)) errors.push(`Row ${line}: duplicate SKU/name "${sku || name}" in the file.`);
    seen.add(key);
    const existing = sku ? db.products.find((p) => p.sku.toLowerCase() === sku.toLowerCase()) : undefined;
    const input: ops.ProductInput = {
      name,
      sku: sku || undefined,
      category: get(r, 'category') || undefined,
      barcode: get(r, 'barcode') || undefined,
      description: head.includes('description') ? get(r, 'description') : undefined,
      supplierId: supplier ? supplier.id : undefined,
      unitCost: numberOf('unit_cost'),
      price: numberOf('price'),
      reorderLevel: numberOf('reorder_level', { int: true }),
      safetyStock: numberOf('safety_stock', { int: true }),
      maxStock: numberOf('max_stock', { int: true }),
      orderMultiple: numberOf('order_multiple', { int: true, min: 1 }),
      expiryDate: head.includes('expiry_date') ? expiry : undefined,
      weightKg: numberOf('weight_kg'),
      status,
      openingStock: numberOf('opening_stock', { int: true }),
    };
    if (existing && input.openingStock) errors.push(`Row ${line}: ${sku} already exists, so opening_stock is ignored. Leave it empty or use Stock in.`);
    plan.push({ row: line, existing, input });
  });

  if (errors.length) return { created: 0, updated: 0, errors };
  let created = 0;
  let updated = 0;
  for (const { existing, input } of plan) {
    if (existing) {
      const patch = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== 'openingStock' && k !== 'sku'));
      ops.updateProduct(db, existing.id, patch as Partial<Product>, actor);
      updated++;
    } else {
      ops.createProduct(db, input, actor);
      created++;
    }
  }
  ops.audit(db, actor, 'import', 'product', 'CSV', `Catalogue import: ${created} added, ${updated} updated`);
  return { created, updated, errors: [] };
}
