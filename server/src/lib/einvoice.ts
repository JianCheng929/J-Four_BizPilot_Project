import * as ops from '../../../src/lib/ops.ts';
import { cancelDocument, missingSupplierFields, refreshInvoice, validateTin } from '../providers/myinvois.ts';
import { contextFor, HttpError } from './http.ts';
import { readSnapshot, withBusiness } from './workspace.ts';

export async function requestEinvoiceSubmit(businessId: string, invoiceId: string, actor: string) {
  return withBusiness(businessId, (db) => {
    const inv = db.invoices.find((i) => i.id === invoiceId || i.invoiceNumber === invoiceId);
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (['submitted', 'valid'].includes(inv.einvoice.status)) throw new HttpError(400, `${inv.invoiceNumber} is already ${inv.einvoice.status} on MyInvois.`);
    if (inv.status === 'cancelled') throw new HttpError(400, `${inv.invoiceNumber} is cancelled.`);
    const missing = missingSupplierFields(db.settings);
    if (missing.length) throw new HttpError(400, `Fill in Settings → Business profile first: ${missing.join(', ')}.`);
    const pending = db.approvals.find((a) => a.status === 'pending' && a.type === 'einvoice_submit' && (a.payload as any).invoiceId === inv.id);
    if (pending) return { approvalId: pending.id };
    const req = ops.requestApproval(db, {
      type: 'einvoice_submit',
      title: `Submit ${inv.invoiceNumber} to LHDN MyInvois`,
      description: `${inv.customerName} · RM${inv.total.toFixed(2)} · buyer TIN ${inv.customerTin || 'EI00000000010 (general public)'}. Once validated it can only be cancelled within 72 hours.`,
      payload: { invoiceId: inv.id },
      amount: inv.total,
    }, actor);
    return { approvalId: req.id };
  });
}

export async function refreshEinvoice(businessId: string, invoiceId: string) {
  const db = await readSnapshot(businessId);
  const inv = db.invoices.find((i) => i.id === invoiceId || i.invoiceNumber === invoiceId);
  if (!inv?.einvoice.submissionUid) throw new HttpError(400, 'This invoice has not been submitted to MyInvois.');
  const { pctx } = await contextFor(businessId, 'myinvois');
  const r = await refreshInvoice(pctx, inv.einvoice.submissionUid, inv.einvoice.uuid);
  return withBusiness(businessId, (d) => {
    const x = d.invoices.find((i) => i.id === inv.id)!;
    const before = x.einvoice.status;
    x.einvoice = { ...x.einvoice, ...r } as typeof x.einvoice;
    if (before !== x.einvoice.status) {
      ops.audit(d, 'MyInvois', 'status', 'invoice', x.invoiceNumber, `e-Invoice ${before} → ${x.einvoice.status}`);
      if (x.einvoice.status === 'invalid') ops.notify(d, `e-Invoice rejected: ${x.invoiceNumber}`, String(x.einvoice.error ?? ''), 'warning');
    }
    return { einvoice: x.einvoice };
  });
}

export async function cancelEinvoice(businessId: string, invoiceId: string, reason: string, actor: string) {
  const db = await readSnapshot(businessId);
  const inv = db.invoices.find((i) => i.id === invoiceId || i.invoiceNumber === invoiceId);
  if (!inv?.einvoice.uuid) throw new HttpError(400, 'This invoice has no MyInvois document to cancel.');
  if (!reason.trim()) throw new HttpError(400, 'Give a reason for cancelling.');
  const { pctx } = await contextFor(businessId, 'myinvois');
  await cancelDocument(pctx, inv.einvoice.uuid, reason);
  return withBusiness(businessId, (d) => {
    const x = d.invoices.find((i) => i.id === inv.id)!;
    x.einvoice = { ...x.einvoice, status: 'cancelled' };
    x.status = 'cancelled';
    ops.audit(d, actor, 'cancel', 'invoice', x.invoiceNumber, `e-Invoice cancelled: ${reason}`);
    return { einvoice: x.einvoice };
  });
}

export async function checkTin(businessId: string, tin: string, idType: string, idValue: string) {
  if (!tin || !idType || !idValue) throw new HttpError(400, 'Enter the TIN, ID type and ID number.');
  const { pctx } = await contextFor(businessId, 'myinvois');
  return validateTin(pctx, tin.trim(), idType.trim(), idValue.trim());
}
