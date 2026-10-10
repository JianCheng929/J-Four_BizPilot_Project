import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDB } from '../../src/lib/db/defaults.ts';
import * as ops from '../../src/lib/ops.ts';
import { cashPosition, payablesAgeing, receivablesAgeing } from '../../src/lib/metrics.ts';

const DAY = 86_400_000;
const line = { description: 'Website design', quantity: 1, unitPrice: 1000, taxRate: 8 };

test('quotation: send needs approval, accepted quote becomes a draft invoice', () => {
  const db = emptyDB();
  const q = ops.createQuotation(db, { customerName: 'Kedai Ali', lines: [line], validDays: 7, paymentDays: 14 }, 't');
  assert.equal(q.quoteNumber, 'QT-00001');
  assert.equal(q.total, 1080);
  const a = ops.requestQuotationSend(db, q.id, 't');
  assert.throws(() => ops.requestQuotationSend(db, q.id, 't'), /already waiting/);
  assert.match(ops.applyApprovedAction(db, a, 'owner'), /marked as sent/);
  assert.equal(q.status, 'sent');
  const inv = ops.convertQuotationToInvoice(db, q.id, 't');
  assert.equal(q.status, 'converted');
  assert.equal(inv.total, 1080);
  assert.equal(inv.quotationId, q.id);
  assert.equal(Math.round((new Date(inv.dueDate).getTime() - new Date(inv.issuedDate).getTime()) / DAY), 14);
  assert.throws(() => ops.convertQuotationToInvoice(db, q.id, 't'), /already invoiced/);
});

test('payment reminders escalate and are counted after approval', () => {
  const db = emptyDB();
  const inv = ops.createInvoice(db, { customerName: 'Kedai Ali', customerEmail: 'ali@example.com', lines: [line], dueDays: 0 }, 't');
  assert.throws(() => ops.requestPaymentReminder(db, inv.id, 't'), /only unpaid issued/);
  ops.issueInvoice(db, inv.id, 't');
  inv.dueDate = new Date(Date.now() - 10 * DAY).toISOString();
  const a = ops.requestPaymentReminder(db, inv.id, 't');
  assert.match(String(a.payload.body), /10 days overdue/);
  ops.applyApprovedAction(db, a, 'owner', { sentTo: 'ali@example.com' });
  assert.equal(inv.remindersSent, 1);
  assert.match(ops.reminderText(db, inv).body, /second reminder/);
});

test('repeating invoice makes one copy per due period and waits for approval', () => {
  const db = emptyDB();
  const inv = ops.createInvoice(db, { customerName: 'Tenant', lines: [{ description: 'Rent', quantity: 1, unitPrice: 500 }], dueDays: 7 }, 't');
  inv.issuedDate = '2026-01-31T02:00:00.000Z';
  inv.dueDate = '2026-02-07T02:00:00.000Z';
  ops.setInvoiceRecurrence(db, inv.id, 'month', 't');
  assert.equal(inv.recurrence?.nextDate, '2026-02-28'); // month end kept
  assert.equal(ops.runRecurringInvoices(db, 't', '2026-02-27').length, 0);
  const made = ops.runRecurringInvoices(db, 't', '2026-05-01'); // server was asleep for months
  assert.equal(made.length, 1);
  assert.equal(made[0].recurringFrom, inv.id);
  assert.equal(made[0].status, 'draft');
  assert.equal(inv.recurrence?.nextDate, '2026-05-28');
  assert.ok(db.approvals.some((x) => x.type === 'invoice_issue' && x.payload.invoiceId === made[0].id));
  assert.throws(() => ops.setInvoiceRecurrence(db, made[0].id, 'month', 't'), /copy of a repeating invoice/);
  ops.setInvoiceRecurrence(db, inv.id, null, 't');
  assert.equal(ops.runRecurringInvoices(db, 't', '2027-01-01').length, 0);
});

test('ageing buckets and paid standalone invoices count as cash', () => {
  const db = emptyDB();
  const now = Date.parse('2026-10-10T00:00:00Z');
  const mk = (name: string, daysLate: number, amount: number) => {
    const i = ops.createInvoice(db, { customerName: name, lines: [{ description: 'x', quantity: 1, unitPrice: amount }] }, 't');
    ops.issueInvoice(db, i.id, 't');
    i.dueDate = new Date(now - daysLate * DAY).toISOString();
    return i;
  };
  mk('A', -5, 100);
  mk('A', 45, 200);
  mk('B', 120, 50);
  const ar = receivablesAgeing(db, now);
  assert.deepEqual(ar.totals, [100, 0, 200, 0, 50]);
  assert.equal(ar.overdue, 250);
  assert.equal(ar.rows[0].name, 'B');
  db.expenses.push({ id: 'e1', category: 'Rent', description: 'Shop rent', amount: 900, date: '2026-09-01T00:00:00Z', dueDate: '2026-09-05T00:00:00Z', recurring: true, paid: false });
  assert.deepEqual(payablesAgeing(db, now).totals, [0, 0, 900, 0, 0]); // 35 days late
  const before = cashPosition(db).balance;
  ops.markInvoicePaid(db, db.invoices[0].id, 't');
  assert.equal(cashPosition(db).balance, before + db.invoices[0].total);
});
