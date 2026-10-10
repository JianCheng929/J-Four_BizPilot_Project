import { useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, TrendingUp, Wallet } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { cashFlowForecast, cashLedger, type CashFlowItem } from '@/lib/metrics';
import { fmtDate, money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Kpi, Pill, SectionCard } from '../common';
import { CapitalButton } from '../CapitalDialog';

/** Blueprint D6: cash balance, money expected in and out, and a low-cash warning. */
export function CashFlowTab() {
  const { db } = useBizPilot();
  const [days, setDays] = useState(30);
  const f = cashFlowForecast(db, days);
  const p = f.position;

  return (
    <div className="space-y-4">
      {!p.capitalSet && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm">
          <span>Enter the money you started the business with (modal) so the balance below is right.</span>
          <CapitalButton variant="default" />
        </div>
      )}
      {f.lowCash && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          If bills are paid before customers pay you, money runs short by {money(Math.abs(f.worstCase))} within {days} days. Chase unpaid invoices or delay purchases.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Wallet} tone={p.balance < 0 ? 'red' : 'teal'} label="Money available now" value={money(p.balance)} hint={`Capital ${money(p.capital)} + sales & paid invoices ${money(p.salesIn)} − expenses ${money(p.expensesOut)} − purchases ${money(p.purchasesOut)}`} />
        <Kpi icon={ArrowDownLeft} label={`Expected in (${days} days)`} value={money(f.totalIn)} hint={`${f.inItems.length} unpaid invoice(s)`} />
        <Kpi icon={ArrowUpRight} tone="amber" label={`Expected out (${days} days)`} value={money(f.totalOut)} hint={`${f.outItems.length} bill(s) and planned purchase(s)`} />
        <Kpi icon={TrendingUp} tone={f.lowCash ? 'red' : 'slate'} label={`Projected in ${days} days`} value={money(f.projected)} hint={`Worst case ${money(f.worstCase)}`} />
      </div>
      <div className="flex gap-2">
        {[7, 30, 90].map((d) => (
          <Button key={d} size="sm" variant={d === days ? 'default' : 'outline'} onClick={() => setDays(d)}>
            Next {d} days
          </Button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ItemsCard title="Money coming in" empty="No unpaid invoices due in this period." items={f.inItems} />
        <ItemsCard title="Money going out" empty="No unpaid bills, repeating costs or planned purchases in this period." items={f.outItems} />
      </div>
      <LedgerCard />
      <div className="text-[11px] text-slate-500">
        Actual = from records you entered (invoices, bills, purchase orders). Estimated = repeating costs assumed to come again a month after the last payment, and purchase orders not placed yet. Paid sales are already in the balance.
      </div>
    </div>
  );
}

function ItemsCard({ title, items, empty }: { title: string; items: CashFlowItem[]; empty: string }) {
  return (
    <SectionCard title={title} description={`${items.length} item(s) · ${money(items.reduce((s, x) => s + x.amount, 0))}`}>
      {items.length === 0 ? (
        <div className="py-4 text-center text-sm text-slate-500">{empty}</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>What</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((x, i) => (
              <TableRow key={i}>
                <TableCell className="whitespace-nowrap text-xs">{fmtDate(x.date)}</TableCell>
                <TableCell className="text-sm">
                  {x.label} {x.kind === 'estimated' && <Pill tone="slate">estimated</Pill>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(x.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

/** Every record behind "Money available now", so the owner can check the number. */
function LedgerCard() {
  const { db } = useBizPilot();
  const rows = cashLedger(db);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <SectionCard
      title="Where “money available now” comes from"
      description={`${rows.length} record(s) · total ${money(total)}. Buying stock is money out here, but it is not an expense in P&L or Reports: it counts as cost of goods only when the stock is sold.`}
    >
      {rows.length === 0 ? (
        <div className="py-4 text-center text-sm text-slate-500">No capital, paid sales, paid expenses or placed purchase orders yet.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Record</TableHead>
              <TableHead className="text-right">In / out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, 200).map((r, i) => (
              <TableRow key={i}>
                <TableCell className="whitespace-nowrap text-xs">{r.date ? fmtDate(r.date) : '—'}</TableCell>
                <TableCell className="text-sm">{r.label}</TableCell>
                <TableCell className={`text-right tabular-nums ${r.amount < 0 ? 'text-red-600' : 'text-teal-700'}`}>{r.amount > 0 ? '+' : ''}{money(r.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
