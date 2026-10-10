import { useState, type ReactNode } from 'react';
import { BellRing, HandCoins, Receipt } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { AGEING_BUCKETS, payablesAgeing, receivablesAgeing, type Ageing } from '@/lib/metrics';
import { fmtDate, money } from '@/lib/format';
import type { Expense, Invoice } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Kpi, SectionCard } from '../common';
import { hasPendingApproval } from '../actions';

function AgeingTable<T>({ ageing, action, empty }: { ageing: Ageing<T>; action?: (row: Ageing<T>['rows'][number]) => ReactNode; empty: string }) {
  if (!ageing.rows.length) return <div className="py-6 text-center text-sm text-slate-500">{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            {AGEING_BUCKETS.map((b) => <TableHead key={b} className="whitespace-nowrap text-right">{b}</TableHead>)}
            <TableHead className="text-right">Total</TableHead>
            {action && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ageing.rows.map((r) => (
            <TableRow key={r.name}>
              <TableCell className="font-medium">{r.name}<div className="text-[11px] text-slate-400">{r.items.length} item(s){r.oldestDaysLate > 0 ? `, oldest ${r.oldestDaysLate} days late` : ''}</div></TableCell>
              {r.amounts.map((a, i) => (
                <TableCell key={i} className={`text-right tabular-nums ${!a ? 'text-slate-300' : i >= 3 ? 'font-medium text-red-600' : i >= 1 ? 'text-amber-700' : ''}`}>{a ? money(a) : '—'}</TableCell>
              ))}
              <TableCell className="text-right font-medium tabular-nums">{money(r.total)}</TableCell>
              {action && <TableCell className="text-right">{action(r)}</TableCell>}
            </TableRow>
          ))}
          <TableRow className="bg-slate-50 font-medium">
            <TableCell>Total</TableCell>
            {ageing.totals.map((a, i) => <TableCell key={i} className="text-right tabular-nums">{a ? money(a) : '—'}</TableCell>)}
            <TableCell className="text-right tabular-nums">{money(ageing.total)}</TableCell>
            {action && <TableCell />}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

/** Blueprint D3: accounts receivable and payable ageing, with payment reminders. */
export function AgeingTab() {
  const { db, run } = useBizPilot();
  const [nowMs] = useState(() => Date.now());
  const ar = receivablesAgeing(db);
  const ap = payablesAgeing(db);

  const remind = (invoices: Invoice[]) => {
    const due = invoices.filter((i) => new Date(i.dueDate).getTime() < nowMs && !hasPendingApproval(db, 'payment_reminder', 'invoiceId', i.id));
    if (!due.length) return;
    run((d, a) => due.map((i) => ops.requestPaymentReminder(d, i.id, a)), `${due.length} reminder(s) sent to Approvals`);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi icon={HandCoins} label="Customers owe you" value={money(ar.total)} hint={`${money(ar.overdue)} overdue`} tone={ar.overdue ? 'amber' : 'teal'} />
        <Kpi icon={Receipt} label="You owe (unpaid bills)" value={money(ap.total)} hint={`${money(ap.overdue)} overdue`} tone={ap.overdue ? 'red' : 'slate'} />
        <Kpi icon={BellRing} label="Over 60 days late" value={money(ar.totals[3] + ar.totals[4])} hint="hardest to collect" tone={ar.totals[3] + ar.totals[4] ? 'red' : 'slate'} />
      </div>
      <SectionCard
        title="Who owes you (receivables)"
        description="Issued, unpaid invoices by how many days past the due date. Reminders go to Approvals first; the wording gets firmer with each reminder."
      >
        <AgeingTable
          ageing={ar}
          empty="No unpaid invoices. Money owed by customers appears here once an invoice is issued."
          action={(r) => {
            const overdue = (r.items as Invoice[]).filter((i) => new Date(i.dueDate).getTime() < nowMs);
            const pending = overdue.filter((i) => hasPendingApproval(db, 'payment_reminder', 'invoiceId', i.id)).length;
            if (!overdue.length) return null;
            const last = overdue.map((i) => i.lastReminderAt).filter(Boolean).sort().pop();
            return (
              <div className="whitespace-nowrap">
                <Button size="sm" variant="outline" disabled={pending === overdue.length} onClick={() => remind(overdue)}>
                  <BellRing className="mr-1 h-3.5 w-3.5" /> {pending === overdue.length ? 'Reminder waiting' : 'Remind'}
                </Button>
                {last && <div className="mt-0.5 text-[11px] text-slate-400">last {fmtDate(last)}</div>}
              </div>
            );
          }}
        />
      </SectionCard>
      <SectionCard title="What you owe (payables)" description="Unpaid bills from Expenses by how late they are. Bills without a due date count from the day they were recorded.">
        <AgeingTable<Expense> ageing={ap} empty="No unpaid bills. Record a bill in Expenses and untick “Paid” to track it here." />
      </SectionCard>
    </div>
  );
}
