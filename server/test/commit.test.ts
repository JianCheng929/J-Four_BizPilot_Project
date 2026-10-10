import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitDiff, ConflictError, loadSnapshot, type BusinessRow, type Versions } from '../../src/lib/db/remote.ts';
import * as ops from '../../src/lib/ops.ts';
import type { BizPilotDB } from '../../src/lib/db/types.ts';

/**
 * In-memory stand-in for Supabase that behaves like supabase/industrial.sql:
 * bizpilot_commit applies all changes or none, and refuses stale row versions.
 */
function fakeSupabase() {
  const tables = new Map<string, Map<string, Record<string, any>>>();
  const t = (name: string) => tables.get(name) ?? tables.set(name, new Map()).get(name)!;
  const business = { id: 'b1', owner_id: 'u1', name: 'Shop', mode: 'retail', settings: {}, row_version: 0 };
  t('businesses').set('b1', business);

  const query = (table: string) => {
    let rows = () => [...t(table).values()].map((r) => structuredClone(r));
    const q: any = {
      select: () => q,
      eq: (col: string, val: unknown) => { const prev = rows; rows = () => prev().filter((r) => r[col] === val); return q; },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
    };
    return q;
  };

  const rpc = async (_fn: string, { p_changes }: { p_business: string; p_changes: any[] }) => {
    const staged = new Map([...tables].map(([k, v]) => [k, new Map([...v].map(([id, r]) => [id, structuredClone(r)]))]));
    const out: unknown[] = [];
    for (const c of p_changes) {
      const tbl = staged.get(c.table) ?? staged.set(c.table, new Map()).get(c.table)!;
      if (c.op === 'settings') {
        const b = tbl.get('b1')!;
        if (c.version !== null && b.row_version !== c.version) return { data: null, error: { code: '40001', message: 'bizpilot_conflict: settings' } };
        Object.assign(b, c.row, { row_version: b.row_version + 1 });
        out.push({ table: 'businesses', id: 'b1', version: b.row_version });
        continue;
      }
      const cur = tbl.get(c.id);
      if (c.op === 'delete') {
        if (c.version !== null && cur?.row_version !== c.version) return { data: null, error: { code: '40001', message: 'bizpilot_conflict' } };
        tbl.delete(c.id);
        out.push({ table: c.table, id: c.id, version: null });
      } else if (c.version === null) {
        if (cur) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        tbl.set(c.id, { ...c.row, row_version: 0 });
        out.push({ table: c.table, id: c.id, version: 0 });
      } else {
        if (!cur || cur.row_version !== c.version) return { data: null, error: { code: '40001', message: 'bizpilot_conflict' } };
        if (c.table === 'products' && c.row.stock < 0) return { data: null, error: { code: '23514', message: 'products_stock_not_negative' } };
        tbl.set(c.id, { ...c.row, row_version: cur.row_version + 1 });
        out.push({ table: c.table, id: c.id, version: cur.row_version + 1 });
      }
    }
    tables.clear();
    for (const [k, v] of staged) tables.set(k, v);
    return { data: out, error: null };
  };
  return { client: { from: query, rpc } as any, tables, business: business as unknown as BusinessRow };
}

/** Same loop as server/src/lib/workspace.ts withBusiness and the web app's commit. */
async function save(client: any, business: BusinessRow, fn: (db: BizPilotDB) => void, before?: { db: BizPilotDB; versions: Versions }) {
  for (let attempt = 1; ; attempt++) {
    const versions: Versions = before?.versions ?? new Map();
    const snap = before?.db ?? (await loadSnapshot(client, business, versions));
    before = undefined;
    const draft = structuredClone(snap);
    fn(draft);
    try {
      await commitDiff(client, business.id, snap, draft, versions);
      return;
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= 4) throw e;
    }
  }
}

test('two tills selling the last unit at the same time never oversell', async () => {
  const { client, tables, business } = fakeSupabase();
  await save(client, business, (db) => { ops.createProduct(db, { name: 'Pickleball paddle', sku: 'PAD', price: 120, unitCost: 60, openingStock: 1 }, 'test'); });
  const product = [...tables.get('products')!.values()][0];

  // Both tills load the same snapshot (1 in stock) before either saves.
  const vA: Versions = new Map(); const snapA = await loadSnapshot(client, business, vA);
  const vB: Versions = new Map(); const snapB = await loadSnapshot(client, business, vB);
  const sell = (db: BizPilotDB) => { ops.createSalesOrder(db, { channel: 'retail', source: 'pos', lines: [{ productId: product.id, quantity: 1, unitPrice: 120 }], paymentStatus: 'paid', fulfilNow: true }, 'till'); };

  await save(client, business, sell, { db: snapA, versions: vA });
  await assert.rejects(save(client, business, sell, { db: snapB, versions: vB }), /Not enough/);

  assert.equal([...tables.get('products')!.values()][0].stock, 0);
  assert.equal(tables.get('sales_orders')!.size, 1);
});

test('a stale save is redone on fresh data instead of overwriting', async () => {
  const { client, tables, business } = fakeSupabase();
  await save(client, business, (db) => { ops.createProduct(db, { name: 'Ball', sku: 'BALL', price: 10, unitCost: 4, openingStock: 50 }, 'test'); });
  const id = [...tables.get('products')!.values()][0].id;
  const vA: Versions = new Map(); const snapA = await loadSnapshot(client, business, vA);
  // Someone else receives 20 units first.
  await save(client, business, (db) => { ops.recordStockMovement(db, id, 'in', 20, 'PO', 'PO-1', 'other'); });
  // This writer still holds the old snapshot (50) and sells 5.
  await save(client, business, (db) => { ops.recordStockMovement(db, id, 'out', 5, 'sale', 'S-1', 'me'); }, { db: snapA, versions: vA });
  assert.equal([...tables.get('products')!.values()][0].stock, 65); // 50 + 20 − 5, not 45
});

test('a failed save changes nothing (all or nothing)', async () => {
  const { client, tables, business } = fakeSupabase();
  await save(client, business, (db) => { ops.createProduct(db, { name: 'Net', sku: 'NET', price: 80, unitCost: 30, openingStock: 3 }, 'test'); });
  const before = JSON.stringify([...tables.get('products')!.values()]);
  const auditBefore = tables.get('audit_log')?.size ?? 0;
  const vA: Versions = new Map(); const snap = await loadSnapshot(client, business, vA);
  const draft = structuredClone(snap);
  draft.products[0].stock = -5; // database check constraint rejects this
  ops.audit(draft, 'x', 'bad', 'product', draft.products[0].id, 'should not land');
  await assert.rejects(commitDiff(client, business.id, snap, draft, vA), /Not saved/);
  assert.equal(JSON.stringify([...tables.get('products')!.values()]), before);
  assert.equal(tables.get('audit_log')?.size ?? 0, auditBefore);
});
