import { useState } from 'react';
import { FileSignature, MoreHorizontal, Plus } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { fmtDate, money } from '@/lib/format';
import type { Invoice, Quotation } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Kpi, SectionCard, StatusPill, primaryBtn } from '../common';
import { InvoiceDialog } from '../InvoiceDialog';
import { InvoicePrint } from '../InvoicePrint';
import { hasPendingApproval } from '../actions';
import { CheckCircle2, FileClock, Percent } from 'lucide-react';

/** Show a quotation with the invoice layout. */
function asDocument(q: Quotation): Invoice {
  return {
    id: q.id, invoiceNumber: q.quoteNumber, type: 'invoice', customerName: q.customerName, customerEmail: q.customerEmail,
    customerTin: q.customerTin, customerBrn: q.customerBrn, customerPhone: q.customerPhone, customerAddress: q.customerAddress,
    lines: q.lines, subtotal: q.subtotal, taxTotal: q.taxTotal, total: q.total, status: q.status as Invoice['status'],
    issuedDate: q.issuedDate, dueDate: q.validUntil, orderId: null, einvoice: { status: 'not_submitted' },
  };
}

/** Blueprint D5: quotations that turn into invoices once accepted. */
export function QuotationsTab({ onOpenInvoice }: { onOpenInvoice: (id: string) => void }) {
  const { db, run } = useBizPilot();
  const [dialog, setDialog] = useState<{ open: boolean; quotation: Quotation | null }>({ open: false, quotation: null });
  const [viewing, setViewing] = useState<Quotation | null>(null);
  const [nowMs] = useState(() => Date.now());
  const quotes = db.quotations ?? [];
  const open = quotes.filter((q) => q.status === 'draft' || q.status === 'sent');
  const decided = quotes.filter((q) => ['accepted', 'converted', 'declined'].includes(q.status));
  const won = decided.filter((q) => q.status !== 'declined');
  const expiringSoon = open.filter((q) => q.status === 'sent' && new Date(q.validUntil).getTime() - nowMs < 3 * 86400000);

  const dialogEl = (
    <InvoiceDialog mode="quotation" open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} quotation={dialog.quotation} />
  );

  if (!quotes.length) {
    return (
      <>
        <EmptyState
          icon={FileSignature}
          title="No quotations yet"
          body="Send a customer a price before they commit. When they accept, BizPilot turns the quotation into an invoice with the same lines and payment terms."
          actionLabel="Create a quotation"
          onAction={() => setDialog({ open: true, quotation: null })}
        />
        {dialogEl}
      </>
    );
  }

  const convert = (q: Quotation) => {
    const inv = run((d, a) => ops.convertQuotationToInvoice(d, q.id, a), `${q.quoteNumber} turned into a draft invoice`);
    if (inv) onOpenInvoice(inv.id);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi icon={FileClock} label="Open quotations" value={money(open.reduce((s, q) => s + q.total, 0))} hint={`${open.length} draft or sent`} />
        <Kpi icon={Percent} label="Win rate" value={decided.length ? `${Math.round((won.length / decided.length) * 100)}%` : '—'} hint={`${won.length} of ${decided.length} decided`} />
        <Kpi icon={CheckCircle2} label="Expiring within 3 days" value={String(expiringSoon.length)} hint="sent, no answer yet" tone={expiringSoon.length ? 'amber' : 'slate'} />
      </div>
      <SectionCard
        title="Quotations"
        actions={<Button size="sm" className={primaryBtn} onClick={() => setDialog({ open: true, quotation: null })}><Plus className="mr-1 h-4 w-4" /> New quotation</Button>}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quotation</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Valid until</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotes.map((q) => {
                const sendPending = hasPendingApproval(db, 'quotation_send', 'quotationId', q.id);
                const expired = q.status !== 'converted' && q.status !== 'accepted' && q.status !== 'declined' && new Date(q.validUntil).getTime() < nowMs;
                return (
                  <TableRow key={q.id}>
                    <TableCell className="font-medium"><button className="hover:underline" onClick={() => setViewing(q)}>{q.quoteNumber}</button></TableCell>
                    <TableCell className="text-sm">{q.customerName}{q.customerEmail && <div className="text-[11px] text-slate-400">{q.customerEmail}</div>}</TableCell>
                    <TableCell className={`whitespace-nowrap text-xs ${expired ? 'text-red-600' : ''}`}>{fmtDate(q.validUntil)}{expired && ' (expired)'}</TableCell>
                    <TableCell className="text-right font-medium">{money(q.total)}</TableCell>
                    <TableCell>
                      <StatusPill status={q.status === 'converted' ? 'paid' : q.status === 'sent' ? 'issued' : q.status === 'accepted' ? 'approved' : q.status} label={q.status === 'converted' ? 'invoiced' : q.status} />
                      {sendPending && <div className="mt-0.5 text-[11px] text-amber-700">awaiting approval</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewing(q)}>View / print PDF</DropdownMenuItem>
                          {q.status === 'draft' && (
                            <>
                              <DropdownMenuItem onClick={() => setDialog({ open: true, quotation: q })}>Edit draft</DropdownMenuItem>
                              <DropdownMenuItem disabled={sendPending} onClick={() => run((d, a) => ops.requestQuotationSend(d, q.id, a), 'Sent to Approvals')}>
                                Send to customer (needs approval)
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => run((d, a) => ops.markQuotationSent(d, q.id, a), `${q.quoteNumber} marked as sent`)}>I sent it myself</DropdownMenuItem>
                            </>
                          )}
                          {(q.status === 'draft' || q.status === 'sent' || q.status === 'expired' || q.status === 'accepted') && (
                            <DropdownMenuItem onClick={() => convert(q)}>Customer accepted: create invoice</DropdownMenuItem>
                          )}
                          {(q.status === 'sent' || q.status === 'expired' || q.status === 'draft') && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-red-600" onClick={() => run((d, a) => ops.setQuotationOutcome(d, q.id, 'declined', a), `${q.quoteNumber} marked declined`)}>Customer declined</DropdownMenuItem>
                            </>
                          )}
                          {q.status === 'converted' && q.invoiceId && <DropdownMenuItem onClick={() => onOpenInvoice(q.invoiceId!)}>Open the invoice</DropdownMenuItem>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      {dialogEl}
      <InvoicePrint
        invoice={viewing ? asDocument(viewing) : null}
        onOpenChange={(o) => !o && setViewing(null)}
        title="QUOTATION"
        dueLabel="Valid until"
        footer={viewing ? `${viewing.note ? `${viewing.note}\n` : ''}Payment terms: ${viewing.paymentDays ? `${viewing.paymentDays} days from invoice` : 'on invoice'}. This quotation is not a tax invoice.` : undefined}
      />
    </div>
  );
}
