import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, Paperclip, Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import { openReceipt, uploadReceipt } from '@/lib/receipts';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { upcomingBills } from '@/lib/metrics';
import { fmtDate, money, relDay } from '@/lib/format';
import type { Expense } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { EmptyState, Pill, SectionCard, primaryBtn } from '../common';
import { ExpenseDialog } from '../ExpenseDialog';

export function ExpensesTab() {
  const { db, run, business, can } = useBizPilot();
  const fileRef = useRef<HTMLInputElement>(null);
  const receiptFor = useRef<Expense | null>(null);
  const pickReceipt = (e: Expense) => { receiptFor.current = e; fileRef.current?.click(); };
  const [dialog, setDialog] = useState<{ open: boolean; expense: Expense | null }>({ open: false, expense: null });
  const [cat, setCat] = useState('all');

  const bills = upcomingBills(db, 14);
  const unpaidTotal = db.expenses.filter((e) => !e.paid).reduce((s, e) => s + e.amount, 0);
  const categories = [...new Set(db.expenses.map((e) => e.category))].sort();
  const list = db.expenses.filter((e) => cat === 'all' || e.category === cat);

  const since30 = Date.now() - 30 * 86400000;
  const byCat = new Map<string, number>();
  for (const e of db.expenses.filter((x) => new Date(x.date).getTime() >= since30)) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount);
  const cat30 = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const total30 = cat30.reduce((s, [, v]) => s + v, 0);

  const markPaid = (e: Expense) =>
    run((d, a) => ops.payExpense(d, e.id, a), 'Bill marked paid');

  const remove = (e: Expense) => {
    if (!window.confirm(`Delete "${e.description}" (${money(e.amount)})?`)) return;
    run((d, a) => {
      d.expenses = d.expenses.filter((x) => x.id !== e.id);
      ops.audit(d, a, 'delete', 'expense', e.id, `Expense deleted: ${e.description} ${money(e.amount)}`);
    }, 'Expense deleted');
  };

  if (db.expenses.length === 0) {
    return (
      <>
        <EmptyState
          icon={Receipt}
          title="No expenses recorded yet"
          body="Record rent, utilities, salaries, platform fees and supplier bills. Unpaid bills with a due date show up as reminders, and expenses feed your profit & loss."
          actionLabel="Add your first expense"
          onAction={() => setDialog({ open: true, expense: null })}
        />
        <ExpenseDialog open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} expense={dialog.expense} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Bills due in the next 14 days"
          description={`${money(unpaidTotal)} unpaid in total`}
        >
          {bills.length === 0 ? (
            <div className="text-sm text-slate-500">No unpaid bills due in the next 14 days.</div>
          ) : (
            <div className="space-y-2">
              {bills.map((b) => {
                const overdue = b.dueDate && new Date(b.dueDate).getTime() < Date.now();
                return (
                  <div key={b.id} className={cn('flex items-center gap-3 rounded-md border px-3 py-2', overdue ? 'border-red-200 bg-red-50/50' : 'border-slate-200')}>
                    <CalendarClock className={cn('h-4 w-4', overdue ? 'text-red-600' : 'text-amber-600')} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{b.description}</div>
                      <div className="text-xs text-slate-500">
                        {b.category} · due {b.dueDate ? `${fmtDate(b.dueDate)} (${relDay(b.dueDate)})` : '—'}
                      </div>
                    </div>
                    <span className="text-sm font-semibold">{money(b.amount)}</span>
                    <Button size="sm" variant="outline" onClick={() => markPaid(b)}>
                      Mark paid
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
        <SectionCard title="Last 30 days by category" description={`${money(total30)} total`}>
          {cat30.length === 0 ? (
            <div className="text-sm text-slate-500">No expenses dated in the last 30 days.</div>
          ) : (
            <div className="space-y-2">
              {cat30.map(([c, v]) => (
                <div key={c}>
                  <div className="flex justify-between text-xs">
                    <span>{c}</span>
                    <span className="font-medium">{money(v)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                    <div className="h-1.5 rounded-full bg-teal-600" style={{ width: `${(v / total30) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Expenses & bills"
        actions={
          <>
            <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <Button size="sm" className={primaryBtn} onClick={() => setDialog({ open: true, expense: null })}>
              <Plus className="mr-1 h-4 w-4" /> Add expense
            </Button>
          </>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-xs">{fmtDate(e.date)}</TableCell>
                <TableCell className="text-sm">{e.category}</TableCell>
                <TableCell className="text-sm">
                  {e.description}
                  {e.recurring && <Pill className="ml-2">recurring</Pill>}
                </TableCell>
                <TableCell className="text-right font-medium">{money(e.amount)}</TableCell>
                <TableCell className="text-xs">
                  {e.paid ? (
                    <Pill tone="green">paid</Pill>
                  ) : (
                    <>
                      <Pill tone={e.dueDate && new Date(e.dueDate).getTime() < Date.now() ? 'red' : 'amber'}>unpaid</Pill>
                      {e.dueDate && <div className="mt-0.5 text-slate-500">due {fmtDate(e.dueDate)}</div>}
                    </>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {!e.paid && (
                      <Button size="sm" variant="outline" onClick={() => markPaid(e)}>
                        Mark paid
                      </Button>
                    )}
                    {e.receiptUrl ? (
                      <Button size="icon-sm" variant="ghost" title="Open receipt" onClick={() => void openReceipt(e.receiptUrl!).catch((err) => toast.error((err as Error).message))}>
                        <Paperclip className="h-4 w-4 text-teal-700" />
                      </Button>
                    ) : (
                      <Button size="icon-sm" variant="ghost" title="Attach receipt (photo or PDF)" disabled={!can.write} onClick={() => pickReceipt(e)}>
                        <Paperclip className="h-4 w-4 text-slate-400" />
                      </Button>
                    )}
                    <Button size="icon-sm" variant="ghost" onClick={() => setDialog({ open: true, expense: e })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => remove(e)}>
                      <Trash2 className="h-4 w-4 text-slate-400" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
      <ExpenseDialog open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} expense={dialog.expense} />
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(ev) => {
          const file = ev.target.files?.[0];
          const target = receiptFor.current;
          ev.target.value = '';
          if (!file || !target) return;
          void uploadReceipt(business.id, target.id, file)
            .then((path) => run((d, a) => ops.attachReceipt(d, target.id, path, a), 'Receipt attached'))
            .catch((err) => toast.error((err as Error).message));
        }}
      />
    </div>
  );
}
