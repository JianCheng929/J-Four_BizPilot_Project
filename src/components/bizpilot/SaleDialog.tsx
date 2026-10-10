import { useEffect, useState } from 'react';
import { Minus, Plus, ScanBarcode, Trash2 } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { availableStock } from '@/lib/metrics';
import { money } from '@/lib/format';
import type { SalesOrder } from '@/lib/db/types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { Field, SimpleSelect, dialogXL, num, primaryBtn } from './common';

export const PAYMENT_METHODS = ['Cash', 'Card', 'DuitNow QR', 'E-wallet', 'Bank transfer', 'COD'];

interface CartLine {
  productId: string;
  quantity: string;
  unitPrice: string;
}

export function SaleDialog({
  open,
  onOpenChange,
  defaultChannel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultChannel?: SalesOrder['channel'];
}) {
  const { db, run } = useBizPilot();
  const [channel, setChannel] = useState<SalesOrder['channel']>('retail');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [scan, setScan] = useState('');
  const [payment, setPayment] = useState('Cash');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'pending'>('paid');
  const [customer, setCustomer] = useState({ name: '', email: '', phone: '', address: '', postcode: '' });
  const [error, setError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string>(() => db.locations.find((l) => l.isDefault && l.active)?.id ?? '');
  const activeLocations = db.locations.filter((l) => l.active);

  useEffect(() => {
    if (!open) return;
    setChannel(defaultChannel ?? (db.settings.mode === 'online' ? 'online' : 'retail'));
    setCart([]);
    setScan('');
    setPayment('Cash');
    setPaymentStatus('paid');
    setCustomer({ name: '', email: '', phone: '', address: '', postcode: '' });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sellable = db.products.filter((p) => p.status !== 'discontinued' && p.status !== 'draft');

  const addProduct = (productId: string) => {
    const p = db.products.find((x) => x.id === productId);
    if (!p) return;
    setCart((c) => {
      const idx = c.findIndex((l) => l.productId === productId);
      if (idx >= 0) return c.map((l, i) => (i === idx ? { ...l, quantity: String((num(l.quantity) || 0) + 1) } : l));
      return [...c, { productId, quantity: '1', unitPrice: String(p.price) }];
    });
    setError(null);
  };

  const onScan = () => {
    const code = scan.trim();
    if (!code) return;
    const p = ops.findProduct(db, code);
    if (!p) return setError(`No product with barcode/SKU "${code}".`);
    addProduct(p.id);
    setScan('');
  };

  const setLine = (i: number, patch: Partial<CartLine>) => setCart((c) => c.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = cart.reduce((s, l) => s + (num(l.quantity) || 0) * (num(l.unitPrice) || 0), 0);

  const submit = () => {
    if (!cart.length) return setError('Add at least one product.');
    for (const l of cart) {
      const q = num(l.quantity);
      if (!(q > 0) || !Number.isInteger(q)) return setError('Quantities must be whole numbers above 0.');
      if (!(num(l.unitPrice) >= 0)) return setError('Prices must be 0 or more.');
    }
    if (channel === 'retail') {
      for (const l of cart) {
        const p = db.products.find((x) => x.id === l.productId)!;
        if (Number(l.quantity) > p.stock) return setError(`Only ${p.stock} × ${p.name} on hand.`);
      }
    } else {
      if (!customer.name.trim()) return setError('Customer name is required for online orders.');
      if (customer.email && !/^\S+@\S+\.\S+$/.test(customer.email.trim())) return setError('Invalid customer email.');
      if (customer.postcode && !/^\d{5}$/.test(customer.postcode.trim())) return setError('Malaysian postcodes have 5 digits.');
    }
    const lines = cart.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) }));
    const res = run(
      (d, a) =>
        ops.createSalesOrder(
          d,
          channel === 'retail'
            ? {
                channel: 'retail',
                source: 'pos',
                lines,
                paymentMethod: payment,
                paymentStatus: 'paid',
                customerName: customer.name.trim() || undefined,
                customerPhone: customer.phone.trim(),
                customerEmail: customer.email.trim(),
                fulfilNow: true,
                locationId: locationId || null,
              }
            : {
                channel: 'online',
                source: 'manual',
                lines,
                paymentMethod: payment,
                paymentStatus,
                customerName: customer.name.trim(),
                customerEmail: customer.email.trim(),
                customerPhone: customer.phone.trim(),
                shippingAddress: customer.address.trim(),
                shippingPostcode: customer.postcode.trim(),
                locationId: locationId || null,
              },
          a,
        ),
      channel === 'retail' ? `Sale recorded · ${money(total)}` : `Order created · ${money(total)}`,
    );
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogXL}>
        <DialogHeader>
          <DialogTitle>New sale</DialogTitle>
          <DialogDescription>
            {channel === 'retail'
              ? 'Counter sale: stock is deducted immediately and the sale is marked paid.'
              : 'Online order: stock is reserved until you fulfil it.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={channel} onValueChange={(v) => setChannel(v as SalesOrder['channel'])}>
          <TabsList>
            <TabsTrigger value="retail">Retail / POS</TabsTrigger>
            <TabsTrigger value="online">Online order</TabsTrigger>
          </TabsList>
        </Tabs>
        {activeLocations.length > 1 && (
          <Field label={channel === 'retail' ? 'Sold at' : 'Ships from'}>
            <SimpleSelect value={locationId} onChange={setLocationId} options={activeLocations.map((l) => ({ value: l.id, label: l.name }))} />
          </Field>
        )}

        {sellable.length === 0 ? (
          <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-600">Add active products in Inventory before recording sales.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[1fr_1.1fr]">
            <div className="space-y-3">
              <div className="relative">
                <ScanBarcode className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  className="pl-8"
                  placeholder="Scan barcode or type SKU, then Enter"
                  value={scan}
                  onChange={(e) => setScan(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onScan();
                    }
                  }}
                />
              </div>
              <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1">
                {sellable.map((p) => {
                  const avail = availableStock(p);
                  return (
                    <button
                      key={p.id}
                      onClick={() => addProduct(p.id)}
                      className={cn(
                        'rounded-md border border-slate-200 p-2 text-left text-xs transition-colors hover:border-teal-600 hover:bg-teal-50',
                        avail <= 0 && 'opacity-60',
                      )}
                    >
                      <div className="truncate font-medium text-slate-800">{p.name}</div>
                      <div className="mt-0.5 flex justify-between text-slate-500">
                        <span>{money(p.price)}</span>
                        <span>{avail} avail</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-md border border-slate-200">
                {cart.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-500">Tap products or scan to add them.</div>
                ) : (
                  cart.map((l, i) => {
                    const p = db.products.find((x) => x.id === l.productId);
                    const q = num(l.quantity) || 0;
                    const short = p && channel === 'online' && q > availableStock(p);
                    return (
                      <div key={l.productId} className="flex items-center gap-2 border-b px-3 py-2 last:border-0">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{p?.name}</div>
                          {short && <div className="text-[11px] text-amber-700">Only {availableStock(p!)} available — will be back-ordered</div>}
                        </div>
                        <Button size="icon-sm" variant="ghost" onClick={() => setLine(i, { quantity: String(Math.max(1, q - 1)) })}>
                          <Minus className="h-3.5 w-3.5" />
                        </Button>
                        <Input className="h-8 w-14 text-center" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                        <Button size="icon-sm" variant="ghost" onClick={() => setLine(i, { quantity: String(q + 1) })}>
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                        <Input
                          className="h-8 w-20 text-right"
                          type="number"
                          step="0.01"
                          value={l.unitPrice}
                          onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                          title="Unit price (RM)"
                        />
                        <Button size="icon-sm" variant="ghost" onClick={() => setCart((c) => c.filter((_, j) => j !== i))}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })
                )}
                <div className="flex justify-between border-t bg-slate-50 px-3 py-2 text-sm font-semibold">
                  <span>Total</span>
                  <span>{money(total)}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Payment method">
                  <SimpleSelect value={payment} onChange={setPayment} options={PAYMENT_METHODS.map((m) => ({ value: m, label: m }))} />
                </Field>
                {channel === 'online' ? (
                  <Field label="Payment status">
                    <SimpleSelect
                      value={paymentStatus}
                      onChange={(v) => setPaymentStatus(v as 'paid' | 'pending')}
                      options={[
                        { value: 'paid', label: 'Paid' },
                        { value: 'pending', label: 'Pending' },
                      ]}
                    />
                  </Field>
                ) : (
                  <Field label="Customer (optional)">
                    <Input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} placeholder="Walk-in customer" />
                  </Field>
                )}
              </div>
              {channel === 'online' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Customer name *" className="col-span-2">
                    <Input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
                  </Field>
                  <Field label="Email">
                    <Input value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} />
                  </Field>
                  <Field label="Phone">
                    <Input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
                  </Field>
                  <Field label="Shipping address" className="col-span-2">
                    <Input value={customer.address} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} />
                  </Field>
                  <Field label="Postcode" hint="Needed for courier quotes">
                    <Input value={customer.postcode} onChange={(e) => setCustomer({ ...customer, postcode: e.target.value })} maxLength={5} />
                  </Field>
                </div>
              )}
              {channel === 'retail' && (
                <Field label="Customer phone (optional)" hint="Lets you track repeat customers">
                  <Input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
                </Field>
              )}
            </div>
          </div>
        )}
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={submit} disabled={!cart.length}>
            {channel === 'retail' ? `Charge ${money(total)}` : 'Create order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
