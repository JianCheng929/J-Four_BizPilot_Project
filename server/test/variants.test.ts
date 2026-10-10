import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDB } from '../../src/lib/db/defaults.ts';
import * as ops from '../../src/lib/ops.ts';

test('variants: one product per combination, main product becomes the heading', () => {
  const db = emptyDB();
  const tee = ops.createProduct(db, { name: 'Tee', sku: 'TEE', price: 39, unitCost: 15, reorderLevel: 5 }, 't');
  const made = ops.createVariants(db, tee.id, [{ name: 'Size', values: ['S', 'M', ' M '] }, { name: 'Colour', values: ['Red', 'Navy blue'] }], 't', { 'M / Red': { price: 45, openingStock: 7 } });
  assert.equal(made.length, 4);
  assert.deepEqual(made.map((v) => v.sku), ['TEE-S-RED', 'TEE-S-NAVYBL', 'TEE-M-RED', 'TEE-M-NAVYBL']);
  const mRed = made[2];
  assert.equal(mRed.name, 'Tee - M / Red');
  assert.equal(mRed.price, 45);
  assert.equal(mRed.stock, 7);
  assert.equal(mRed.reorderLevel, 5);
  assert.equal(tee.status, 'draft');
  assert.equal(ops.variantsOf(db, tee.id).length, 4);
  // adding a new size only creates the missing ones
  assert.equal(ops.createVariants(db, tee.id, [{ name: 'Size', values: ['S', 'M', 'L'] }, { name: 'Colour', values: ['Red', 'Navy blue'] }], 't').length, 2);
  assert.throws(() => ops.createVariants(db, mRed.id, [{ name: 'Fit', values: ['Slim'] }], 't'), /itself a variant/);
});

test('batches: received with expiry, sold earliest-expiry first, expiry date follows', () => {
  const db = emptyDB();
  const milk = ops.createProduct(db, { name: 'Milk', sku: 'MLK', price: 8, unitCost: 5, openingStock: 4, expiryDate: '2026-11-01' }, 't');
  ops.setTrackBatches(db, milk.id, true, 't');
  assert.deepEqual(milk.batches?.map((b) => [b.batch, b.qty, b.expiry]), [['OPENING', 4, '2026-11-01']]);
  ops.recordStockMovement(db, milk.id, 'in', 10, 'Received', 'PO', 't', { batch: 'L2', expiry: '2026-10-20' });
  assert.equal(milk.expiryDate, '2026-10-20');
  const mv = ops.recordStockMovement(db, milk.id, 'out', 12, 'Sold', 'SO', 't');
  assert.equal(mv.batch, 'L2×10, OPENING×2');
  assert.equal(milk.expiryDate, '2026-11-01');
  assert.equal(milk.stock, 2);
  assert.throws(() => ops.recordStockMovement(db, milk.id, 'out', 1, 'x', 'x', 't', { batch: 'L2' }), /No stock in batch L2/);
  assert.equal(ops.expiringBatches(db, 10_000).length, 1);
});

test('PO receipt and production put stock in named batches', () => {
  const db = emptyDB();
  db.settings.openingCash = 1000;
  db.settings.openingCashDate = new Date().toISOString();
  const s = ops.createSupplier(db, { name: 'Dairy' }, 't');
  const milk = ops.createProduct(db, { name: 'Milk', sku: 'MLK', price: 8, unitCost: 5, supplierId: s.id, trackBatches: true }, 't');
  const po = ops.createPurchaseOrder(db, { supplierId: s.id, lines: [{ productId: milk.id, quantity: 6, unitCost: 5 }] }, 't', 'approved');
  ops.placePurchaseOrder(db, po.id, 't');
  ops.receivePurchaseOrder(db, po.id, 'all', 't', { [milk.id]: { batch: 'D-77', expiry: '2026-12-01' } });
  assert.deepEqual(milk.batches?.map((b) => [b.batch, b.qty]), [['D-77', 6]]);
  assert.equal(milk.expiryDate, '2026-12-01');
});
