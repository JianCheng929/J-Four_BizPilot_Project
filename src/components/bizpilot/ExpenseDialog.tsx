import { useEffect, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { Expense } from '@/lib/db/types';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Field, SimpleSelect, fromDateInput, num, primaryBtn, toDateInput, todayInput } from './common';

export const EXPENSE_CATEGORIES = [
  'Rent',
  'Utilities',
  'Salaries',
  'Stock purchases',
  'Marketing',
  'Platform fees',
  'Shipping',
  'Packaging',
  'Software',
  'Transport',
  'Professional fees',
  'Tax',
  'Other',
];

export function ExpenseDialog({
  open,
  onOpenChange,
  expense,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  expense?: Expense | null;
}) {
  const { run, db } = useBizPilot();
  const [branch, setBranch] = useState('');
  const [category, setCategory] = useState('Other');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayInput());
  const [recurring, setRecurring] = useState(false);
  const [unpaid, setUnpaid] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCategory(expense?.category ?? 'Other');
    setDescription(expense?.description ?? '');
    setAmount(expense ? String(expense.amount) : '');
    setDate(expense ? toDateInput(expense.date) : todayInput());
    setRecurring(expense?.recurring ?? false);
    setUnpaid(expense ? !expense.paid : false);
    setDueDate(expense?.dueDate ? toDateInput(expense.dueDate) : '');
    setBranch(expense?.locationId ?? '');
  }, [open, expense]);

  const save = () => {
    const amt = num(amount);
    if (!(amt > 0)) return setError('Amount must be above 0.');
    if (!date) return setError('Date is required.');
    if (!description.trim()) return setError('Add a short description.');
    if (unpaid && !dueDate) return setError('Unpaid bills need a due date.');
    const data: Omit<Expense, 'id'> = {
      category,
      description: description.trim(),
      amount: amt,
      date: fromDateInput(date),
      recurring,
      paid: !unpaid,
      dueDate: unpaid ? fromDateInput(dueDate) : null,
      // Only written when branches are in use, so databases without the column still save.
      ...(branch || expense?.locationId ? { locationId: branch || null } : {}),
    };
    const res = expense
      ? run((d, a) => {
          const e = d.expenses.find((x) => x.id === expense.id);
          if (!e) throw new ops.OpError('Expense not found.');
          Object.assign(e, data);
          ops.audit(d, a, 'update', 'expense', e.id, `Expense updated: ${e.description}`);
          return e;
        }, 'Expense updated')
      : run((d, a) => ops.addExpense(d, data, a), unpaid ? 'Bill recorded' : 'Expense recorded');
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{expense ? 'Edit expense' : 'Add expense or bill'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <SimpleSelect value={category} onChange={setCategory} options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))} />
          </Field>
          <Field label="Amount (RM)">
            <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. TNB electricity September" />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="flex items-end gap-2 pb-2">
            <Switch id="exp-rec" checked={recurring} onCheckedChange={setRecurring} />
            <Label htmlFor="exp-rec" className="text-sm">
              Recurring monthly
            </Label>
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <Switch id="exp-unpaid" checked={unpaid} onCheckedChange={setUnpaid} />
            <Label htmlFor="exp-unpaid" className="text-sm">
              Not paid yet (bill)
            </Label>
          </div>
          {db.locations.length > 1 && (
            <Field label="Branch" className="col-span-2">
              <SimpleSelect value={branch || '__all'} onChange={(v) => setBranch(v === '__all' ? '' : v)} options={[{ value: '__all', label: 'Whole business (shared cost)' }, ...db.locations.map((l) => ({ value: l.id, label: l.name }))]} />
            </Field>
          )}
          {unpaid && (
            <Field label="Due date">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          )}
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
