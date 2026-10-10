import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownRight, ArrowUpRight, CircleDollarSign, Download, Percent, ShoppingCart, Sparkles, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import { post } from '@/lib/api';
import { dateRangeFor, periodReport, reportToCsv, type ReportFilter } from '@/lib/reports';
import { money, moneyShort } from '@/lib/format';
import { PageHeader, type PageKey } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Kpi, NONE, SimpleSelect, SectionCard, SOURCE_LABEL, primaryBtn } from '@/components/bizpilot/common';
import type { SalesOrder } from '@/lib/db/types';
import { BranchComparison } from '@/components/bizpilot/BranchComparison';

const PRESETS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'mtd', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'ytd', label: 'Year to date' },
] as const;

function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-slate-400">no earlier data</span>;
  const up = pct >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={up ? 'text-teal-700' : 'text-red-600'}>
      <Icon className="inline h-3.5 w-3.5" /> {Math.abs(pct).toFixed(1)}% vs previous period
    </span>
  );
}

/** Blueprint §13.9 Reports: custom date ranges, filters, export and an AI summary. */
export function Reports({ onNavigate }: { onNavigate?: (p: PageKey) => void }) {
  const { db } = useBizPilot();
  const [range, setRange] = useState(() => dateRangeFor('30d'));
  const [preset, setPreset] = useState<string>('30d');
  const [channel, setChannel] = useState<NonNullable<ReportFilter['channel']>>('all');
  const [source, setSource] = useState<string>('all');
  const [productId, setProductId] = useState<string>(NONE);
  const [asking, setAsking] = useState(false);

  const filter: ReportFilter = {
    ...range,
    channel,
    source: source as ReportFilter['source'],
    productId: productId === NONE ? null : productId,
  };
  const report = useMemo(() => {
    try {
      return periodReport(db, filter);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, range.from, range.to, channel, source, productId]);

  const applyPreset = (k: (typeof PRESETS)[number]['key']) => {
    setPreset(k);
    setRange(dateRangeFor(k));
  };

  const exportCsv = () => {
    if (!report) return;
    const blob = new Blob([reportToCsv(report, db.settings.name)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bizpilot-report-${report.filter.from}-to-${report.filter.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const askAi = async () => {
    setAsking(true);
    try {
      const f = report!.filter;
      await post('/api/agent/tasks', {
        prompt: `Summarise my business performance from ${f.from} to ${f.to}${f.channel !== 'all' ? ` for ${f.channel} sales` : ''}${f.source !== 'all' ? ` from ${f.source}` : ''}. Call business_report with exactly these dates and filters, explain the biggest changes against the previous period and why they likely happened, name the products driving profit and any losing margin, state the data gaps from the report notes, and give three concrete next actions.`,
      });
      toast.success('WorkBuddy is writing the summary. Opening Command Centre…');
      onNavigate?.('command');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const sources = [...new Set(db.salesOrders.map((o) => o.source))];

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Sales, profit and expenses for any period, compared with the period before"
        actions={
          <>
            <Button size="sm" variant="outline" disabled={!report} onClick={exportCsv}>
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
            <Button size="sm" className={primaryBtn} disabled={!report || asking} onClick={() => void askAi()}>
              <Sparkles className="mr-1 h-4 w-4" /> AI summary
            </Button>
          </>
        }
      />

      <div className="mb-4 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button key={p.key} size="sm" variant={preset === p.key ? 'default' : 'outline'} onClick={() => applyPreset(p.key)}>
              {p.label}
            </Button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs text-slate-500">
            From
            <Input type="date" value={range.from} onChange={(e) => { setPreset(''); setRange((r) => ({ ...r, from: e.target.value })); }} />
          </label>
          <label className="text-xs text-slate-500">
            To
            <Input type="date" value={range.to} onChange={(e) => { setPreset(''); setRange((r) => ({ ...r, to: e.target.value })); }} />
          </label>
          <label className="text-xs text-slate-500">
            Channel
            <SimpleSelect value={channel} onChange={(v) => setChannel(v as typeof channel)} options={[{ value: 'all', label: 'All channels' }, { value: 'online', label: 'Online' }, { value: 'retail', label: 'Retail' }]} />
          </label>
          <label className="text-xs text-slate-500">
            Source
            <SimpleSelect value={source} onChange={setSource} options={[{ value: 'all', label: 'All sources' }, ...sources.map((s) => ({ value: s, label: SOURCE_LABEL[s as SalesOrder['source']] ?? s }))]} />
          </label>
          <label className="text-xs text-slate-500">
            Product
            <SimpleSelect value={productId} onChange={setProductId} options={[{ value: NONE, label: 'All products' }, ...db.products.map((p) => ({ value: p.id, label: `${p.name} (${p.sku})` }))]} />
          </label>
        </div>
      </div>

      {!report ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm">Choose a valid start and end date.</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi icon={CircleDollarSign} label="Revenue" value={money(report.current.revenue)} hint={`Previous ${money(report.previous.revenue)}`} />
            <Kpi icon={Percent} label="Gross profit" value={money(report.current.grossProfit)} hint={`${report.current.grossMarginPct.toFixed(1)}% margin`} />
            <Kpi icon={Wallet} tone={report.current.netProfit < 0 ? 'red' : 'teal'} label="Net profit" value={money(report.current.netProfit)} hint={`After ${money(report.current.expenses)} expenses`} />
            <Kpi icon={ShoppingCart} tone="slate" label="Orders" value={String(report.current.orders)} hint={`${report.current.units} units · avg ${money(report.current.avgOrderValue)}`} />
          </div>
          <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>Revenue <Change pct={report.change.revenuePct} /></div>
            <div>Gross profit <Change pct={report.change.grossProfitPct} /></div>
            <div>Net profit <Change pct={report.change.netProfitPct} /></div>
            <div>Orders <Change pct={report.change.ordersPct} /></div>
          </div>

          <SectionCard title="Daily revenue" description={`${report.filter.from} to ${report.filter.to}`}>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => moneyShort(v)} />
                  <Tooltip cursor={{ fill: 'rgba(15,118,110,0.06)' }} formatter={(v, name) => [money(Number(v)), name === 'revenue' ? 'Revenue' : 'Gross profit']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar dataKey="revenue" fill="#0f766e" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Profit and loss" description="Actual recorded figures">
              <Table>
                <TableHeader>
                  <TableRow><TableHead /><TableHead className="text-right">This period</TableHead><TableHead className="text-right">Previous</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {([
                    ['Revenue', 'revenue'], ['Cost of goods', 'cogs'], ['Gross profit', 'grossProfit'], ['Operating expenses', 'expenses'], ['Net profit', 'netProfit'],
                  ] as const).map(([label, k]) => (
                    <TableRow key={k} className={k === 'netProfit' || k === 'grossProfit' ? 'font-semibold' : ''}>
                      <TableCell>{label}</TableCell>
                      <TableCell className="text-right">{money(report.current[k])}</TableCell>
                      <TableCell className="text-right text-slate-500">{money(report.previous[k])}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SectionCard>
            <SectionCard title="Sales by channel and source">
              <Table>
                <TableHeader><TableRow><TableHead>Channel / source</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Revenue</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.byChannel.map((c) => (
                    <TableRow key={`c-${c.key}`} className="font-medium"><TableCell className="capitalize">{c.key}</TableCell><TableCell className="text-right">{c.orders}</TableCell><TableCell className="text-right">{money(c.revenue)}</TableCell></TableRow>
                  ))}
                  {report.bySource.map((s) => (
                    <TableRow key={`s-${s.key}`}><TableCell className="pl-6 text-slate-600">{SOURCE_LABEL[s.key as SalesOrder['source']] ?? s.key}</TableCell><TableCell className="text-right">{s.orders}</TableCell><TableCell className="text-right">{money(s.revenue)}</TableCell></TableRow>
                  ))}
                  {!report.byChannel.length && <TableRow><TableCell colSpan={3} className="text-center text-sm text-slate-500">No sales in this period.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </SectionCard>
          </div>

          <SectionCard title="Products by gross profit" description="Margin uses each product's current unit cost">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Product</TableHead><TableHead className="text-right">Units</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Gross profit</TableHead><TableHead className="text-right">Margin</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {report.products.slice(0, 50).map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell>{p.name} <span className="text-xs text-slate-400">{p.sku}</span></TableCell>
                    <TableCell className="text-right">{p.units}</TableCell>
                    <TableCell className="text-right">{money(p.revenue)}</TableCell>
                    <TableCell className={`text-right ${p.grossProfit < 0 ? 'text-red-600' : ''}`}>{money(p.grossProfit)}</TableCell>
                    <TableCell className={`text-right ${p.marginPct < db.settings.targetMarginPct ? 'text-amber-700' : ''}`}>{p.marginPct.toFixed(1)}%</TableCell>
                  </TableRow>
                ))}
                {!report.products.length && <TableRow><TableCell colSpan={5} className="text-center text-sm text-slate-500">No product sales in this period.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </SectionCard>

          {!filter.productId && (
            <SectionCard title="Expenses by category">
              <Table>
                <TableHeader><TableRow><TableHead>Category</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Still unpaid</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.expensesByCategory.map((e) => (
                    <TableRow key={e.category}><TableCell>{e.category}</TableCell><TableCell className="text-right">{money(e.amount)}</TableCell><TableCell className="text-right">{e.unpaid ? money(e.unpaid) : '—'}</TableCell></TableRow>
                  ))}
                  {!report.expensesByCategory.length && <TableRow><TableCell colSpan={3} className="text-center text-sm text-slate-500">No expenses in this period.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </SectionCard>
          )}

          {!filter.productId && <BranchComparison />}

          {report.stockPurchases.count > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
              <span className="font-semibold">Cash spent on stock: {money(report.stockPurchases.amount)}</span> across {report.stockPurchases.count} purchase order(s) placed in this period. It lowers money available but is not an expense in this P&amp;L; it becomes cost of goods when the stock sells.
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <div className="mb-1 font-semibold text-slate-700">About this report</div>
            <ul className="list-disc space-y-0.5 pl-4">
              {report.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
