import { useState } from 'react';
import { ClipboardList, EyeOff, Plus, Send, X } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { StockCount } from '@/lib/db/types';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, SectionCard, SimpleSelect, StatusPill, primaryBtn } from './common';
import { ScanInput } from './BarcodeScanner';
import { toast } from 'sonner';

const ALL = '__all__';

/** Blueprint B4: scheduled/blind stock counts, comparison with the system and approval of differences. */
export function StockCountsTab() {
  const { db, run } = useBizPilot();
  const active = db.locations.filter((l) => l.active);
  const [location, setLocation] = useState<string>(active.find((l) => l.isDefault)?.id ?? ALL);
  const [blind, setBlind] = useState(true);
  const [openId, setOpenId] = useState<string | null>(db.stockCounts.find((c) => c.status === 'open')?.id ?? null);
  const where = (c: StockCount) => (c.locationId ? db.locations.find((l) => l.id === c.locationId)?.name ?? 'location' : 'All stock');
  const current = db.stockCounts.find((c) => c.id === openId) ?? null;

  const start = () => {
    const c = run((d, a) => ops.startStockCount(d, { locationId: location === ALL ? '' : location, blind }, a), 'Count sheet ready');
    if (c) setOpenId(c.id);
  };

  return (
    <div className="space-y-4">
      <SectionCard title="Start a stock count" description="Staff count what is on the shelf; differences go to Approvals before stock changes.">
        <div className="flex flex-wrap items-end gap-3">
          {active.length > 0 && (
            <div className="w-56">
              <Label className="mb-1 block text-xs text-slate-500">Location</Label>
              <SimpleSelect value={location} onChange={setLocation} options={active.map((l) => ({ value: l.id, label: l.name }))} />
            </div>
          )}
          <div className="flex items-center gap-2 pb-2">
            <Switch id="blind" checked={blind} onCheckedChange={setBlind} />
            <Label htmlFor="blind" className="text-sm">Blind count (hide system quantities from the counter)</Label>
          </div>
          <Button className={primaryBtn} onClick={start}><Plus className="mr-1 h-4 w-4" /> New count sheet</Button>
        </div>
      </SectionCard>

      {current && current.status === 'open' && <CountSheet count={current} where={where(current)} onClose={() => setOpenId(null)} />}

      <SectionCard title="Count history">
        {db.stockCounts.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No counts yet" body="Start a count sheet above. Counting regularly finds theft, damage and data-entry mistakes early." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Count</TableHead><TableHead>Where</TableHead><TableHead>Counted</TableHead><TableHead>Differences</TableHead><TableHead>Status</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {db.stockCounts.slice(0, 100).map((c) => {
                const counted = c.lines.filter((l) => l.counted !== null);
                const diffs = counted.filter((l) => l.counted !== l.expected);
                return (
                  <TableRow key={c.id}>
                    <TableCell className="whitespace-nowrap"><div className="font-medium">{c.countNumber}{c.blind && <EyeOff className="ml-1 inline h-3.5 w-3.5 text-slate-400" />}</div><div className="text-xs text-slate-400">{fmtDateTime(c.createdAt)} · {c.createdBy}</div></TableCell>
                    <TableCell>{where(c)}</TableCell>
                    <TableCell>{counted.length} of {c.lines.length}</TableCell>
                    <TableCell className="text-xs">{diffs.length ? diffs.slice(0, 3).map((l) => `${db.products.find((p) => p.id === l.productId)?.name ?? 'item'} ${(l.counted ?? 0) - l.expected > 0 ? '+' : ''}${(l.counted ?? 0) - l.expected}`).join(', ') + (diffs.length > 3 ? ` +${diffs.length - 3} more` : '') : '—'}</TableCell>
                    <TableCell><StatusPill status={c.status} label={c.status === 'submitted' ? 'waiting for approval' : undefined} /></TableCell>
                    <TableCell className="text-right">
                      {c.status === 'open' && c.id !== openId && <Button size="sm" variant="outline" onClick={() => setOpenId(c.id)}>Continue</Button>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

function CountSheet({ count, where, onClose }: { count: StockCount; where: string; onClose: () => void }) {
  const { db, run } = useBizPilot();
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(count.lines.map((l) => [l.productId, l.counted === null ? '' : String(l.counted)])));
  const [q, setQ] = useState('');
  const lines = count.lines.filter((l) => {
    if (!q) return true;
    const p = db.products.find((x) => x.id === l.productId);
    return `${p?.name} ${p?.sku} ${p?.barcode}`.toLowerCase().includes(q.toLowerCase());
  });
  const save = (productId: string) => {
    const v = values[productId];
    const counted = v === '' || v === undefined ? null : Math.floor(Number(v));
    const line = count.lines.find((l) => l.productId === productId);
    if (line && line.counted !== counted) run((d) => ops.recordCount(d, count.id, productId, counted));
  };
  const submit = () => {
    const done = run((d, a) => {
      // Save every entered value first, then submit, in one change.
      for (const l of count.lines) {
        const v = values[l.productId];
        ops.recordCount(d, count.id, l.productId, v === '' || v === undefined ? null : Math.floor(Number(v)));
      }
      return ops.submitStockCount(d, count.id, a);
    });
    if (done) onClose();
  };
  const entered = Object.values(values).filter((v) => v !== '').length;
  // Each scan adds one unit of that product to its count.
  const scan = (code: string) => {
    const p = ops.findByCode(db, code);
    const line = p && count.lines.find((l) => l.productId === p.id);
    if (!p || !line) return toast.error(p ? `${p.name} is not on this count.` : `No product with code "${code}".`);
    const n = (Number(values[p.id]) || 0) + 1;
    setValues((s) => ({ ...s, [p.id]: String(n) }));
    run((d) => ops.recordCount(d, count.id, p.id, n));
    toast.success(`${p.name}: ${n}`);
  };
  return (
    <SectionCard
      title={`${count.countNumber} · ${where}`}
      description={`${entered} of ${count.lines.length} counted${count.blind ? ' · blind count: system quantities are hidden' : ''}. Leave a product empty to skip it.`}
      actions={
        <>
          <Input className="h-8 w-48" placeholder="Find product or scan barcode" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button size="sm" variant="ghost" onClick={() => window.confirm(`Cancel ${count.countNumber}?`) && run((d, a) => { ops.cancelStockCount(d, count.id, a); return true; }, 'Count cancelled') && onClose()}><X className="mr-1 h-4 w-4" /> Cancel count</Button>
          <Button size="sm" className={primaryBtn} disabled={!entered} onClick={submit}><Send className="mr-1 h-4 w-4" /> Submit count</Button>
        </>
      }
    >
      <ScanInput onScan={scan} placeholder="Scan each item: every scan adds 1" className="mb-3 max-w-md" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            {!count.blind && <TableHead className="text-right">System</TableHead>}
            <TableHead className="w-32 text-right">Counted</TableHead>
            {!count.blind && <TableHead className="text-right">Difference</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => {
            const p = db.products.find((x) => x.id === l.productId);
            const v = values[l.productId] ?? '';
            const diff = v === '' ? null : Math.floor(Number(v)) - l.expected;
            return (
              <TableRow key={l.productId}>
                <TableCell>{p?.name ?? 'item'} <span className="text-xs text-slate-400">{p?.sku}</span></TableCell>
                {!count.blind && <TableCell className="text-right tabular-nums">{l.expected}</TableCell>}
                <TableCell className="text-right">
                  <Input type="number" min={0} className="ml-auto h-8 w-24 text-right" value={v} onChange={(e) => setValues((x) => ({ ...x, [l.productId]: e.target.value }))} onBlur={() => save(l.productId)} />
                </TableCell>
                {!count.blind && <TableCell className={`text-right tabular-nums ${diff ? (diff < 0 ? 'text-red-600' : 'text-teal-700') : 'text-slate-400'}`}>{diff === null ? '' : diff > 0 ? `+${diff}` : diff}</TableCell>}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
