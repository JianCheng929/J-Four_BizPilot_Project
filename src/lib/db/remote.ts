import type { SupabaseClient } from '@supabase/supabase-js';
import type { BizPilotDB, BusinessSettings, TeamRole } from './types';
import { defaultSettings, emptyDB, normalizeRecord } from './defaults';

/**
 * Supabase persistence for the whole business workspace (blueprint §15).
 *
 * Used by BOTH the browser (signed-in user, protected by Row Level Security)
 * and the BizPilot server (service role). Each collection in BizPilotDB maps to
 * one table; field names are converted camelCase <-> snake_case automatically.
 */

export type CollectionKey = Exclude<keyof BizPilotDB, 'settings'>;

/** optional: the table comes from a later SQL file; until it is run the collection loads empty. */
export const TABLES: Record<CollectionKey, { table: string; order?: string; limit?: number; optional?: boolean }> = {
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
  returns: { table: 'return_cases', order: 'created_at' },
  locations: { table: 'locations', order: 'created_at', optional: true },
  transfers: { table: 'stock_transfers', order: 'created_at', optional: true },
  stockCounts: { table: 'stock_counts', order: 'created_at', optional: true },
  productionOrders: { table: 'production_orders', order: 'created_at', optional: true },
  quotations: { table: 'quotations', order: 'issued_date', optional: true },
  staffTasks: { table: 'staff_tasks', order: 'created_at', limit: 500, optional: true },
  consents: { table: 'consents', order: 'at', limit: 5000, optional: true },
  approvals: { table: 'approval_requests', order: 'created_at' },
  auditLog: { table: 'audit_log', order: 'at', limit: 500 },
  notifications: { table: 'notifications', order: 'at', limit: 200 },
  agentTasks: { table: 'agent_tasks', order: 'created_at', limit: 50 },
};

/** Optional tables whose SQL has not been run yet: changes to them are skipped instead of failing the whole save. */
const missingTables = new Set<string>();

// Collections displayed newest-first in the UI
const DESC = new Set<CollectionKey>([
  'stockMovements', 'salesOrders', 'expenses', 'invoices', 'reviews', 'tickets',
  'approvals', 'auditLog', 'notifications', 'agentTasks', 'purchaseOrders', 'returns', 'transfers', 'stockCounts', 'productionOrders', 'quotations', 'staffTasks', 'consents',
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
    if (k === 'business_id' || k === 'row_version') continue;
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
  row_version?: number;
  /** Set by the app when loading: the signed-in user's role. Never saved. */
  role?: TeamRole;
}

/**
 * Last saved row_version of every loaded record, keyed "table:id" ("businesses:<id>" for settings).
 * Saves send these so the database can refuse to overwrite a newer change.
 */
export type Versions = Map<string, number>;
export const versionKey = (table: string, id: string) => `${table}:${id}`;

/** Someone else saved a newer version of a record this save touches. Reload and redo the change. */
export class ConflictError extends Error {
  constructor(message = 'Another change was saved at the same time.') {
    super(message);
    this.name = 'ConflictError';
  }
}

export function settingsFromBusiness(b: BusinessRow): BusinessSettings {
  return { ...defaultSettings, ...(b.settings ?? {}), name: b.name, mode: b.mode };
}

/**
 * Load every collection for one business into the in-memory BizPilotDB shape.
 * The business row is re-read too, so settings changed elsewhere show up.
 * Pass `versions` to receive each record's row_version.
 */
export async function loadSnapshot(client: SupabaseClient, business: BusinessRow, versions?: Versions): Promise<BizPilotDB> {
  const db = emptyDB();
  const { data: fresh, error: bErr } = await client.from('businesses').select('*').eq('id', business.id).maybeSingle();
  if (bErr) throw new Error(`Loading business: ${bErr.message}`);
  const b = (fresh as BusinessRow | null) ?? business;
  db.settings = settingsFromBusiness(b);
  if (versions && typeof b.row_version === 'number') versions.set(versionKey('businesses', business.id), b.row_version);
  const keys = Object.keys(TABLES) as CollectionKey[];
  const results = await Promise.all(
    keys.map(async (key) => {
      const cfg = TABLES[key];
      let q = client.from(cfg.table).select('*').eq('business_id', business.id);
      if (cfg.order) q = q.order(cfg.order, { ascending: !DESC.has(key), nullsFirst: false });
      if (cfg.limit) q = q.limit(cfg.limit);
      const { data, error } = await q;
      if (error) {
        if (cfg.optional && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message))) {
          missingTables.add(cfg.table);
          return [key, []] as const;
        }
        throw new Error(`Loading ${cfg.table}: ${error.message}`);
      }
      missingTables.delete(cfg.table);
      if (versions) {
        for (const r of (data ?? []) as Record<string, unknown>[]) {
          if (typeof r.row_version === 'number') versions.set(versionKey(cfg.table, String(r.id)), r.row_version);
        }
      }
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
    if (missingTables.has(TABLES[key].table)) continue;
    const { error } = await client
      .from(TABLES[key].table)
      .upsert(rows.map((r) => toRow(r, businessId)), { onConflict: 'id' });
    if (error) throw new Error(`Saving ${TABLES[key].table}: ${error.message}`);
  }
  for (const [key, ids] of Object.entries(diff.deletes) as [CollectionKey, string[]][]) {
    if (missingTables.has(TABLES[key].table)) continue;
    const { error } = await client.from(TABLES[key].table).delete().in('id', ids).eq('business_id', businessId);
    if (error) throw new Error(`Deleting from ${TABLES[key].table}: ${error.message}`);
  }
}

interface Change {
  table: string;
  op: 'upsert' | 'delete' | 'settings';
  id: string;
  version: number | null;
  row?: Record<string, unknown>;
}

let legacyWarned = false;


/**
 * Save the difference between two snapshots in ONE database transaction
 * (supabase/industrial.sql → bizpilot_commit). Each changed record is saved only
 * if nobody saved a newer version since it was loaded; otherwise nothing is saved
 * and ConflictError is thrown so the caller can reload and redo the change.
 * Falls back to the older row-by-row save if the function isn't installed yet.
 */
export async function commitDiff(
  client: SupabaseClient,
  businessId: string,
  prev: BizPilotDB,
  next: BizPilotDB,
  versions: Versions,
): Promise<void> {
  const diff = diffSnapshots(prev, next);
  const changes: Change[] = [];
  if (diff.settingsChanged) {
    const { name, mode, ...rest } = next.settings;
    changes.push({ table: 'businesses', op: 'settings', id: businessId, version: versions.get(versionKey('businesses', businessId)) ?? null, row: { name, mode, settings: rest } });
  }
  for (const [key, rows] of Object.entries(diff.upserts) as [CollectionKey, { id: string }[]][]) {
    const table = TABLES[key].table;
    if (missingTables.has(table)) continue;
    for (const r of rows) {
      changes.push({ table, op: 'upsert', id: r.id, version: versions.get(versionKey(table, r.id)) ?? null, row: toRow(r, businessId) });
    }
  }
  for (const [key, ids] of Object.entries(diff.deletes) as [CollectionKey, string[]][]) {
    const table = TABLES[key].table;
    if (missingTables.has(table)) continue;
    for (const id of ids) changes.push({ table, op: 'delete', id, version: versions.get(versionKey(table, id)) ?? null });
  }
  if (!changes.length) return;

  const { data, error } = await client.rpc('bizpilot_commit', { p_business: businessId, p_changes: changes });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      if (!legacyWarned) {
        legacyWarned = true;
        console.warn('bizpilot_commit is not installed: run supabase/industrial.sql. Saving row by row without conflict checks.');
      }
      return persistDiff(client, businessId, prev, next);
    }
    if (error.code === '40001' || error.code === '23505' || /bizpilot_conflict/.test(error.message)) {
      throw new ConflictError(error.message.replace(/^bizpilot_conflict:\s*/, ''));
    }
    throw new Error(`Not saved: ${error.message}`);
  }
  for (const v of (data ?? []) as { table: string; id: string; version: number | null }[]) {
    const k = versionKey(v.table, v.id);
    if (v.version === null) versions.delete(k);
    else versions.set(k, v.version);
  }
}
