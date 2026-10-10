import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDB } from '../../src/lib/db/defaults.ts';
import * as ops from '../../src/lib/ops.ts';

function bakery() {
  const db = emptyDB();
  db.settings.openingCash = 100000;
  db.settings.openingCashDate = new Date().toISOString();
  const sup = ops.createSupplier(db, { name: 'Flour Mill', minOrderQty: 10, leadTimeDays: 3 }, 't');
  const flour = ops.createProduct(db, { name: 'Flour (kg)', sku: 'FLR', price: 0, unitCost: 4, openingStock: 5, supplierId: sup.id }, 't');
  const box = ops.createProduct(db, { name: 'Cake box', sku: 'BOX', price: 0, unitCost: 1, openingStock: 50 }, 't');
  const cake = ops.createProduct(db, { name: 'Cake', sku: 'CAKE', price: 30, unitCost: 0, openingStock: 0, reorderLevel: 5 }, 't');
  ops.setBom(db, cake.id, { lines: [{ productId: flour.id, quantity: 0.5 }, { productId: box.id, quantity: 1 }], labourCost: 2, overheadCost: 1 }, 't');
  return { db, sup, flour, box, cake };
}

test('recipe cost and the shortage check', () => {
  const { db, cake, flour } = bakery();
  assert.equal(ops.plannedUnitCost(db, cake), 6); // 0.5×4 + 1×1 + 2 + 1
  assert.equal(ops.maxProducible(db, cake), 10); // 5 kg flour / 0.5
  const needs = ops.materialRequirements(db, cake.id, 20);
  assert.deepEqual(needs.map((n) => [n.product.id, n.required, n.shortage]), [[flour.id, 10, 5], [needs[1].product.id, 20, 0]]);
  assert.throws(() => ops.setBom(db, flour.id, { lines: [{ productId: cake.id, quantity: 1 }] }, 't'), /made from Flour/);
});

test('production waits for approval, refuses to start when short, and drafts material POs', () => {
  const { db, cake, flour } = bakery();
  const { order, approval } = ops.createProductionOrder(db, { productId: cake.id, quantity: 20 }, 't');
  assert.equal(order.status, 'pending_approval');
  assert.throws(() => ops.startProduction(db, order.id, 't'), /waiting for approval/);
  ops.applyApprovedAction(db, approval, 'owner');
  assert.equal(order.status, 'approved');
  assert.throws(() => ops.startProduction(db, order.id, 't'), /Flour \(kg\) needs 10, 5 available/);
  const { purchaseOrders } = ops.draftMaterialPurchases(db, order.id, 't');
  assert.equal(purchaseOrders.length, 1);
  assert.equal(purchaseOrders[0].lines[0].quantity, 10); // short 5, raised to supplier MOQ 10
  assert.ok(db.approvals.some((a) => a.type === 'purchase_order' && a.payload.purchaseOrderId === purchaseOrders[0].id));
  // a second order can't count the same flour
  assert.equal(ops.maxProducible(db, cake), 0);
  assert.equal(flour.stock, 5);
});

test('start takes materials, completion adds good units at actual cost, cancel returns materials', () => {
  const { db, cake, flour, box } = bakery();
  const { order, approval } = ops.createProductionOrder(db, { productId: cake.id, quantity: 10 }, 't');
  ops.applyApprovedAction(db, approval, 'owner');
  ops.startProduction(db, order.id, 't');
  assert.equal(flour.stock, 0);
  assert.equal(box.stock, 40);
  assert.equal(ops.plannedOutput(db, cake.id), 10);
  ops.completeProduction(db, order.id, { goodQty: 8, rejectedQty: 2, qcNotes: 'burnt' }, 't');
  assert.equal(cake.stock, 8);
  assert.equal(order.actualUnitCost, 7.5); // RM60 total / 8 good
  assert.equal(cake.unitCost, 7.5);
  assert.ok(db.notifications.some((n) => n.title.includes('Production cost over plan')));
  assert.equal(ops.plannedOutput(db, cake.id), 0);

  const second = ops.createProductionOrder(db, { productId: cake.id, quantity: 5 }, 't');
  ops.recordStockMovement(db, flour.id, 'in', 10, 'bought', 'X', 't');
  ops.applyApprovedAction(db, second.approval, 'owner');
  ops.startProduction(db, second.order.id, 't');
  assert.equal(flour.stock, 7); // ceil(5 × 0.5 = 2.5) = 3 kg taken
  ops.cancelProduction(db, second.order.id, 't');
  assert.equal(flour.stock, 10);
  assert.equal(second.order.status, 'cancelled');
});

test('made products are replenished by production, not purchase orders', () => {
  const { db, cake } = bakery();
  const s = ops.reorderSuggestions(db).find((x) => x.product.id === cake.id);
  assert.ok(s?.make);
  assert.equal(s?.supplier, undefined);
  ops.createProductionOrder(db, { productId: cake.id, quantity: 40 }, 't');
  assert.equal(ops.reorderSuggestions(db).some((x) => x.product.id === cake.id), false);
});
