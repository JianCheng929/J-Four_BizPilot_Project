import { useState } from 'react';
import { PiggyBank, Plus, Target, TrendingUp } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { budgetVsActual } from '@/lib/metrics';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Kpi, SectionCard, SimpleSelect, num, primaryBtn } from '../common';
import { EXPENSE_CATEGORIES } from '../ExpenseDialog';

function lastMonths(n: number) {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}

/** Blueprint D: monthly budget per expense category against what was actually spent. */
export function BudgetTab() {
  const { db, run, can } = useBizPilot();
  const months = lastMonths(12);
  const [month, setMonth] = useState(months[0]);
  const [newCat, setNewCat] = useState(EXPENSE_CATEGORIES[0]);
  const [newAmt, setNewAmt] = useState('');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const b = budgetVsActual(db, month);
  const over = b.rows.filter((r) => r.budget && r.actual > r.budget);

  const save = (category: string, value: string) => {
    const v = num(value);
    if (!(v >= 0)) return;
    run((d, a) => ops.setBudget(d, category, v, a), v ? `Budget for ${category} saved` : `Budget for ${category} removed`);
    setEdit((e) => { const n = { ...e }; delete n[category]; return n; });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi icon={Target} label="Budget this month" value={money(b.budget)} hint={`${Object.keys(db.settings.budgets ?? {}).length} categories`} />
        <Kpi icon={PiggyBank} label="Spent" value={money(b.actual)} hint={b.budget ? `${Math.round((b.actual / b.budget) * 100)}% of budget` : 'no budget set'} tone={b.budget && b.actual > b.budget ? 'red' : 'teal'} />
        <Kpi icon={TrendingUp} label="Over budget" value={String(over.length)} hint={over.map((r) => r.category).join(', ') || 'none'} tone={over.length ? 'red' : 'slate'} />
      </div>
      <SectionCard
        title="Budget vs actual"
        description="Expenses by category against the monthly budget. Projected = where the month ends at the current pace (repeating costs counted once). BizPilot tells you when a category heads over."
        actions={<div className="w-36"><SimpleSelect value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-MY', { month: 'short', year: 'numeric' }) }))} /></div>}
      >
        {b.rows.length === 0 ? (
          <div className="py-4 text-center text-sm text-slate-500">No budgets or expenses for this month yet. Add a budget below.</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="w-36 text-right">Monthly budget</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="w-48">Used</TableHead>
                  <TableHead className="text-right">Left</TableHead>
                  <TableHead className="text-right">Projected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.rows.map((r) => {
                  const pct = r.pct ?? 0;
                  return (
                    <TableRow key={r.category}>
                      <TableCell className="font-medium">{r.category}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          className="h-8 text-right"
                          type="number"
                          min="0"
                          disabled={!can.manage}
                          value={edit[r.category] ?? (r.budget ? String(r.budget) : '')}
                          placeholder="none"
                          onChange={(e) => setEdit((s) => ({ ...s, [r.category]: e.target.value }))}
                          onBlur={(e) => edit[r.category] !== undefined && save(r.category, e.target.value || '0')}
                          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.actual)}</TableCell>
                      <TableCell>
                        {r.budget ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 rounded-full bg-slate-100">
                              <div className={cn('h-1.5 rounded-full', pct > 100 ? 'bg-red-500' : pct > 85 ? 'bg-amber-500' : 'bg-teal-600')} style={{ width: `${Math.min(100, pct)}%` }} />
                            </div>
                            <span className={cn('w-10 text-right text-xs tabular-nums', pct > 100 && 'font-semibold text-red-600')}>{pct}%</span>
                          </div>
                        ) : <span className="text-xs text-slate-400">no budget</span>}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', r.budget && r.left < 0 && 'text-red-600')}>{r.budget ? money(r.left) : '—'}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', r.budget && r.projected > r.budget && 'text-amber-700')}>{money(r.projected)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {can.manage && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
            <div className="w-56"><SimpleSelect value={newCat} onChange={setNewCat} options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))} /></div>
            <Input className="h-9 w-36" type="number" min="0" placeholder="RM per month" value={newAmt} onChange={(e) => setNewAmt(e.target.value)} />
            <Button className={primaryBtn} disabled={!(num(newAmt) > 0)} onClick={() => { save(newCat, newAmt); setNewAmt(''); }}><Plus className="mr-1 h-4 w-4" /> Set budget</Button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
