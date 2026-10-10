import type { SupabaseClient } from '@supabase/supabase-js';
import type { BizPilotDB, BusinessSettings } from './types';
import { defaultSettings, emptyDB, normalizeRecord } from './defaults';

/**
 * Supabase persistence for the whole business workspace (blueprint §15).
 *
 * Used by BOTH the browser (signed-in user, protected by Row Level Security)
 * and the BizPilot server (service role). Each collection in BizPilotDB maps to
 * one table; field names are converted camelCase <-> snake_case automatically.
 */

export type CollectionKey = Exclude<keyof BizPilotDB, 'settings'>;

export const TABLES: Record<CollectionKey, { table: string; order?: string; limit?: number }> = {
  products: { table: 'products', order: 'name' },
  stockMovements: { table: 'stock_movements', order: 'date', limit: 3000 },
  suppliers: { table: 'suppliers', order: 'name' },
  purchaseOrders: { table: 'purchase_orders', order: 'created_at' },
  salesOrders: { table: 'sales_orders', order: 'date', limit: 5000 },
  expenses: { table: 'expenses', order: 'date' },
  invoices: { table: 'invoices', order: 'issued_date' },
  reviews: { table: 'reviews', order: 'date' },
  tickets: { table: 'support_tickets', order: 'created_at' },
  contentItems: { table: 'content_items', order: 'scheduled_date' },
  campaigns: { table: 'campaigns', order: 'name' },
  approvals: { table: 'approval_requests', order: 'created_at' },
  auditLog: { table: 'audit_log', order: 'at', limit: 500 },
  notifications: { table: 'notifications', order: 'at', limit: 200 },
  agentTasks: { table: 'agent_tasks', order: 'created_at', limit: 50 },
};

// Collections displayed newest-first in the UI
const DESC = new Set<CollectionKey>([
  'stockMovements', 'salesOrders', 'expenses', 'invoices', 'reviews', 'tickets',
  'approvals', 'auditLog', 'notifications', 'agentTasks', 'purchaseOrders',
]);

const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function toRow(obj: object, businessId: string): Record<string, unknown> {
  const row: Record<string, unknown> = { business_id: businessId };
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    row[toSnake(k)] = v;
  }
  return row;
}

export function fromRow<T>(collection: CollectionKey, row: Record<string, unknown>): T {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'business_id') continue;
    obj[toCamel(k)] = v;
  }
  return normalizeRecord(collection, obj) as T;
}

export interface BusinessRow {
  id: string;
  owner_id: string;
  name: string;
  mode: BusinessSettings['mode'];
  settings: Partial<BusinessSettings>;
}

export function settingsFromBusiness(b: BusinessRow): BusinessSettings {
  return { ...defaultSettings, ...(b.settings ?? {}), name: b.name, mode: b.mode };
}

/** Load every collection for one business into the in-memory BizPilotDB shape. */
export async function loadSnapshot(client: SupabaseClient, business: BusinessRow): Promise<BizPilotDB> {
  const db = emptyDB();
  db.settings = settingsFromBusiness(business);
  const keys = Object.keys(TABLES) as CollectionKey[];
  const results = await Promise.all(
    keys.map(async (key) => {
      const cfg = TABLES[key];
      let q = client.from(cfg.table).select('*').eq('business_id', business.id);
      if (cfg.order) q = q.order(cfg.order, { ascending: !DESC.has(key), nullsFirst: false });
      if (cfg.limit) q = q.limit(cfg.limit);
      const { data, error } = await q;
      if (error) throw new Error(`Loading ${cfg.table}: ${error.message}`);
      return [key, (data ?? []).map((r) => fromRow(key, r as Record<string, unknown>))] as const;
    }),
  );
  for (const [key, rows] of results) (db as unknown as Record<string, unknown>)[key] = rows;
  return db;
}

export interface DiffResult {
  upserts: Partial<Record<CollectionKey, object[]>>;
  deletes: Partial<Record<CollectionKey, string[]>>;
  settingsChanged: boolean;
}

/** Work out which rows changed between two snapshots. */
export function diffSnapshots(prev: BizPilotDB, next: BizPilotDB): DiffResult {
  const out: DiffResult = { upserts: {}, deletes: {}, settingsChanged: false };
  out.settingsChanged = JSON.stringify(prev.settings) !== JSON.stringify(next.settings);
  for (const key of Object.keys(TABLES) as CollectionKey[]) {
    const before = new Map((prev[key] as { id: string }[]).map((r) => [r.id, JSON.stringify(r)]));
    const after = next[key] as { id: string }[];
    const changed = after.filter((r) => before.get(r.id) !== JSON.stringify(r));
    const afterIds = new Set(after.map((r) => r.id));
    // Capped collections (audit log, movements) only ever grow; rows that fall
    // off the in-memory window must not be deleted from the database.
    const removed = TABLES[key].limit ? [] : [...before.keys()].filter((id) => !afterIds.has(id));
    if (changed.length) out.upserts[key] = changed;
    if (removed.length) out.deletes[key] = removed;
  }
  return out;
}

/** Persist the difference between two snapshots. Throws on the first failure. */
export async function persistDiff(
  client: SupabaseClient,
  businessId: string,
  prev: BizPilotDB,
  next: BizPilotDB,
): Promise<void> {
  const diff = diffSnapshots(prev, next);
  if (diff.settingsChanged) {
    const { name, mode, ...rest } = next.settings;
    const { error } = await client
      .from('businesses')
      .update({ name, mode, settings: rest })
      .eq('id', businessId);
    if (error) throw new Error(`Saving settings: ${error.message}`);
  }
  for (const [key, rows] of Object.entries(diff.upserts) as [CollectionKey, object[]][]) {
    const { error } = await client
      .from(TABLES[key].table)
      .upsert(rows.map((r) => toRow(r, businessId)), { onConflict: 'id' });
    if (error) throw new Error(`Saving ${TABLES[key].table}: ${error.message}`);
  }
  for (const [key, ids] of Object.entries(diff.deletes) as [CollectionKey, string[]][]) {
    const { error } = await client.from(TABLES[key].table).delete().in('id', ids).eq('business_id', businessId);
    if (error) throw new Error(`Deleting from ${TABLES[key].table}: ${error.message}`);
  }
}
