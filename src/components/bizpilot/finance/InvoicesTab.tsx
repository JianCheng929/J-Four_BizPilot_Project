import { useState } from 'react';
import { FileText, Loader2, MoreHorizontal, Plus } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { overdueInvoices, upcomingObligations } from '@/lib/metrics';
import { fmtDate, money } from '@/lib/format';
import type { EInvoiceState, Invoice } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Kpi, Pill, SectionCard, StatusPill, primaryBtn } from '../common';
import { InvoiceDialog } from '../InvoiceDialog';
import { InvoicePrint } from '../InvoicePrint';
import { hasPendingApproval } from '../actions';
import { AlarmClock, CircleDollarSign, FileClock } from 'lucide-react';

const EINV_LABEL: Record<EInvoiceState['status'], string> = {
  not_submitted: 'Not submitted',
  submitted: 'Submitted',
  valid: 'Valid',
  invalid: 'Invalid',
  cancelled: 'Cancelled',
  error: 'Error',
};

export function InvoicesTab({ viewId, onView }: { viewId: string | null; onView: (id: string | null) => void }) {
  const { db, run, callServer, requestApproval } = useBizPilot();
  const [dialog, setDialog] = useState<{ open: boolean; invoice: Invoice | null }>({ open: false, invoice: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Invoice['status']>('all');

  const viewing = viewId ? db.invoices.find((i) => i.id === viewId) ?? null : null;
  const overdue = overdueInvoices(db);
  const dueSoon = upcomingObligations(db, 7);
  const outstanding = db.invoices.filter((i) => i.status === 'issued' || i.status === 'overdue');
  const list = db.invoices.filter((i) => filter === 'all' || i.status === filter);

  const withBusy = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const issue = (inv: Invoice) => {
    if (hasPendingApproval(db, 'invoice_issue', 'invoiceId', inv.id)) return;
    requestApproval({
      type: 'invoice_issue',
      title: `Issue ${inv.invoiceNumber} to ${inv.customerName} (${money(inv.total)})`,
      description: `${inv.lines.length} line(s), subtotal ${money(inv.subtotal)} + tax ${money(inv.taxTotal)}. Due ${fmtDate(inv.dueDate)}.${inv.customerEmail ? ` Will be sent to ${inv.customerEmail}.` : ''}`,
      payload: { invoiceId: inv.id },
      amount: inv.total,
      risk: 'low',
    });
  };

  const submitEinvoice = (inv: Invoice) =>
    withBusy(inv.id, () => callServer(`/api/einvoice/${inv.id}/submit`, undefined, 'MyInvois submission sent to Approvals'));
  const refreshEinvoice = (inv: Invoice) =>
    withBusy(inv.id, () => callServer(`/api/einvoice/${inv.id}/refresh`, undefined, 'E-invoice status refreshed'));
  const cancelEinvoice = (inv: Invoice) => {
    const reason = window.prompt(`Reason for cancelling e-invoice ${inv.invoiceNumber} (sent to LHDN):`);
    if (!reason?.trim()) return;
    void withBusy(inv.id, () => callServer(`/api/einvoice/${inv.id}/cancel`, { reason: reason.trim() }, 'E-invoice cancelled'));
  };
  const email = (inv: Invoice) =>
    withBusy(inv.id, () => callServer(`/api/email/invoice/${inv.id}`, undefined, `Invoice emailed to ${inv.customerEmail}`));

  const cancelInvoice = (inv: Invoice) => {
    if (!window.confirm(`Cancel ${inv.invoiceNumber}?`)) return;
    run((d, a) => ops.cancelInvoice(d, inv.id, a), `${inv.invoiceNumber} cancelled`);
  };

  if (db.invoices.length === 0) {
    return (
      <>
        <EmptyState
          icon={FileText}
          title="No invoices yet"
          body="Create an invoice for a customer, or open an order in Sales and choose “Create invoice”. Invoices can be submitted to LHDN MyInvois as e-invoices."
          actionLabel="Create your first invoice"
          onAction={() => setDialog({ open: true, invoice: null })}
        />
        <InvoiceDialog open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} invoice={dialog.invoice} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi icon={CircleDollarSign} label="Outstanding" value={money(outstanding.reduce((s, i) => s + i.total, 0))} hint={`${outstanding.length} invoice(s) issued, unpaid`} />
        <Kpi icon={AlarmClock} label="Overdue" value={money(overdue.reduce((s, i) => s + i.total, 0))} hint={`${overdue.length} invoice(s)`} tone={overdue.length ? 'red' : 'slate'} />
        <Kpi icon={FileClock} label="Due within 7 days" value={money(dueSoon.reduce((s, i) => s + i.total, 0))} hint={`${dueSoon.length} invoice(s)`} tone={dueSoon.length ? 'amber' : 'slate'} />
      </div>

      <SectionCard
        title="Invoices"
        actions={
          <>
            <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | Invoice['status'])}>
              <option value="all">All statuses</option>
              {(['draft', 'issued', 'overdue', 'paid', 'cancelled'] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button size="sm" className={primaryBtn} onClick={() => setDialog({ open: true, invoice: null })}>
              <Plus className="mr-1 h-4 w-4" /> New invoice
            </Button>
          </>
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>E-invoice</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((inv) => {
                const issuePending = hasPendingApproval(db, 'invoice_issue', 'invoiceId', inv.id);
                const submitPending = hasPendingApproval(db, 'einvoice_submit', 'invoiceId', inv.id);
                const e = inv.einvoice ?? { status: 'not_submitted' };
                const canSubmit = inv.status !== 'cancelled' && ['not_submitted', 'invalid', 'error'].includes(e.status) && !submitPending;
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">
                      <button className="hover:underline" onClick={() => onView(inv.id)}>
                        {inv.invoiceNumber}
                      </button>
                      {inv.type !== 'invoice' && <div className="text-[11px] text-slate-400">{inv.type.replace('_', ' ')}</div>}
                      {inv.recurrence?.active && <div className="text-[11px] text-teal-700">repeats every {inv.recurrence.every}, next {fmtDate(inv.recurrence.nextDate)}</div>}
                      {inv.recurringFrom && <div className="text-[11px] text-slate-400">repeat of {db.invoices.find((x) => x.id === inv.recurringFrom)?.invoiceNumber ?? 'an invoice'}</div>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {inv.customerName}
                      {inv.customerEmail && <div className="text-[11px] text-slate-400">{inv.customerEmail}</div>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{inv.status === 'draft' ? '—' : fmtDate(inv.issuedDate)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{fmtDate(inv.dueDate)}</TableCell>
                    <TableCell className="text-right font-medium">{money(inv.total)}</TableCell>
                    <TableCell>
                      <StatusPill status={inv.status} />
                      {issuePending && <div className="mt-0.5 text-[11px] text-amber-700">awaiting approval</div>}
                      {(inv.remindersSent ?? 0) > 0 && <div className="mt-0.5 text-[11px] text-slate-400">{inv.remindersSent} reminder(s){inv.lastReminderAt ? `, last ${fmtDate(inv.lastReminderAt)}` : ''}</div>}
                    </TableCell>
                    <TableCell className="text-xs">
                      <StatusPill status={e.status} label={EINV_LABEL[e.status]} />
                      {submitPending && <div className="mt-0.5 text-[11px] text-amber-700">awaiting approval</div>}
                      {e.error && <div className="mt-0.5 max-w-48 truncate text-[11px] text-red-600" title={e.error}>{e.error}</div>}
                      {e.environment === 'sandbox' && <Pill className="mt-0.5">sandbox</Pill>}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon-sm" variant="ghost" disabled={busy === inv.id}>
                            {busy === inv.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onView(inv.id)}>View / print</DropdownMenuItem>
                          {inv.status === 'draft' && (
                            <>
                              <DropdownMenuItem onClick={() => setDialog({ open: true, invoice: inv })}>Edit draft</DropdownMenuItem>
                              <DropdownMenuItem disabled={issuePending} onClick={() => issue(inv)}>
                                Issue (needs approval)
                              </DropdownMenuItem>
                            </>
                          )}
                          {(inv.status === 'issued' || inv.status === 'overdue') && (
                            <>
                              <DropdownMenuItem onClick={() => run((d, a) => ops.markInvoicePaid(d, inv.id, a), `${inv.invoiceNumber} marked paid`)}>
                                Mark paid
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={hasPendingApproval(db, 'payment_reminder', 'invoiceId', inv.id)}
                                onClick={() => run((d, a) => ops.requestPaymentReminder(d, inv.id, a), 'Reminder sent to Approvals')}
                              >
                                {hasPendingApproval(db, 'payment_reminder', 'invoiceId', inv.id) ? 'Reminder awaiting approval' : 'Send payment reminder'}
                              </DropdownMenuItem>
                            </>
                          )}
                          {inv.recurrence?.active && (
                            <DropdownMenuItem onClick={() => run((d, a) => ops.setInvoiceRecurrence(d, inv.id, null, a), `${inv.invoiceNumber} stopped repeating`)}>
                              Stop repeating
                            </DropdownMenuItem>
                          )}
                          {inv.status !== 'draft' && inv.status !== 'cancelled' && (
                            <DropdownMenuItem disabled={!inv.customerEmail} onClick={() => email(inv)}>
                              Email to customer{!inv.customerEmail ? ' (no email)' : ''}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-[11px] text-slate-400">LHDN MyInvois</DropdownMenuLabel>
                          {canSubmit && <DropdownMenuItem onClick={() => submitEinvoice(inv)}>Submit to MyInvois</DropdownMenuItem>}
                          {(e.status === 'submitted' || e.status === 'valid') && (
                            <DropdownMenuItem onClick={() => refreshEinvoice(inv)}>Refresh status</DropdownMenuItem>
                          )}
                          {e.status === 'valid' && (
                            <DropdownMenuItem className="text-red-600" onClick={() => cancelEinvoice(inv)}>
                              Cancel e-invoice
                            </DropdownMenuItem>
                          )}
                          {!canSubmit && e.status !== 'submitted' && e.status !== 'valid' && (
                            <DropdownMenuItem disabled>{submitPending ? 'Submission awaiting approval' : 'No e-invoice actions'}</DropdownMenuItem>
                          )}
                          {(inv.status === 'draft' || inv.status === 'issued' || inv.status === 'overdue') && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-red-600" onClick={() => cancelInvoice(inv)}>
                                Cancel invoice
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-sm text-slate-500">
                    No invoices with this status.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      <InvoiceDialog open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} invoice={dialog.invoice} />
      <InvoicePrint invoice={viewing} onOpenChange={(o) => !o && onView(null)} />
    </div>
  );
}
