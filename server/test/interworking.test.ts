import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDB } from '../../src/lib/db/defaults.ts';
import * as ops from '../../src/lib/ops.ts';
import { cashPosition } from '../../src/lib/metrics.ts';
import { detectSignals, signalChatId } from '../../src/lib/signals.ts';
import { reactorPrompt } from '../src/lib/reactor.ts';

function shop() {
  const db = emptyDB();
  db.settings.openingCash = 1000;
  db.settings.openingCashDate = new Date().toISOString();
  const p = ops.createProduct(db, { name: 'Paddle', sku: 'PAD', price: 100, unitCost: 60, openingStock: 10 }, 't');
  return { db, p };
}

test('paying an order settles its invoice, and paying the invoice settles the order (money counted once)', () => {
  const { db, p } = shop();
  const o = ops.createSalesOrder(db, { channel: 'online', customerName: 'Ali', paymentStatus: 'pending', lines: [{ productId: p.id, quantity: 2, unitPrice: 100 }] }, 't');
  const inv = ops.createInvoiceFromOrder(db, o.id, {}, 't');
  ops.issueInvoice(db, inv.id, 't');
  const before = cashPosition(db).balance;
  ops.recordOrderPayment(db, o.orderNumber, 't');
  assert.equal(o.paymentStatus, 'paid');
  assert.equal(inv.status, 'paid');
  assert.equal(Math.round(cashPosition(db).balance - before), Math.round(o.total));

  const o2 = ops.createSalesOrder(db, { channel: 'online', customerName: 'Abu', paymentStatus: 'pending', lines: [{ productId: p.id, quantity: 1, unitPrice: 100 }] }, 't');
  const inv2 = ops.createInvoiceFromOrder(db, o2.id, {}, 't');
  ops.issueInvoice(db, inv2.id, 't');
  ops.markInvoicePaid(db, inv2.invoiceNumber, 't');
  assert.equal(o2.paymentStatus, 'paid');
});

test('cancelling an unpaid order releases stock and cancels its invoice; a paid one needs a refund approval', () => {
  const { db, p } = shop();
  const o = ops.createSalesOrder(db, { channel: 'online', customerName: 'Ali', paymentStatus: 'pending', lines: [{ productId: p.id, quantity: 3, unitPrice: 100 }] }, 't');
  const inv = ops.createInvoiceFromOrder(db, o.id, {}, 't');
  assert.equal(p.reserved, 3);
  const r = ops.requestOrderCancel(db, o.id, 'customer changed mind', 't');
  assert.equal(r.approval, null);
  assert.equal(o.status, 'cancelled');
  assert.equal(p.reserved, 0);
  assert.equal(inv.status, 'cancelled');

  const paid = ops.createSalesOrder(db, { channel: 'online', customerName: 'Abu', paymentStatus: 'paid', lines: [{ productId: p.id, quantity: 1, unitPrice: 100 }] }, 't');
  const out = ops.requestOrderCancel(db, paid.id, 'out of stock', 't');
  assert.equal(paid.status, 'awaiting_fulfilment');
  assert.ok(out.approval);
  assert.match(ops.applyApprovedAction(db, out.approval!, 'owner'), /refunded/);
  assert.equal(paid.status, 'cancelled');
  assert.equal(paid.paymentStatus, 'refunded');
});

test('bills, cancelled POs and campaign spend', () => {
  const { db, p } = shop();
  const bill = ops.addExpense(db, { category: 'Rent', description: 'Shop rent', amount: 300, date: new Date().toISOString(), paid: false, dueDate: new Date().toISOString(), recurring: true }, 't');
  const cash = cashPosition(db).balance;
  ops.payExpense(db, bill.id, 't');
  assert.equal(Math.round(cash - cashPosition(db).balance), 300);
  assert.throws(() => ops.payExpense(db, bill.id, 't'), /already paid/);

  const s = ops.createSupplier(db, { name: 'Supplier' }, 't');
  const po = ops.createPurchaseOrder(db, { supplierId: s.id, lines: [{ productId: p.id, quantity: 5, unitCost: 60 }] }, 't');
  const a = ops.requestApproval(db, { type: 'purchase_order', title: po.poNumber, description: '', payload: { purchaseOrderId: po.id } }, 't');
  ops.cancelPurchaseOrder(db, po.id, 't');
  assert.equal(a.status, 'rejected');

  const c = ops.addCampaign(db, { name: 'Launch', budget: 100, dailyCap: 10 }, 't');
  const up = ops.updateCampaign(db, 'Launch', { status: 'active', budget: 200 }, 't');
  assert.equal(c.status, 'draft');
  assert.equal(c.budget, 100);
  ops.applyApprovedAction(db, up.approval!, 'owner');
  assert.equal(c.status, 'active');
  assert.equal(c.budget, 200);
  const down = ops.updateCampaign(db, c.id, { status: 'paused', spend: 50, clicks: 120 }, 't');
  assert.equal(down.approval, null);
  assert.equal(c.status, 'paused');
  assert.equal(c.clicks, 120);
});

test('agent can change brand settings but not automation level', () => {
  const { db } = shop();
  assert.deepEqual(ops.updateBusinessSettings(db, { brandVoice: 'Fun', ...({ automationLevel: 3 } as object) }, 't'), ['brandVoice']);
  assert.equal(db.settings.brandVoice, 'Fun');
  assert.notEqual(db.settings.automationLevel, 3);
});

test('received stock that is not selling becomes a signal the reactor acts on', () => {
  const { db, p } = shop();
  const s = ops.createSupplier(db, { name: 'Supplier' }, 't');
  const po = ops.createPurchaseOrder(db, { supplierId: s.id, lines: [{ productId: p.id, quantity: 5, unitCost: 60 }] }, 't', 'ordered');
  p.incoming += 5;
  ops.receivePurchaseOrder(db, po.id, 'all', 't');
  const sig = detectSignals(db).find((x) => x.key === `sell-${po.id}`);
  assert.ok(sig);
  assert.equal(sig!.auto, true);
  assert.match(signalChatId(sig!.key), /^auto-sell-[\w-]+$/);
  assert.match(reactorPrompt(sig!), /did not ask/);
  assert.ok(detectSignals(db).some((x) => x.key === 'setup-costs'));
});
