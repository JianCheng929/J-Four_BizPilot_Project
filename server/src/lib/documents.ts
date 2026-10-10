import type { BusinessSettings, Invoice, PurchaseOrder, BizPilotDB, Quotation } from '../../../src/lib/db/types.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const rm = (n: number) => `RM${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const d = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** A quotation as an invoice-shaped document, so it renders the same way. */
function quoteDoc(q: Quotation): Invoice {
  return {
    id: q.id, invoiceNumber: q.quoteNumber, type: 'invoice', customerName: q.customerName, customerEmail: q.customerEmail, customerTin: q.customerTin,
    customerBrn: q.customerBrn, customerPhone: q.customerPhone, customerAddress: q.customerAddress, lines: q.lines, subtotal: q.subtotal,
    taxTotal: q.taxTotal, total: q.total, status: 'draft', issuedDate: q.issuedDate, dueDate: q.validUntil, orderId: null, einvoice: { status: 'not_submitted' },
  };
}

export function quotationHtml(q: Quotation, s: BusinessSettings): string {
  return invoiceHtml(quoteDoc(q), s, { title: 'QUOTATION', dueLabel: 'Valid until', footer: `${q.note ? `${esc(q.note)}<br>` : ''}Payment terms: ${q.paymentDays ? `${q.paymentDays} days from invoice` : 'on invoice'}. This quotation is not a tax invoice.` });
}

export function quotationText(q: Quotation, s: BusinessSettings): string {
  return [
    `Quotation ${q.quoteNumber} from ${s.legalName || s.name}`,
    `Valid until ${d(q.validUntil)}`,
    '',
    ...q.lines.map((l) => `${l.quantity} x ${l.description} @ ${rm(l.unitPrice)}`),
    '',
    `Total: ${rm(q.total)}`,
    q.note,
  ].join('\n');
}

/** Printable HTML invoice, used for email bodies. */
export function invoiceHtml(inv: Invoice, s: BusinessSettings, opts: { title?: string; dueLabel?: string; footer?: string } = {}): string {
  const rows = inv.lines.map((l) => {
    const net = l.quantity * l.unitPrice;
    return `<tr><td>${esc(l.description)}</td><td align="right">${l.quantity}</td><td align="right">${rm(l.unitPrice)}</td><td align="right">${l.taxRate ?? 0}%</td><td align="right">${rm(net)}</td></tr>`;
  }).join('');
  const qr = inv.einvoice?.validationUrl
    ? `<p style="margin-top:16px">LHDN e-Invoice validated: <a href="${esc(inv.einvoice.validationUrl)}">${esc(inv.einvoice.uuid)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a;max-width:720px">
<h2 style="margin:0">${esc(s.legalName || s.name)}</h2>
<div style="font-size:12px;color:#475569">${esc([s.addressLine, s.postcode, s.city].filter(Boolean).join(', '))}<br>${esc([s.brn && `SSM ${s.brn}`, s.tin && `TIN ${s.tin}`, s.sstNo && s.sstNo !== 'NA' && `SST ${s.sstNo}`].filter(Boolean).join(' · '))}<br>${esc([s.phone, s.email].filter(Boolean).join(' · '))}</div>
<h3 style="margin-top:24px">${opts.title ?? (inv.type === 'credit_note' ? 'CREDIT NOTE' : 'INVOICE')} ${esc(inv.invoiceNumber)}</h3>
<p style="font-size:13px">Bill to: <b>${esc(inv.customerName)}</b><br>${esc(inv.customerAddress)}<br>Issued ${d(inv.issuedDate)} · ${opts.dueLabel ?? 'Due'} ${d(inv.dueDate)}</p>
<table width="100%" cellpadding="6" style="border-collapse:collapse;font-size:13px">
<thead><tr style="background:#f1f5f9"><th align="left">Description</th><th align="right">Qty</th><th align="right">Unit price</th><th align="right">Tax</th><th align="right">Amount</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="text-align:right;font-size:13px">Subtotal ${rm(inv.subtotal)}<br>Tax ${rm(inv.taxTotal)}<br><b style="font-size:16px">Total ${rm(inv.total)}</b></p>
${qr}
${opts.footer ? `<p style="font-size:12px;color:#64748b">${opts.footer}</p>` : `<p style="font-size:12px;color:#64748b">Status: ${esc(inv.status)}</p>`}
</body></html>`;
}

export function invoiceText(inv: Invoice, s: BusinessSettings): string {
  return [
    `${inv.type === 'credit_note' ? 'Credit note' : 'Invoice'} ${inv.invoiceNumber} from ${s.legalName || s.name}`,
    `Due ${d(inv.dueDate)}`,
    '',
    ...inv.lines.map((l) => `${l.quantity} x ${l.description} @ ${rm(l.unitPrice)}`),
    '',
    `Total: ${rm(inv.total)}`,
    inv.einvoice?.validationUrl ? `LHDN e-Invoice: ${inv.einvoice.validationUrl}` : '',
  ].join('\n');
}

export function purchaseOrderText(po: PurchaseOrder, db: BizPilotDB): string {
  const s = db.settings;
  const lines = po.lines.map((l) => {
    const p = db.products.find((x) => x.id === l.productId);
    return `- ${p?.name ?? l.productId} (${p?.sku ?? ''}): ${l.quantity} @ ${rm(l.unitCost)}`;
  });
  return [
    `Purchase order ${po.poNumber} from ${s.legalName || s.name}`,
    '',
    ...lines,
    '',
    `Total: ${rm(po.totalCost)}`,
    po.expectedDate ? `Requested delivery: ${d(po.expectedDate)}` : '',
    po.note ? `Note: ${po.note}` : '',
    '',
    `Deliver to: ${[s.addressLine, s.postcode, s.city].filter(Boolean).join(', ')}`,
    `Contact: ${[s.phone, s.email].filter(Boolean).join(' / ')}`,
    '',
    'Please reply to confirm this order and the delivery date.',
  ].join('\n');
}
