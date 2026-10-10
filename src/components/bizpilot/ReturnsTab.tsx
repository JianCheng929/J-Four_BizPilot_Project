import { useEffect, useMemo, useState } from 'react';
import { Plus, Undo2 } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { returnStats } from '@/lib/metrics';
import { fmtDate, money } from '@/lib/format';
import type { ReturnCase } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Field, NONE, Pill, SectionCard, SimpleSelect, dialogWide, num, primaryBtn } from './common';

/** Blueprint A6: returns and reverse logistics. */

const REASONS: { value: ReturnCase['reason']; label: string }[] = [
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'defective', label: 'Defective / not working' },
  { value: 'wrong_item', label: 'Wrong item sent' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'expired', label: 'Expired' },
  { value: 'changed_mind', label: 'Changed mind' },
  { value: 'other', label: 'Other' },
];
const CONDITIONS: { value: ReturnCase['condition']; label: string }[] = [
  { value: 'unopened', label: 'Unopened, resellable' },
  { value: 'opened', label: 'Opened' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'defective', label: 'Defective' },
];
const RESOLUTIONS: { value: NonNullable<ReturnCase['resolution']>; label: string; hint: string }[] = [
  { value: 'restock', label: 'Put back in stock', hint: 'Adds the units back as sellable stock.' },
  { value: 'quarantine', label: 'Quarantine for inspection', hint: 'Adds them to stock as held (not sellable).' },
  { value: 'dispose', label: 'Dispose', hint: 'Goods are thrown away; stock does not change.' },
  { value: 'supplier_return', label: 'Send back to supplier', hint: 'Goods go to the supplier; stock does not change.' },
];
const reasonLabel = (r: string) => REASONS.find((x) => x.value === r)?.label ?? r;

function NewReturnDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { db, run } = useBizPilot();
  const [f, setF] = useState({ orderId: NONE, productId: NONE, customerName: '', quantity: '1', reason: 'damaged' as ReturnCase['reason'], condition: 'damaged' as ReturnCase['condition'], notes: '' });
  useEffect(() => {
    if (open) setF({ orderId: NONE, productId: NONE, customerName: '', quantity: '1', reason: 'damaged', condition: 'damaged', notes: '' });
  }, [open]);
  const order = db.salesOrders.find((o) => o.id === f.orderId);
  const productOptions = order
    ? order.lines.filter((l) => l.productId).map((l) => ({ value: l.productId!, label: `${db.products.find((p) => p.id === l.productId)?.name ?? l.name ?? 'item'} (×${l.quantity})` }))
    : db.products.map((p) => ({ value: p.id, label: p.name }));

  const save = () => {
    const res = run(
      (d, a) =>
        ops.createReturn(d, {
          orderId: f.orderId === NONE ? null : f.orderId,
          productId: f.productId === NONE ? null : f.productId,
          customerName: f.customerName,
          quantity: num(f.quantity),
          reason: f.reason,
          condition: f.condition,
          notes: f.notes,
        }, a),
      'Return recorded',
    );
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>Record a customer return</DialogTitle>
          <DialogDescription>Log what came back and why. You decide what happens to the goods and any refund when you close it.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Order (optional)" className="sm:col-span-2">
            <SimpleSelect
              value={f.orderId}
              onChange={(v) => setF({ ...f, orderId: v, productId: NONE, customerName: db.salesOrders.find((o) => o.id === v)?.customerName ?? f.customerName })}
              options={[{ value: NONE, label: 'No order / walk-in' }, ...db.salesOrders.filter((o) => o.status !== 'cancelled').slice(0, 200).map((o) => ({ value: o.id, label: `${o.orderNumber} · ${o.customerName || 'customer'} · ${money(o.total)} · ${fmtDate(o.date)}` }))]}
            />
          </Field>
          <Field label="Product">
            <SimpleSelect value={f.productId} onChange={(v) => setF({ ...f, productId: v })} options={[{ value: NONE, label: 'Choose product' }, ...productOptions]} />
          </Field>
          <Field label="Quantity returned">
            <Input type="number" min="1" step="1" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
          </Field>
          <Field label="Customer">
            <Input value={f.customerName} onChange={(e) => setF({ ...f, customerName: e.target.value })} />
          </Field>
          <Field label="Reason">
            <SimpleSelect value={f.reason} onChange={(v) => setF({ ...f, reason: v as ReturnCase['reason'] })} options={REASONS} />
          </Field>
          <Field label="Condition of the goods">
            <SimpleSelect value={f.condition} onChange={(v) => setF({ ...f, condition: v as ReturnCase['condition'] })} options={CONDITIONS} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. seal broken, photo sent on WhatsApp" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className={primaryBtn} onClick={save} disabled={f.productId === NONE}>Record return</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({ ret, onOpenChange }: { ret: ReturnCase | null; onOpenChange: (o: boolean) => void }) {
  const { db, run } = useBizPilot();
  const [resolution, setResolution] = useState<NonNullable<ReturnCase['resolution']>>('restock');
  const [refund, setRefund] = useState('0');
  const product = ret ? db.products.find((p) => p.id === ret.productId) : undefined;
  const order = ret?.orderId ? db.salesOrders.find((o) => o.id === ret.orderId) : undefined;
  const linePrice = order?.lines.find((l) => l.productId === ret?.productId)?.unitPrice ?? product?.price ?? 0;
  useEffect(() => {
    if (!ret) return;
    setResolution(ret.condition === 'unopened' ? 'restock' : ret.reason === 'defective' ? 'supplier_return' : 'quarantine');
    setRefund(ret.reason === 'changed_mind' ? '0' : (linePrice * ret.quantity).toFixed(2));
  }, [ret, linePrice]);
  if (!ret) return null;
  const save = () => {
    const res = run((d, a) => ops.resolveReturn(d, ret.id, resolution, num(refund) || 0, a), num(refund) > 0 ? 'Return closed. Refund sent to Approvals' : 'Return closed');
    if (res) onOpenChange(false);
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close {ret.returnNumber}</DialogTitle>
          <DialogDescription>
            {ret.quantity} × {product?.name ?? 'item'} · {reasonLabel(ret.reason)} · {ret.condition}
            {order ? ` · ${order.orderNumber} (${money(order.total)})` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="What happens to the goods" hint={RESOLUTIONS.find((r) => r.value === resolution)?.hint}>
            <SimpleSelect value={resolution} onChange={(v) => setResolution(v as NonNullable<ReturnCase['resolution']>)} options={RESOLUTIONS} />
          </Field>
          <Field label="Refund to customer (RM)" hint="0 = no refund. Refunds wait in Approvals and are recorded as a Refunds expense when approved.">
            <Input type="number" min="0" step="0.01" value={refund} onChange={(e) => setRefund(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className={primaryBtn} onClick={save}>Close return</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReturnsTab() {
  const { db, run } = useBizPilot();
  const [newOpen, setNewOpen] = useState(false);
  const [resolving, setResolving] = useState<ReturnCase | null>(null);
  const stats = useMemo(() => returnStats(db), [db]);

  return (
    <div className="space-y-4">
      {db.returns.length === 0 ? (
        <EmptyState
          icon={Undo2}
          title="No returns yet"
          body="Record customer returns here: why they came back, the condition, and whether the goods go back to stock, to quarantine, to the supplier or get disposed. Refunds go to Approvals."
          actionLabel="Record a return"
          onAction={() => setNewOpen(true)}
        />
      ) : (
        <>
          {stats.total > 0 && (
            <SectionCard title="Return patterns" description={`Last ${stats.days} days · ${stats.total} return(s) · ${stats.open} open`}>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">Top reasons (units)</div>
                  {stats.reasons.map(([r, n]) => (
                    <div key={r} className="flex justify-between text-sm"><span>{reasonLabel(r)}</span><span className="tabular-nums">{n}</span></div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">Most returned products</div>
                  {stats.products.slice(0, 5).map((p) => (
                    <div key={p.productId} className="flex justify-between text-sm">
                      <span>{db.products.find((x) => x.id === p.productId)?.name ?? 'item'}</span>
                      <span className="tabular-nums">{p.returned}{p.ratePct !== null ? ` (${p.ratePct}% of ${p.sold} sold)` : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            </SectionCard>
          )}
          <SectionCard
            title="Returns"
            description="Restocked items go back to sellable stock; quarantined items are held until checked."
            actions={<Button size="sm" className={primaryBtn} onClick={() => setNewOpen(true)}><Plus className="mr-1 h-4 w-4" /> Record return</Button>}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Return</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Refund</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {db.returns.map((r) => {
                    const p = db.products.find((x) => x.id === r.productId);
                    const o = db.salesOrders.find((x) => x.id === r.orderId);
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <div className="font-medium">{r.returnNumber}</div>
                          <div className="text-[11px] text-slate-500">{fmtDate(r.createdAt)}{o ? ` · ${o.orderNumber}` : ''}{r.customerName ? ` · ${r.customerName}` : ''}</div>
                        </TableCell>
                        <TableCell>{r.quantity} × {p?.name ?? 'item'}</TableCell>
                        <TableCell className="text-sm">
                          {reasonLabel(r.reason)}
                          <div className="text-[11px] text-slate-500">{r.condition}{r.notes ? ` · ${r.notes}` : ''}</div>
                        </TableCell>
                        <TableCell>
                          <Pill tone={r.status === 'open' ? 'amber' : r.status === 'rejected' ? 'slate' : 'green'}>
                            {r.status === 'resolved' ? (r.resolution ?? 'resolved').replace('_', ' ') : r.status}
                          </Pill>
                        </TableCell>
                        <TableCell className="text-right">
                          {r.refundAmount > 0 ? money(r.refundAmount) : '—'}
                          {r.refundStatus === 'pending_approval' && <div className="text-[11px] text-amber-700">awaiting approval</div>}
                          {r.refundStatus === 'refunded' && <div className="text-[11px] text-teal-700">refunded</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.status === 'open' && (
                            <div className="flex justify-end gap-1">
                              <Button size="sm" className={primaryBtn} onClick={() => setResolving(r)}>Close</Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  const why = window.prompt('Why is this return rejected?');
                                  if (why) run((d, a) => ops.rejectReturn(d, r.id, why, a), 'Return rejected');
                                }}
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        </>
      )}
      <NewReturnDialog open={newOpen} onOpenChange={setNewOpen} />
      <ResolveDialog ret={resolving} onOpenChange={(o) => !o && setResolving(null)} />
    </div>
  );
}
