import { useEffect, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { PurchaseOrder } from '@/lib/db/types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { num, primaryBtn } from './common';

export function ReceivePODialog({
  po,
  onOpenChange,
}: {
  po: PurchaseOrder | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { db, run } = useBizPilot();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!po) return;
    setError(null);
    setQty(Object.fromEntries(po.lines.map((l) => [l.productId, String(l.quantity - (l.receivedQty ?? 0))])));
  }, [po]);

  if (!po) return null;

  const receiveAll = () => {
    const res = run((d, a) => ops.receivePurchaseOrder(d, po.id, 'all', a), `${po.poNumber} received in full`);
    if (res) onOpenChange(false);
  };

  const receivePartial = () => {
    const received: Record<string, number> = {};
    for (const l of po.lines) {
      const n = num(qty[l.productId] ?? '');
      const outstanding = l.quantity - (l.receivedQty ?? 0);
      if (Number.isNaN(n) || n < 0 || !Number.isInteger(n)) return setError('Enter whole quantities (0 or more).');
      if (n > outstanding) return setError(`Can't receive more than the ${outstanding} outstanding.`);
      received[l.productId] = n;
    }
    if (Object.values(received).every((n) => n === 0)) return setError('Enter at least one received quantity.');
    const res = run((d, a) => ops.receivePurchaseOrder(d, po.id, received, a), `Goods received for ${po.poNumber}`);
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={!!po} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Receive goods · {po.poNumber}</DialogTitle>
          <DialogDescription>Received quantities are added to on-hand stock and update the supplier's on-time record.</DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="w-28 text-right">Receive now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {po.lines.map((l) => {
              const p = db.products.find((x) => x.id === l.productId);
              return (
                <TableRow key={l.productId}>
                  <TableCell>{p?.name ?? 'Unknown product'}</TableCell>
                  <TableCell className="text-right">{l.quantity}</TableCell>
                  <TableCell className="text-right">{l.receivedQty ?? 0}</TableCell>
                  <TableCell className="text-right">
                    <Input
                      className="ml-auto h-8 w-24 text-right"
                      type="number"
                      min="0"
                      value={qty[l.productId] ?? ''}
                      onChange={(e) => setQty((q) => ({ ...q, [l.productId]: e.target.value }))}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={receivePartial}>
            Receive entered quantities
          </Button>
          <Button className={primaryBtn} onClick={receiveAll}>
            Receive all outstanding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
