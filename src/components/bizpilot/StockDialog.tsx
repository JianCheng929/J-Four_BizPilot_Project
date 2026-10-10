import { useEffect, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field, SimpleSelect, num, primaryBtn } from './common';
import { money } from '@/lib/format';

export type StockMode = 'in' | 'out' | 'count' | 'hold';

const HOLD_REASONS = ['Damaged', 'Expired', 'Quarantined for inspection', 'Customer return awaiting check', 'Other'];

const IN_REASONS = ['Purchase received', 'Customer return', 'Transfer in', 'Production', 'Other'];
const OUT_REASONS = ['Damaged', 'Expired', 'Lost', 'Own use / sample', 'Transfer out', 'Other'];

export function StockDialog({
  open,
  onOpenChange,
  mode,
  productId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: StockMode;
  productId?: string | null;
}) {
  const { db, run, requestApproval } = useBizPilot();
  const [pid, setPid] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blind, setBlind] = useState(false);

  useEffect(() => {
    if (open) {
      setPid(productId ?? '');
      setQty('');
      setReason(mode === 'in' ? IN_REASONS[0] : mode === 'out' ? OUT_REASONS[0] : mode === 'hold' ? HOLD_REASONS[0] : 'Stock count');
      setBlind(false);
      setOther('');
      setReference('');
      setError(null);
    }
  }, [open, productId, mode]);

  const product = db.products.find((p) => p.id === pid);
  const n = num(qty);
  const diff = mode === 'count' && product && Number.isFinite(n) ? n - product.stock : 0;

  const submit = () => {
    if (!product) return setError('Choose a product.');
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return setError('Enter a whole number of units (0 or more).');
    const why = reason === 'Other' ? other.trim() : reason;
    if (!why) return setError('Give a reason.');
    if (mode === 'hold') {
      if (n > product.stock) return setError(`Only ${product.stock} on hand.`);
      const res = run((d, a) => ops.setHeldStock(d, product.id, n, why, a), n ? `${n} × ${product.name} held as not sellable` : `${product.name}: no stock held`);
      if (res) onOpenChange(false);
      return;
    }
    if (mode === 'count') {
      if (diff === 0) {
        setError(null);
        run((d, a) => ops.audit(d, a, 'stock_count', 'product', product.sku, `Counted ${n}, matches system`), 'Count matches — no adjustment needed');
        onOpenChange(false);
        return;
      }
      const res = requestApproval({
        type: 'stock_adjustment',
        title: `Stock count correction: ${product.name} (${diff > 0 ? '+' : ''}${diff})`,
        description: `Counted ${n} on hand vs ${product.stock} in the system. Adjust by ${diff > 0 ? '+' : ''}${diff} units (value ${money(Math.abs(diff) * product.unitCost)}). Reason: ${why}.`,
        payload: { productId: product.id, quantity: diff, reason: why },
        amount: Math.abs(diff) * product.unitCost,
      });
      if (res) onOpenChange(false);
      return;
    }
    if (n === 0) return setError('Quantity must be above 0.');
    if (mode === 'out' && n > product.stock) return setError(`Only ${product.stock} on hand.`);
    const res = run(
      (d, a) => ops.recordStockMovement(d, product.id, mode, n, why, reference.trim() || (mode === 'in' ? 'STOCK-IN' : 'STOCK-OUT'), a),
      mode === 'in' ? `Added ${n} × ${product.name}` : `Removed ${n} × ${product.name}`,
    );
    if (res) onOpenChange(false);
  };

  const title = mode === 'in' ? 'Record stock in' : mode === 'out' ? 'Record stock out' : mode === 'hold' ? 'Damaged / quarantined stock' : 'Stock count';
  const reasons = mode === 'in' ? IN_REASONS : mode === 'out' ? OUT_REASONS : mode === 'hold' ? HOLD_REASONS : ['Stock count', 'Damaged found during count', 'Other'];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === 'count'
              ? 'Enter what you physically counted. Any difference is sent to Approvals before stock changes.'
              : mode === 'hold'
                ? 'Set how many units on hand cannot be sold (damaged, expired or quarantined). They stay on hand but are not available to sell. Write them off later with Stock out → Damaged or Expired.'
                : 'This changes on-hand stock immediately and is logged in movement history.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Product">
            <SimpleSelect
              value={pid}
              onChange={setPid}
              placeholder="Choose product"
              options={db.products.map((p) => ({ value: p.id, label: mode === 'count' && blind ? `${p.name} (${p.sku})` : `${p.name} (${p.sku}) · ${p.stock} on hand${p.unavailable ? `, ${p.unavailable} held` : ''}` }))}
            />
            {product && !(mode === 'count' && blind) && (
              <div className="text-xs text-slate-500">{product.stock} on hand{product.unavailable ? ` · ${product.unavailable} held` : ''}{product.reserved ? ` · ${product.reserved} reserved for orders` : ''}</div>
            )}
          </Field>
          {mode === 'count' && (
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
              Blind count: hide the system quantity so the counter isn't influenced
            </label>
          )}
          <Field label={mode === 'count' ? 'Counted quantity on hand' : mode === 'hold' ? 'Units not sellable (total)' : 'Quantity (units)'}>
            <Input type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          {mode === 'count' && blind && product && qty !== '' && (
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              {diff === 0 ? 'Count matches the system.' : 'The count differs from the system. Submitting sends the difference to Approvals for review.'}
            </div>
          )}
          {mode === 'count' && !blind && product && Number.isFinite(n) && (
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              System: <b>{product.stock}</b> · Counted: <b>{n}</b> · Difference:{' '}
              <b className={diff < 0 ? 'text-red-600' : diff > 0 ? 'text-teal-700' : ''}>
                {diff > 0 ? '+' : ''}
                {diff}
              </b>
            </div>
          )}
          <Field label="Reason">
            <SimpleSelect value={reason} onChange={setReason} options={reasons.map((r) => ({ value: r, label: r }))} />
          </Field>
          {reason === 'Other' && (
            <Field label="Describe the reason">
              <Input value={other} onChange={(e) => setOther(e.target.value)} />
            </Field>
          )}
          {(mode === 'in' || mode === 'out') && (
            <Field label="Reference (optional)" hint="e.g. delivery note or document number">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          )}
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={submit}>
            {mode === 'count' ? (blind ? 'Submit count' : diff !== 0 ? 'Request adjustment' : 'Save count') : mode === 'hold' ? 'Save' : 'Record'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
