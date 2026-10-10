import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, ClipboardCheck, PackageCheck, Play, Plus, Truck } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { StaffTask } from '@/lib/db/types';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { EmptyState, Field, Kpi, Pill, SectionCard, SimpleSelect, fromDateInput, primaryBtn } from './common';
import { ScanInput } from './BarcodeScanner';

const KIND_LABEL: Record<StaffTask['kind'], string> = { pick: 'Pick', pack: 'Pack', put_away: 'Put away', count: 'Count', receive: 'Receive', deliver: 'Deliver', other: 'Other' };
const STAGE: Record<string, { label: string; tone: string }> = {
  waiting: { label: 'waiting', tone: 'slate' }, picking: { label: 'picking', tone: 'amber' }, picked: { label: 'picked', tone: 'blue' }, packed: { label: 'packed', tone: 'green' },
};

/** Pick and pack: one pick list sorted by shelf, scan to check each item, then pack and hand over. */
function PickPack() {
  const { db, run, can } = useBizPilot();
  const [scanned, setScanned] = useState<Record<string, number>>({});
  const waiting = db.salesOrders.filter((o) => o.status === 'awaiting_fulfilment');
  const { lines } = ops.pickList(db);
  const picking = waiting.filter((o) => o.pickStatus === 'picking');
  const packed = waiting.filter((o) => o.pickStatus === 'packed');

  const scan = (code: string) => {
    const p = ops.findByCode(db, code);
    if (!p) return toast.error(`No product with barcode or SKU "${code}".`);
    const line = lines.find((l) => l.product.id === p.id);
    if (!line) return toast.error(`${p.name} is not on the pick list.`);
    const n = (scanned[p.id] ?? 0) + 1;
    if (n > line.quantity) return toast.error(`Too many ${p.name}: the list needs ${line.quantity}.`);
    setScanned((s) => ({ ...s, [p.id]: n }));
    toast.success(`${p.name}: ${n} of ${line.quantity}${line.bin ? ` (bin ${line.bin})` : ''}`);
  };

  const finishPick = () => {
    const done = lines.filter((l) => (scanned[l.product.id] ?? 0) >= l.quantity);
    const orders = waiting.filter((o) => o.pickStatus !== 'picked' && o.pickStatus !== 'packed' && o.lines.every((ol) => !ol.productId || done.some((d) => d.product.id === ol.productId)));
    if (!orders.length) return toast.error('Scan every item of at least one order first.');
    run((d, a) => orders.map((o) => ops.markPicked(d, o.id, a)), `${orders.length} order(s) picked`);
    setScanned({});
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi icon={ClipboardCheck} label="Waiting to pick" value={String(waiting.filter((o) => !o.pickStatus).length)} />
        <Kpi icon={Play} label="Being picked" value={String(picking.length)} tone="amber" />
        <Kpi icon={PackageCheck} label="Packed, ready to go" value={String(packed.length)} tone="teal" />
        <Kpi icon={Truck} label="Items on the pick list" value={String(lines.reduce((s, l) => s + l.quantity, 0))} tone="slate" />
      </div>

      <SectionCard
        title="Pick list"
        description="Every item still to take off the shelf, sorted by bin so staff walk the aisles once. Scan each item to check it is the right product and quantity."
        actions={can.write && (
          <Button size="sm" className={primaryBtn} disabled={!waiting.some((o) => !o.pickStatus)} onClick={() => run((d, a) => ops.startPickRun(d, undefined, a).task, 'Pick run started: task created for staff')}>
            <Play className="mr-1 h-4 w-4" /> Start pick run
          </Button>
        )}
      >
        {lines.length === 0 ? (
          <div className="py-4 text-center text-sm text-slate-500">Nothing to pick. Orders appear here when they are waiting to be shipped or handed over.</div>
        ) : (
          <>
            <ScanInput onScan={scan} className="mb-3 max-w-md" />
            <Table>
              <TableHeader><TableRow><TableHead>Bin</TableHead><TableHead>Product</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Scanned</TableHead><TableHead>For orders</TableHead></TableRow></TableHeader>
              <TableBody>
                {lines.map((l) => {
                  const n = scanned[l.product.id] ?? 0;
                  return (
                    <TableRow key={`${l.product.id}-${l.orders.join()}`} className={cn(n >= l.quantity && 'bg-teal-50/60')}>
                      <TableCell className="font-mono text-xs">{l.bin || <span className="text-amber-700">no bin</span>}</TableCell>
                      <TableCell className="text-sm">{l.product.name}<div className="text-[11px] text-slate-400">{l.product.sku}{l.product.barcode ? ` · ${l.product.barcode}` : ''}</div></TableCell>
                      <TableCell className="text-right font-medium">{l.quantity}</TableCell>
                      <TableCell className="text-right">{n >= l.quantity ? <CheckCircle2 className="ml-auto h-4 w-4 text-teal-700" /> : `${n}/${l.quantity}`}</TableCell>
                      <TableCell className="text-xs text-slate-500">{l.orders.join(', ')}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {can.write && <div className="mt-3 flex justify-end"><Button size="sm" variant="outline" onClick={finishPick}><CheckCircle2 className="mr-1 h-4 w-4" /> Mark scanned orders picked</Button></div>}
          </>
        )}
      </SectionCard>

      <SectionCard title="Orders in the warehouse" description="Picked orders get packed and labelled; packed orders are handed to the courier or customer.">
        {waiting.length === 0 ? <div className="py-4 text-center text-sm text-slate-500">No orders waiting.</div> : (
          <Table>
            <TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Customer</TableHead><TableHead>Items</TableHead><TableHead>Stage</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {waiting.map((o) => {
                const stage = STAGE[o.pickStatus ?? 'waiting'];
                return (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.orderNumber}<div className="text-[11px] text-slate-400">{fmtDateTime(o.date)}</div></TableCell>
                    <TableCell className="text-sm">{o.customerName || 'Walk-in'}{o.shipment?.courier && <div className="text-[11px] text-slate-400">{o.shipment.courier}</div>}</TableCell>
                    <TableCell className="text-xs">{o.lines.map((l) => `${l.quantity}× ${l.name ?? db.products.find((p) => p.id === l.productId)?.name ?? 'item'}`).join(', ')}</TableCell>
                    <TableCell><Pill tone={stage.tone}>{stage.label}</Pill></TableCell>
                    <TableCell className="text-right">
                      {can.write && (
                        <div className="flex justify-end gap-1">
                          {o.pickStatus !== 'picked' && o.pickStatus !== 'packed' && <Button size="sm" variant="outline" onClick={() => run((d, a) => ops.markPicked(d, o.id, a), `${o.orderNumber} picked`)}>Picked</Button>}
                          {o.pickStatus !== 'packed' && <Button size="sm" variant="outline" onClick={() => run((d, a) => ops.markPacked(d, o.id, a), `${o.orderNumber} packed`)}>Packed</Button>}
                          {o.pickStatus === 'packed' && <Button size="sm" className={primaryBtn} onClick={() => run((d, a) => ops.fulfilSalesOrder(d, o.id, a), `${o.orderNumber} handed over`)}>Handed over</Button>}
                        </div>
                      )}
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

function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { db, run } = useBizPilot();
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [kind, setKind] = useState<StaffTask['kind']>('other');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [loc, setLoc] = useState('');
  const save = () => {
    const t = run((d, a) => ops.addStaffTask(d, { title, detail, kind, assignee, dueDate: due ? fromDateInput(due) : null, locationId: loc }, a), 'Task created');
    if (t) { onOpenChange(false); setTitle(''); setDetail(''); setAssignee(''); setDue(''); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New staff task</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="What needs doing" className="col-span-2"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Put away the SupplyBunny delivery" /></Field>
          <Field label="Type"><SimpleSelect value={kind} onChange={(v) => setKind(v as StaffTask['kind'])} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} /></Field>
          <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Assign to (email, empty = anyone)"><Input value={assignee} onChange={(e) => setAssignee(e.target.value)} /></Field>
          {db.locations.length > 0 && <Field label="Where"><SimpleSelect value={loc || '__any'} onChange={(v) => setLoc(v === '__any' ? '' : v)} options={[{ value: '__any', label: 'Any location' }, ...db.locations.map((l) => ({ value: l.id, label: l.name }))]} /></Field>}
          <Field label="Details" className="col-span-2"><Textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button className={primaryBtn} disabled={!title.trim()} onClick={save}>Create task</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Staff tasks: created by BizPilot from the records (receive, count, pick) or by hand. */
export function StaffTasks() {
  const { db, run, can, actor } = useBizPilot();
  const [view, setView] = useState<'open' | 'mine' | 'done'>('open');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());
  const tasks = db.staffTasks ?? [];
  const me = actor.toLowerCase();
  const list = tasks.filter((t) => (view === 'done' ? t.status === 'done' || t.status === 'cancelled' : (t.status === 'open' || t.status === 'in_progress') && (view === 'open' || !t.assignee || t.assignee === me)));
  const where = (id: string) => db.locations.find((l) => l.id === id)?.name;
  const set = (t: StaffTask, status: StaffTask['status']) => run((d, a) => ops.updateStaffTask(d, t.id, { status }, a), `${t.taskNumber} ${status.replace('_', ' ')}`);
  return (
    <SectionCard
      title="Staff tasks"
      description="BizPilot creates a task when stock is on its way (receive), a count starts, or orders need picking; it closes the task when the records show the work is done."
      actions={
        <>
          <div className="w-36"><SimpleSelect value={view} onChange={(v) => setView(v as typeof view)} options={[{ value: 'open', label: 'All open' }, { value: 'mine', label: 'Mine' }, { value: 'done', label: 'Done' }]} /></div>
          {can.write && <Button size="sm" className={primaryBtn} onClick={() => setCreating(true)}><Plus className="mr-1 h-4 w-4" /> New task</Button>}
        </>
      }
    >
      {list.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={view === 'done' ? 'No finished tasks yet' : 'Nothing to do'} body="Tasks appear when deliveries are on the way, counts start or orders need picking." />
      ) : (
        <div className="space-y-2">
          {list.slice(0, 100).map((t) => {
            const late = t.dueDate && t.status !== 'done' && new Date(t.dueDate).getTime() < nowMs;
            return (
              <div key={t.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="slate">{KIND_LABEL[t.kind]}</Pill>
                  <button className="min-w-0 flex-1 text-left text-sm font-medium hover:underline" onClick={() => setOpenId(openId === t.id ? null : t.id)}>{t.title}</button>
                  <span className="text-[11px] text-slate-400">{t.taskNumber}{t.assignee ? ` · ${t.assignee}` : ' · anyone'}{t.locationId && where(t.locationId) ? ` · ${where(t.locationId)}` : ''}</span>
                  {t.dueDate && <span className={cn('text-[11px]', late ? 'font-medium text-red-600' : 'text-slate-500')}>due {fmtDate(t.dueDate)}</span>}
                  {can.write && t.status === 'open' && <Button size="sm" variant="outline" onClick={() => set(t, 'in_progress')}>Start</Button>}
                  {can.write && (t.status === 'open' || t.status === 'in_progress') && <Button size="sm" className={primaryBtn} onClick={() => set(t, 'done')}>Done</Button>}
                  {t.status === 'done' && <span className="text-[11px] text-teal-700">done {t.completedAt ? fmtDateTime(t.completedAt) : ''} by {t.doneBy}</span>}
                </div>
                {openId === t.id && t.detail && <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-xs text-slate-700">{t.detail}</pre>}
                {openId === t.id && can.write && t.status !== 'done' && t.status !== 'cancelled' && (
                  <div className="mt-2 text-right"><Button size="sm" variant="ghost" className="text-red-600" onClick={() => set(t, 'cancelled')}>Cancel task</Button></div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <NewTaskDialog open={creating} onOpenChange={setCreating} />
    </SectionCard>
  );
}

/** Bins: where each product lives on the shelves, per location. */
function Bins() {
  const { db, run, can } = useBizPilot();
  const [loc, setLoc] = useState(db.locations.find((l) => l.isDefault)?.id ?? '');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const products = db.products.filter((p) => p.status !== 'discontinued' && (!q || `${p.name} ${p.sku} ${p.barcode}`.toLowerCase().includes(q.toLowerCase())));
  const save = (pid: string, value: string) => {
    run((d, a) => ops.setBin(d, pid, loc || null, value, a), 'Bin saved');
    setEdit((e) => { const n = { ...e }; delete n[pid]; return n; });
  };
  const missing = db.products.filter((p) => p.status !== 'discontinued' && p.stock > 0 && !ops.binOf(db, p, loc || null)).length;
  return (
    <SectionCard
      title="Bins and shelves"
      description={`Give each product a bin code (aisle-shelf-level, e.g. A-01-03) so pick lists follow the shelves.${missing ? ` ${missing} product(s) in stock have no bin.` : ''}`}
      actions={db.locations.length > 0 && <div className="w-44"><SimpleSelect value={loc} onChange={setLoc} options={db.locations.map((l) => ({ value: l.id, label: l.name }))} /></div>}
    >
      <ScanInput onScan={(c) => { const p = ops.findByCode(db, c); if (p) setQ(p.sku); else toast.error(`No product with code "${c}".`); }} placeholder="Scan a product to find it, or type to filter" className="mb-3 max-w-md" />
      {q && <button className="mb-2 text-xs text-teal-700 hover:underline" onClick={() => setQ('')}>Show all products</button>}
      <div className="max-h-[420px] overflow-y-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Product</TableHead><TableHead className="text-right">On hand here</TableHead><TableHead className="w-40">Bin</TableHead></TableRow></TableHeader>
          <TableBody>
            {products.slice(0, 300).map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-sm">{p.name}<div className="text-[11px] text-slate-400">{p.sku}</div></TableCell>
                <TableCell className="text-right">{ops.stockAt(db, p, loc || null)}</TableCell>
                <TableCell>
                  <Input className="h-8 font-mono uppercase" disabled={!can.write} placeholder="e.g. A-01-03" value={edit[p.id] ?? ops.binOf(db, p, loc || null)}
                    onChange={(e) => setEdit((s) => ({ ...s, [p.id]: e.target.value }))}
                    onBlur={(e) => edit[p.id] !== undefined && save(p.id, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

/** Blueprint §5 A3: warehouse work (bins, pick and pack, staff tasks) with barcode scanning. */
export function WarehouseTab() {
  return (
    <div className="space-y-4">
      <PickPack />
      <StaffTasks />
      <Bins />
    </div>
  );
}
