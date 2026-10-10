import { useState } from 'react';
import { LineChart } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { paidOrders, productPerformance, profitAndLoss } from '@/lib/metrics';
import { fmtDate, money } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { EmptyState, SectionCard } from '../common';

const DAY = 86400000;

export function PnLTab({ onGoToSales }: { onGoToSales: () => void }) {
  const { db } = useBizPilot();
  const [days, setDays] = useState(30);

  const pnl = profitAndLoss(db, days);
  const perf = productPerformance(db, days);
  const since = Date.now() - days * DAY;
  const ordersInPeriod = db.salesOrders.filter((o) => new Date(o.date).getTime() >= since);
  const counted = paidOrders(ordersInPeriod);
  const expensesInPeriod = db.expenses.filter((e) => new Date(e.date).getTime() >= since);

  // Data-quality gaps that make the numbers incomplete
  const zeroCost = new Set<string>();
  let unmatchedLines = 0;
  for (const o of counted) {
    for (const l of o.lines) {
      if (!l.productId) {
        unmatchedLines++;
        continue;
      }
      const p = db.products.find((x) => x.id === l.productId);
      if (!p || p.unitCost <= 0) zeroCost.add(p?.name ?? 'deleted product');
    }
  }

  if (db.salesOrders.length === 0 && db.expenses.length === 0) {
    return (
      <EmptyState
        icon={LineChart}
        title="No sales or expenses to report on yet"
        body="Profit & loss is calculated from your recorded sales, product unit costs and expenses. Record a sale to get started."
        actionLabel="Go to Sales"
        onAction={onGoToSales}
      />
    );
  }

  const row = (label: string, value: number, opts: { bold?: boolean; neg?: boolean; sub?: string } = {}) => (
    <div className={cn('flex items-baseline justify-between py-1.5', opts.bold && 'border-t font-semibold')}>
      <span className={cn(!opts.bold && 'text-slate-600')}>
        {label}
        {opts.sub && <span className="ml-1 text-xs text-slate-400">{opts.sub}</span>}
      </span>
      <span className={cn(value < 0 && 'text-red-600')}>{opts.neg ? `(${money(value)})` : money(value)}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <TabsList>
            <TabsTrigger value="7">Last 7 days</TabsTrigger>
            <TabsTrigger value="30">Last 30 days</TabsTrigger>
            <TabsTrigger value="90">Last 90 days</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="text-xs text-slate-500">
          Period: {fmtDate(new Date(since).toISOString())} – {fmtDate(new Date().toISOString())}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <SectionCard title="Profit & loss">
          <div className="text-sm">
            {row('Revenue', pnl.revenue, { sub: `${counted.length} order(s)` })}
            {row('Cost of goods sold', pnl.cogs, { neg: true })}
            {row('Gross profit', pnl.grossProfit, { bold: true, sub: `${pnl.grossMarginPct.toFixed(1)}% margin` })}
            {row('Operating expenses', pnl.expenses, { neg: true, sub: `${expensesInPeriod.length} record(s)` })}
            {row('Net profit', pnl.netProfit, { bold: true })}
          </div>
          <div className="mt-3 space-y-1 rounded-md bg-slate-50 p-3 text-[11px] text-slate-600">
            <div>
              <b>Actual</b>, from {counted.length} order(s) and {expensesInPeriod.length} expense(s) dated in the last {days} days
              {ordersInPeriod.length > counted.length && ` (${ordersInPeriod.length - counted.length} cancelled/refunded order(s) excluded)`}. Revenue is
              before tax; COGS uses each product's current unit cost.
            </div>
            {zeroCost.size > 0 && (
              <div className="text-amber-700">
                Missing: unit cost is 0 for {[...zeroCost].slice(0, 5).join(', ')}
                {zeroCost.size > 5 ? ` and ${zeroCost.size - 5} more` : ''}, so gross profit is overstated. Set costs in Inventory.
              </div>
            )}
            {unmatchedLines > 0 && (
              <div className="text-amber-700">Missing: {unmatchedLines} order line(s) aren't matched to a product and are counted with no cost.</div>
            )}
            {expensesInPeriod.length === 0 && <div className="text-amber-700">Missing: no expenses recorded for this period, so net profit equals gross profit.</div>}
            {db.expenses.some((e) => e.recurring) && (
              <div>Recurring expenses are counted only where a record exists for a date within the period.</div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Product performance" description={`Paid sales in the last ${days} days`}>
          {perf.length === 0 ? (
            <div className="text-sm text-slate-500">No product sales in this period.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Gross profit</TableHead>
                  <TableHead className="text-right">Margin (list)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perf.map((r) => (
                  <TableRow key={r.product.id}>
                    <TableCell className="font-medium">
                      {r.product.name}
                      {r.product.unitCost <= 0 && <div className="text-[11px] text-amber-700">no unit cost</div>}
                    </TableCell>
                    <TableCell className="text-right">{r.units}</TableCell>
                    <TableCell className="text-right">{money(r.revenue)}</TableCell>
                    <TableCell className={cn('text-right', r.grossProfit < 0 && 'text-red-600')}>{money(r.grossProfit)}</TableCell>
                    <TableCell className={cn('text-right', r.marginPct < 15 && 'text-amber-700')}>{r.marginPct.toFixed(1)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
