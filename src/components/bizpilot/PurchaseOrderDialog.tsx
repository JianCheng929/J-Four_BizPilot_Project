import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { money } from '@/lib/format';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Field, SimpleSelect, dialogWide, fromDateInput, num, primaryBtn, toDateInput } from './common';
import { draftPOForApproval } from './actions';
import * as ops from '@/lib/ops';

interface Line {
  productId: string;
  quantity: string;
  unitCost: string;
}

export function PurchaseOrderDialog({
  open,
  onOpenChange,
  supplierId: initialSupplier,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplierId?: string | null;
}) {
  const { db, run } = useBizPilot();
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [expected, setExpected] = useState('');
  const [note, setNote] = useState('');
  const activeLocations = db.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState<string>(() => db.locations.find((l) => l.isDefault && l.active)?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  const supplier = db.suppliers.find((s) => s.id === supplierId);

  useEffect(() => {
    if (!open) return;
    setSupplierId(initialSupplier ?? '');
    setLines([{ productId: '', quantity: '', unitCost: '' }]);
    setNote('');
    setError(null);
    setExpected('');
  }, [open, initialSupplier]);

  const leadDays = supplier?.leadTimeDays;
  useEffect(() => {
    if (leadDays !== undefined) setExpected(toDateInput(new Date(Date.now() + leadDays * 86400000).toISOString()));
  }, [supplierId, leadDays]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const total = lines.reduce((s, l) => s + (num(l.quantity) || 0) * (num(l.unitCost) || 0), 0);

  const submit = (forApproval: boolean) => {
    if (!supplier) return setError('Choose a supplier.');
    const parsed = lines.filter((l) => l.productId);
    if (!parsed.length) return setError('Add at least one product line.');
    for (const l of parsed) {
      const q = num(l.quantity);
      const c = num(l.unitCost);
      if (!(q > 0) || !Number.isInteger(q)) return setError('Each line needs a whole quantity above 0.');
      if (!(c >= 0)) return setError('Each line needs a unit cost (0 or more).');
    }
    const totalQty = parsed.reduce((s, l) => s + Number(l.quantity), 0);
    if (supplier.minOrderQty && totalQty < supplier.minOrderQty) {
      return setError(`${supplier.name} has a minimum order of ${supplier.minOrderQty} units (this PO has ${totalQty}).`);
    }
    const input: ops.POInput = {
      supplierId: supplier.id,
      lines: parsed.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) })),
      note: note.trim(),
      expectedDate: expected ? fromDateInput(expected) : undefined,
      locationId: locationId || null,
    };
    const res = forApproval
      ? run((d, a) => draftPOForApproval(d, input, a), 'PO sent to Approvals')
      : run((d, a) => ops.createPurchaseOrder(d, input, a, 'draft'), 'Draft PO saved');
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>New purchase order</DialogTitle>
          <DialogDescription>Nothing is sent to the supplier until the PO is approved.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Supplier">
              <SimpleSelect
                value={supplierId}
                onChange={setSupplierId}
                placeholder="Choose supplier"
                options={db.suppliers.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
            <Field label="Expected delivery" hint={supplier ? `Lead time ${supplier.leadTimeDays} days` : undefined}>
              <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </Field>
            {activeLocations.length > 1 && (
              <Field label="Deliver to">
                <SimpleSelect value={locationId} onChange={setLocationId} options={activeLocations.map((l) => ({ value: l.id, label: l.name }))} />
              </Field>
            )}
          </div>
          <div className="rounded-md border border-slate-200">
            <div className="grid grid-cols-[1fr_90px_110px_90px_32px] gap-2 border-b bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-500">
              <span>Product</span>
              <span>Qty</span>
              <span>Unit cost (RM)</span>
              <span className="text-right">Line total</span>
              <span />
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_90px_110px_90px_32px] items-center gap-2 px-3 py-2">
                <SimpleSelect
                  size="sm"
                  value={l.productId}
                  onChange={(v) => {
                    const p = db.products.find((x) => x.id === v);
                    setLine(i, { productId: v, unitCost: l.unitCost || String(p?.unitCost || supplier?.unitCost || 0) });
                  }}
                  placeholder="Product"
                  options={db.products.map((p) => ({ value: p.id, label: `${p.name} (${p.sku})` }))}
                />
                <Input className="h-8" type="number" min="1" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                <Input className="h-8" type="number" min="0" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} />
                <span className="text-right text-sm">{money((num(l.quantity) || 0) * (num(l.unitCost) || 0))}</span>
                <Button size="icon-sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex items-center justify-between border-t px-3 py-2">
              <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { productId: '', quantity: '', unitCost: '' }])}>
                <Plus className="mr-1 h-4 w-4" /> Add line
              </Button>
              <span className="text-sm font-semibold">Total {money(total)}</span>
            </div>
          </div>
          <Field label="Note to supplier (optional)">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => submit(false)}>
            Save as draft
          </Button>
          <Button className={primaryBtn} onClick={() => submit(true)}>
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
