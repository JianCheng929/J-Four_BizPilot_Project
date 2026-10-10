import { useState } from 'react';
import { PiggyBank } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { cashPosition } from '@/lib/metrics';
import { money } from '@/lib/format';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field, num, primaryBtn } from './common';

/** Set or top up the owner's starting capital (modal), from wherever money is shown. */
export function CapitalDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { db, updateSettings, can } = useBizPilot();
  const current = Number(db.settings.openingCash) || 0;
  const [mode, setMode] = useState<'set' | 'add'>(db.settings.openingCashDate ? 'add' : 'set');
  const [amount, setAmount] = useState('');
  const n = num(amount);
  const next = mode === 'add' ? current + n : n;
  const valid = amount.trim() !== '' && Number.isFinite(n) && n >= 0 && (mode === 'set' || n > 0);

  const save = () => {
    updateSettings({ openingCash: Math.round(next * 100) / 100, openingCashDate: new Date().toISOString() });
    setAmount('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Starting capital (modal)</DialogTitle>
          <DialogDescription>
            The money you put into the business. BizPilot adds paid sales, takes away paid expenses and stock you buy, and blocks purchases bigger than the money left. This is for planning only; no real money moves.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
            Capital now <b>{money(current)}</b> · money available <b>{money(cashPosition(db).balance)}</b>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'add' ? 'default' : 'outline'} onClick={() => setMode('add')}>Add more money</Button>
            <Button size="sm" variant={mode === 'set' ? 'default' : 'outline'} onClick={() => setMode('set')}>Set the total</Button>
          </div>
          <Field label={mode === 'add' ? 'Amount to add (RM)' : 'Total starting capital (RM)'}>
            <Input autoFocus type="number" min={0} step="0.01" placeholder="e.g. 5000" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && can.manage && save()} />
          </Field>
          {valid && <div className="text-xs text-slate-500">Capital becomes {money(next)}.</div>}
          {!can.manage && <div className="text-xs text-red-600">Only the owner or a manager can change the capital.</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className={primaryBtn} disabled={!valid || !can.manage} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A button that opens the capital dialog. */
export function CapitalButton({ label, size = 'sm', variant = 'outline' }: { label?: string; size?: 'sm' | 'default'; variant?: 'outline' | 'default' }) {
  const { db } = useBizPilot();
  const [open, setOpen] = useState(false);
  const set = Boolean(db.settings.openingCashDate);
  return (
    <>
      <Button size={size} variant={variant} className={variant === 'default' ? primaryBtn : undefined} onClick={() => setOpen(true)}>
        <PiggyBank className="mr-1 h-4 w-4" /> {label ?? (set ? 'Add capital' : 'Set starting capital')}
      </Button>
      {open && <CapitalDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}
