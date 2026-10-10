import { Printer } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import type { Invoice } from '@/lib/db/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { primaryBtn } from './common';
import { GENERAL_PUBLIC_TIN } from './InvoiceDialog';

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #bp-invoice-print, #bp-invoice-print * { visibility: visible !important; }
  #bp-invoice-print { position: fixed; inset: 0; padding: 24px; background: white; overflow: visible; }
  .bp-no-print { display: none !important; }
}`;

export function InvoicePrint({
  invoice,
  onOpenChange,
  title: titleOverride,
  dueLabel = 'Due',
  footer,
}: {
  invoice: Invoice | null;
  onOpenChange: (o: boolean) => void;
  title?: string;
  dueLabel?: string;
  footer?: string;
}) {
  const { db } = useBizPilot();
  if (!invoice) return null;
  const s = db.settings;
  const cur = s.currency || 'RM';
  const title = titleOverride ?? (invoice.type === 'credit_note' ? 'CREDIT NOTE' : invoice.einvoice.uuid ? 'E-INVOICE' : 'INVOICE');
  const sellerMissing = [!s.legalName && 'legal name', !s.brn && 'BRN', !s.tin && 'TIN', !s.addressLine && 'address'].filter(Boolean);

  return (
    <Dialog open={!!invoice} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <style>{PRINT_CSS}</style>
        <DialogHeader className="bp-no-print">
          <DialogTitle>{invoice.invoiceNumber}</DialogTitle>
        </DialogHeader>
        {sellerMissing.length > 0 && (
          <div className="bp-no-print rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Your seller details are incomplete ({sellerMissing.join(', ')}). Fill them in Settings so they appear on invoices.
          </div>
        )}

        <div id="bp-invoice-print" className="bg-white text-[13px] text-slate-900">
          <div className="flex items-start justify-between gap-6 border-b pb-4">
            <div>
              <div className="text-lg font-bold">{s.legalName || s.name}</div>
              {s.legalName && s.name && s.legalName !== s.name && <div className="text-xs text-slate-500">({s.name})</div>}
              <div className="mt-1 space-y-0.5 text-xs text-slate-600">
                {s.brn && <div>Reg. No (BRN): {s.brn}</div>}
                {s.tin && <div>TIN: {s.tin}</div>}
                {s.sstNo && s.sstNo !== 'NA' && <div>SST No: {s.sstNo}</div>}
                {s.msicCode && (
                  <div>
                    MSIC: {s.msicCode}
                    {s.msicDescription ? ` – ${s.msicDescription}` : ''}
                  </div>
                )}
                {s.addressLine && <div>{s.addressLine}</div>}
                {(s.postcode || s.city) && <div>{[s.postcode, s.city].filter(Boolean).join(' ')}</div>}
                {(s.phone || s.email) && <div>{[s.phone, s.email].filter(Boolean).join(' · ')}</div>}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold tracking-wide text-teal-800">{title}</div>
              <div className="mt-1 text-xs">
                <div>
                  No: <b>{invoice.invoiceNumber}</b>
                </div>
                <div>Date: {fmtDate(invoice.issuedDate)}</div>
                <div>{dueLabel}: {fmtDate(invoice.dueDate)}</div>
                <div className="mt-1 uppercase text-slate-500">{invoice.status}</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 py-4">
            <div>
              <div className="text-[11px] font-semibold uppercase text-slate-500">Bill to</div>
              <div className="font-semibold">{invoice.customerName}</div>
              <div className="space-y-0.5 text-xs text-slate-600">
                {invoice.customerAddress && <div>{invoice.customerAddress}</div>}
                {invoice.customerPhone && <div>{invoice.customerPhone}</div>}
                {invoice.customerEmail && <div>{invoice.customerEmail}</div>}
                {invoice.customerTin && invoice.customerTin !== GENERAL_PUBLIC_TIN && <div>TIN: {invoice.customerTin}</div>}
                {invoice.customerBrn && <div>Reg. No: {invoice.customerBrn}</div>}
              </div>
            </div>
            {invoice.einvoice.uuid && (
              <div className="text-xs">
                <div className="text-[11px] font-semibold uppercase text-slate-500">LHDN MyInvois</div>
                <div>
                  UUID: <span className="font-mono">{invoice.einvoice.uuid}</span>
                </div>
                <div>Status: {invoice.einvoice.status}</div>
                {invoice.einvoice.validatedAt && <div>Validated: {fmtDateTime(invoice.einvoice.validatedAt)}</div>}
                {invoice.einvoice.validationUrl && (
                  <div className="break-all">
                    Validate:{' '}
                    <a href={invoice.einvoice.validationUrl} target="_blank" rel="noreferrer" className="text-teal-700 underline">
                      {invoice.einvoice.validationUrl}
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>

          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-y bg-slate-50 text-left">
                <th className="px-2 py-1.5">#</th>
                <th className="px-2 py-1.5">Description</th>
                <th className="px-2 py-1.5 text-right">Qty</th>
                <th className="px-2 py-1.5 text-right">Unit price</th>
                <th className="px-2 py-1.5 text-right">Tax</th>
                <th className="px-2 py-1.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l, i) => {
                const amt = l.quantity * l.unitPrice;
                return (
                  <tr key={i} className="border-b">
                    <td className="px-2 py-1.5">{i + 1}</td>
                    <td className="px-2 py-1.5">{l.description}</td>
                    <td className="px-2 py-1.5 text-right">{l.quantity}</td>
                    <td className="px-2 py-1.5 text-right">{money(l.unitPrice, cur)}</td>
                    <td className="px-2 py-1.5 text-right">{l.taxRate ? `${l.taxRate}%` : '—'}</td>
                    <td className="px-2 py-1.5 text-right">{money(amt, cur)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-3 flex justify-end">
            <div className="w-60 space-y-0.5 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{money(invoice.subtotal, cur)}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax</span>
                <span>{money(invoice.taxTotal, cur)}</span>
              </div>
              <div className="flex justify-between border-t pt-1 font-bold">
                <span>Total</span>
                <span>{money(invoice.total, cur)}</span>
              </div>
              {invoice.paidDate && <div className="text-right text-xs text-teal-700">Paid {fmtDate(invoice.paidDate)}</div>}
            </div>
          </div>
          {footer && <div className="mt-4 whitespace-pre-line text-[11px] text-slate-600">{footer}</div>}
          {(!s.sstNo || s.sstNo === 'NA') && invoice.taxTotal === 0 && (
            <div className="mt-4 text-[11px] text-slate-500">Seller is not registered for SST.</div>
          )}
        </div>

        <div className="bp-no-print flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button className={primaryBtn} onClick={() => window.print()}>
            <Printer className="mr-1 h-4 w-4" /> Print / Save PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
