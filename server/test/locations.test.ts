import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDB } from '../../src/lib/db/defaults.ts';
import * as ops from '../../src/lib/ops.ts';

function shop() {
  const db = emptyDB();
  db.settings.openingCash = 100000;
  db.settings.openingCashDate = new Date().toISOString();
  const p = ops.createProduct(db, { name: 'Paddle', sku: 'PAD', price: 100, unitCost: 60, openingStock: 30, reorderLevel: 10 }, 't');
  const wh = ops.createLocation(db, { name: 'Warehouse', type: 'warehouse' }, 't');
  const kl = ops.createLocation(db, { name: 'KL shop', type: 'store' }, 't');
  return { db, p, wh, kl };
}

test('first location takes all existing stock; totals always add up', () => {
  const { db, p, wh, kl } = shop();
  assert.equal(wh.isDefault, true);
  assert.equal(ops.stockAt(db, p, wh.id), 30);
  assert.equal(ops.stockAt(db, p, kl.id), 0);
  ops.recordStockMovement(db, p.id, 'in', 5, 'found', 'X', 't', { locationId: kl.id });
  assert.equal(ops.stockAt(db, p, kl.id), 5);
  assert.equal(Object.values(ops.locationBreakdown(db, p)).reduce((a, b) => a + b, 0), p.stock);
});

test('transfer: ship, receive short, lost units written off', () => {
  const { db, p, wh, kl } = shop();
  assert.throws(() => ops.createTransfer(db, { fromLocationId: kl.id, toLocationId: wh.id, lines: [{ productId: p.id, quantity: 1 }] }, 't', true), /Only 0 of Paddle at KL shop/);
  const t = ops.createTransfer(db, { fromLocationId: wh.id, toLocationId: kl.id, lines: [{ productId: p.id, quantity: 12 }] }, 't', true);
  assert.equal(t.status, 'in_transit');
  assert.equal(ops.stockAt(db, p, wh.id), 18);
  assert.equal(p.stock, 30); // still owned while in transit
  ops.receiveTransfer(db, t.id, { [p.id]: 11 }, 't');
  assert.equal(ops.stockAt(db, p, kl.id), 11);
  assert.equal(p.stock, 29);
  assert.ok(db.notifications.some((n) => n.title.includes('Transfer short')));
});

test('a sale at a shop takes stock from that shop first, then elsewhere', () => {
  const { db, p, wh, kl } = shop();
  ops.createTransfer(db, { fromLocationId: wh.id, toLocationId: kl.id, lines: [{ productId: p.id, quantity: 2 }] }, 't', true);
  ops.receiveTransfer(db, db.transfers[0].id, 'all', 't');
  ops.createSalesOrder(db, { channel: 'retail', source: 'pos', locationId: kl.id, lines: [{ productId: p.id, quantity: 3, unitPrice: 100 }], fulfilNow: true }, 'till');
  assert.equal(ops.stockAt(db, p, kl.id), 0);
  assert.equal(ops.stockAt(db, p, wh.id), 27);
});

test('suggests moving stock before buying more', () => {
  const { db, p, kl } = shop();
  const s = ops.transferSuggestions(db);
  assert.equal(s.length, 1);
  assert.equal(s[0].to.id, kl.id);
  assert.equal(s[0].quantity, 10);
  assert.equal(s[0].product.id, p.id);
});

test('stock count: differences need approval and apply as a difference', () => {
  const { db, p, kl, wh } = shop();
  const c = ops.startStockCount(db, { locationId: wh.id, blind: true }, 't');
  ops.recordCount(db, c.id, p.id, 27);
  // a sale happens during the count
  ops.createSalesOrder(db, { channel: 'retail', lines: [{ productId: p.id, quantity: 1, unitPrice: 100 }], fulfilNow: true }, 'till');
  const { approval } = ops.submitStockCount(db, c.id, 't');
  assert.ok(approval);
  assert.equal(approval!.type, 'stock_count');
  ops.applyApprovedAction(db, approval!, 'owner');
  assert.equal(ops.stockAt(db, p, wh.id), 26); // 30 − 1 sold − 3 missing
  assert.equal(ops.stockAt(db, p, kl.id), 0);
  assert.equal(c.status, 'approved');
});

test('no locations: everything works as before', () => {
  const db = emptyDB();
  const p = ops.createProduct(db, { name: 'Net', sku: 'NET', price: 50, unitCost: 20, openingStock: 4 }, 't');
  ops.createSalesOrder(db, { channel: 'retail', lines: [{ productId: p.id, quantity: 1, unitPrice: 50 }], fulfilNow: true }, 'till');
  assert.equal(p.stock, 3);
  assert.equal(p.locationStock, undefined);
  assert.equal(db.stockMovements[0].locationId, undefined);
});
