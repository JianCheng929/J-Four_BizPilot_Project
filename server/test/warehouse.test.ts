import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDB } from '../../src/lib/db/defaults.ts';
import * as ops from '../../src/lib/ops.ts';
import { budgetVsActual } from '../../src/lib/metrics.ts';
import { detectSignals } from '../../src/lib/signals.ts';

function shop() {
  const db = emptyDB();
  const a = ops.createProduct(db, { name: 'Paddle', sku: 'PAD', price: 100, unitCost: 60, openingStock: 30, reorderLevel: 5 }, 't');
  const b = ops.createProduct(db, { name: 'Ball', sku: 'BAL', price: 10, unitCost: 4, openingStock: 100, reorderLevel: 5 }, 't');
  return { db, a, b };
}

test('pick list groups by product and sorts by bin; packing closes the pick task', () => {
  const { db, a, b } = shop();
  ops.setBin(db, a.id, null, 'b-02', 't');
  ops.setBin(db, b.id, null, 'A-01', 't');
  const o1 = ops.createSalesOrder(db, { channel: 'online', lines: [{ productId: a.id, quantity: 1, unitPrice: 100 }, { productId: b.id, quantity: 3, unitPrice: 10 }] }, 't');
  const o2 = ops.createSalesOrder(db, { channel: 'online', lines: [{ productId: a.id, quantity: 2, unitPrice: 100 }] }, 't');
  const list = ops.pickList(db);
  assert.deepEqual(list.lines.map((l) => [l.bin, l.product.sku, l.quantity]), [['A-01', 'BAL', 3], ['B-02', 'PAD', 3]]);
  assert.ok(detectSignals(db).some((s) => s.key.startsWith('pick-')));
  const { task, orders } = ops.startPickRun(db, undefined, 't', 'Staff@Shop.my');
  assert.equal(orders.length, 2);
  assert.equal(task.kind, 'pick');
  assert.equal(task.assignee, 'staff@shop.my');
  assert.ok(!detectSignals(db).some((s) => s.key.startsWith('pick-')));
  assert.throws(() => ops.startPickRun(db, undefined, 't'), /No orders are waiting/);
  ops.markPacked(db, o1.id, 't');
  assert.equal(task.status, 'open'); // o2 still to do
  ops.markPacked(db, o2.orderNumber, 't');
  assert.equal(task.status, 'done');
  assert.equal(ops.findByCode(db, 'pad')?.id, a.id);
});

test('cancelling an order drops it from its open task', () => {
  const { db, a } = shop();
  const o1 = ops.createSalesOrder(db, { channel: 'online', lines: [{ productId: a.id, quantity: 1, unitPrice: 100 }] }, 't');
  const { task } = ops.startPickRun(db, [o1.id], 't');
  ops.cancelSalesOrder(db, o1.id, 't');
  assert.equal(task.status, 'cancelled');
  assert.equal(o1.pickStatus, null);
});

test('budget vs actual projects variable spend, counts repeating costs once', () => {
  const { db } = shop();
  ops.setBudget(db, 'Marketing', 1000, 't');
  ops.setBudget(db, 'Rent', 2000, 't');
  ops.addExpense(db, { category: 'Marketing', description: 'ads', amount: 300, date: '2026-04-10', recurring: false, paid: true }, 't');
  ops.addExpense(db, { category: 'Rent', description: 'rent', amount: 2000, date: '2026-04-01', recurring: true, paid: true }, 't');
  const r = budgetVsActual(db, '2026-04', Date.parse('2026-04-10T12:00:00Z'));
  const mk = r.rows.find((x) => x.category === 'Marketing')!;
  assert.equal(mk.pct, 30);
  assert.equal(mk.projected, 900);
  assert.equal(r.rows.find((x) => x.category === 'Rent')!.projected, 2000);
  ops.setBudget(db, 'Rent', 0, 't');
  assert.equal(db.settings.budgets?.Rent, undefined);
});

test('branch comparison splits sales and branch costs by location', () => {
  const { db, a } = shop();
  const wh = ops.createLocation(db, { name: 'Warehouse', type: 'warehouse' }, 't');
  const kl = ops.createLocation(db, { name: 'KL shop', type: 'store' }, 't');
  ops.createTransfer(db, { fromLocationId: wh.id, toLocationId: kl.id, lines: [{ productId: a.id, quantity: 5 }] }, "t", true);
  ops.createSalesOrder(db, { channel: 'retail', lines: [{ productId: a.id, quantity: 2, unitPrice: 100 }], fulfilNow: true }, 't');
  ops.createSalesOrder(db, { channel: 'retail', lines: [{ productId: a.id, quantity: 1, unitPrice: 100 }], locationId: kl.id }, 't');
  ops.addExpense(db, { category: 'Rent', description: 'KL rent', amount: 50, date: new Date().toISOString(), recurring: false, paid: true, locationId: kl.id }, 't');
  ops.addExpense(db, { category: 'Software', description: 'HQ', amount: 999, date: new Date().toISOString(), recurring: false, paid: true }, 't');
  const rows = ops.branchComparison(db);
  const w = rows.find((r) => r.locationId === wh.id)!;
  const k = rows.find((r) => r.locationId === kl.id)!;
  assert.equal(w.revenue, 200);
  assert.equal(w.expenses, 0);
  assert.equal(k.revenue, 100);
  assert.equal(k.netProfit, 100 - 60 - 50);
});

test('PDPA: marketing needs granted consent; withdrawal wins; erasure needs approval and keeps amounts', () => {
  const { db, a } = shop();
  ops.createSalesOrder(db, { channel: 'online', customerName: 'Ali', customerEmail: 'ali@x.my', customerPhone: '012-345 6789', shippingAddress: 'Jalan 1', lines: [{ productId: a.id, quantity: 1, unitPrice: 100 }] }, 't');
  assert.throws(() => ops.assertMarketingConsent(db, 'ali@x.my', 'email'), /not given consent/);
  ops.recordConsent(db, { email: 'ALI@x.my', purpose: 'marketing', status: 'granted', source: 'checkout tick box' }, 't');
  ops.assertMarketingConsent(db, 'ali@x.my', 'email');
  const later = ops.recordConsent(db, { email: 'ali@x.my', purpose: 'marketing', status: 'withdrawn', source: 'replied STOP' }, 't');
  later.at = new Date(Date.now() + 1000).toISOString();
  assert.throws(() => ops.assertMarketingConsent(db, 'ali@x.my', 'email'), /withdrawn/);
  const exp = ops.customerDataExport(db, 'ali@x.my');
  assert.equal(exp.orders.length, 1);
  assert.equal(exp.consents.length, 2);
  const req = ops.requestDataErasure(db, 'ali@x.my', 'Customer asked', 't');
  assert.equal(req.type, 'data_erasure');
  assert.equal(db.salesOrders[0].customerEmail, 'ali@x.my'); // nothing erased before approval
  ops.applyApprovedAction(db, req, 'owner');
  assert.equal(db.salesOrders[0].customerEmail, '');
  assert.equal(db.salesOrders[0].total, 100);
  assert.ok(db.consents.every((c) => c.customerKey === 'ali@x.my' && c.email === ''));
  assert.throws(() => ops.assertMarketingConsent(db, 'ali@x.my', 'email'), /withdrawn/);
});

test('a cleared "BizPilot noticed" item stays hidden', () => {
  const { db, a } = shop();
  ops.createSalesOrder(db, { channel: 'online', lines: [{ productId: a.id, quantity: 1, unitPrice: 100 }] }, 't');
  const sig = detectSignals(db).find((s) => s.key.startsWith('pick-'));
  assert.ok(sig);
  ops.dismissSignal(db, sig.key, 't');
  assert.ok(!detectSignals(db).some((s) => s.key === sig.key));
});
