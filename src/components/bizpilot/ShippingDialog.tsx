import { useEffect, useState } from 'react';
import { Loader2, Truck } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { money } from '@/lib/format';
import type { SalesOrder } from '@/lib/db/types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { primaryBtn } from './common';

export interface ShippingRate {
  serviceId: string;
  courier: string;
  service: string;
  price: number;
  etaDays: number;
}

export function ShippingDialog({ order, onOpenChange }: { order: SalesOrder | null; onOpenChange: (o: boolean) => void }) {
  const { db, callServer } = useBizPilot();
  const [rates, setRates] = useState<ShippingRate[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRates(null);
    setChosen(null);
    setBusy(false);
  }, [order?.id]);

  if (!order) return null;

  const weight = order.lines.reduce((s, l) => {
    const p = db.products.find((x) => x.id === l.productId);
    return s + (p?.weightKg ?? 0.5) * l.quantity;
  }, 0);
  const problems: string[] = [];
  if (!db.settings.shipFromPostcode) problems.push('Set your ship-from postcode in Settings.');
  if (!order.shippingPostcode) problems.push('This order has no shipping postcode.');
  const pendingBooking = db.approvals.some(
    (a) => a.status === 'pending' && a.type === 'shipment_booking' && a.payload.orderId === order.id,
  );

  const quote = async () => {
    setBusy(true);
    const res = await callServer<{ rates: ShippingRate[] }>('/api/shipping/quote', { orderId: order.id });
    setBusy(false);
    if (res) {
      const sorted = [...(res.rates ?? [])].sort((a, b) => a.price - b.price);
      setRates(sorted);
      setChosen(sorted[0]?.serviceId ?? null);
    }
  };

  const book = async () => {
    const r = rates?.find((x) => x.serviceId === chosen);
    if (!r) return;
    setBusy(true);
    const res = await callServer<{ approvalId: string }>(
      '/api/shipping/book',
      { orderId: order.id, serviceId: r.serviceId, courier: r.courier, price: r.price },
      `Booking with ${r.courier} sent to Approvals`,
    );
    setBusy(false);
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={!!order} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ship {order.orderNumber}</DialogTitle>
          <DialogDescription>
            {db.settings.shipFromPostcode || '—'} → {order.shippingPostcode || '—'} · approx. {weight.toFixed(2)} kg
            {order.shippingAddress ? ` · ${order.shippingAddress}` : ''}
          </DialogDescription>
        </DialogHeader>

        {order.shipment && (
          <div className="rounded-md bg-slate-50 p-3 text-sm">
            Current shipment: <b>{order.shipment.courier}</b> · {order.shipment.status}
            {order.shipment.trackingNo ? ` · tracking ${order.shipment.trackingNo}` : ''}
            {order.shipment.lastEvent ? <div className="text-xs text-slate-500">{order.shipment.lastEvent}</div> : null}
          </div>
        )}
        {pendingBooking && (
          <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">A booking for this order is already waiting in Approvals.</div>
        )}
        {problems.length > 0 && (
          <ul className="list-disc rounded-md bg-amber-50 py-2 pl-7 pr-3 text-sm text-amber-800">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        {rates === null ? (
          <Button variant="outline" onClick={quote} disabled={busy || problems.length > 0}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Truck className="mr-1 h-4 w-4" />}
            Get courier quotes
          </Button>
        ) : rates.length === 0 ? (
          <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-600">No courier services available for this route.</div>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {rates.map((r) => (
              <button
                key={r.serviceId}
                onClick={() => setChosen(r.serviceId)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm',
                  chosen === r.serviceId ? 'border-teal-600 bg-teal-50' : 'border-slate-200 hover:bg-slate-50',
                )}
              >
                <span>
                  <b>{r.courier}</b> · {r.service}
                  <span className="ml-2 text-xs text-slate-500">{r.etaDays ? `${r.etaDays} day(s)` : ''}</span>
                </span>
                <span className="font-semibold">{money(r.price)}</span>
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {rates && rates.length > 0 && (
            <Button className={primaryBtn} onClick={book} disabled={!chosen || busy || pendingBooking}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Book (needs approval)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
