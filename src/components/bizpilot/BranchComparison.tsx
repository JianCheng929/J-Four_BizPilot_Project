import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { money, moneyShort } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCard, SimpleSelect } from './common';

/** Blueprint D / F: compare shops and warehouses side by side. */
export function BranchComparison() {
  const { db } = useBizPilot();
  const [days, setDays] = useState('30');
  if (db.locations.length < 2) return null;
  const rows = ops.branchComparison(db, Number(days));
  const best = rows[0];
  return (
    <SectionCard
      title="Branch comparison"
      description={`Sales, gross profit, costs booked to each branch and stock held. Costs not tied to a branch are left out.${best?.revenue ? ` ${best.name} leads with ${money(best.revenue)}.` : ''}`}
      actions={<div className="w-32"><SimpleSelect value={days} onChange={setDays} options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last 12 months' }]} /></div>}
    >
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" fontSize={11} />
            <YAxis fontSize={11} tickFormatter={(v) => moneyShort(Number(v))} />
            <Tooltip formatter={(v) => money(Number(v))} />
            <Legend />
            <Bar dataKey="revenue" name="Revenue" fill="#0f766e" radius={[3, 3, 0, 0]} />
            <Bar dataKey="netProfit" name="Net profit" fill="#f59e0b" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Branch</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Avg order</TableHead>
              <TableHead className="text-right">Gross profit</TableHead><TableHead className="text-right">Margin</TableHead><TableHead className="text-right">Branch costs</TableHead><TableHead className="text-right">Net profit</TableHead><TableHead className="text-right">Stock held</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.locationId}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right">{r.orders}</TableCell>
                <TableCell className="text-right">{money(r.revenue)}</TableCell>
                <TableCell className="text-right">{money(r.avgOrder)}</TableCell>
                <TableCell className="text-right">{money(r.grossProfit)}</TableCell>
                <TableCell className="text-right">{r.marginPct}%</TableCell>
                <TableCell className="text-right">{money(r.expenses)}</TableCell>
                <TableCell className={`text-right font-medium ${r.netProfit < 0 ? 'text-red-600' : ''}`}>{money(r.netProfit)}</TableCell>
                <TableCell className="text-right">{money(r.stockValue)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
