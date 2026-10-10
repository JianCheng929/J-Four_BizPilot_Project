import { useEffect, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { Product } from '@/lib/db/types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Field, NONE, SimpleSelect, dialogWide, num, primaryBtn } from './common';

const STATUSES: Product['status'][] = ['active', 'seasonal', 'draft', 'discontinued'];

interface Form {
  name: string;
  sku: string;
  category: string;
  description: string;
  barcode: string;
  supplierId: string;
  unitCost: string;
  price: string;
  weightKg: string;
  reorderLevel: string;
  status: Product['status'];
  openingStock: string;
  shopee: string;
  lazada: string;
  tiktok_shop: string;
}

const blank: Form = {
  name: '',
  sku: '',
  category: '',
  description: '',
  barcode: '',
  supplierId: NONE,
  unitCost: '',
  price: '',
  weightKg: '0.5',
  reorderLevel: '0',
  status: 'active',
  openingStock: '0',
  shopee: '',
  lazada: '',
  tiktok_shop: '',
};

function fromProduct(p: Product): Form {
  return {
    name: p.name,
    sku: p.sku,
    category: p.category,
    description: p.description,
    barcode: p.barcode ?? '',
    supplierId: p.supplierId ?? NONE,
    unitCost: String(p.unitCost),
    price: String(p.price),
    weightKg: String(p.weightKg ?? 0.5),
    reorderLevel: String(p.reorderLevel),
    status: p.status,
    openingStock: '0',
    shopee: p.channelSkus?.shopee ?? '',
    lazada: p.channelSkus?.lazada ?? '',
    tiktok_shop: p.channelSkus?.tiktok_shop ?? '',
  };
}

export function ProductDialog({
  open,
  onOpenChange,
  product,
  initialBarcode,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  product?: Product | null;
  initialBarcode?: string;
}) {
  const { db, run } = useBizPilot();
  const [form, setForm] = useState<Form>(blank);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});

  useEffect(() => {
    if (open) {
      setForm(product ? fromProduct(product) : { ...blank, barcode: initialBarcode ?? '' });
      setErrors({});
    }
  }, [open, product, initialBarcode]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!form.name.trim()) e.name = 'Name is required';
    const unitCost = num(form.unitCost);
    const price = num(form.price);
    const weightKg = num(form.weightKg);
    const reorderLevel = num(form.reorderLevel);
    const opening = num(form.openingStock);
    if (!(unitCost >= 0)) e.unitCost = 'Enter a cost (0 or more)';
    if (!(price >= 0)) e.price = 'Enter a price (0 or more)';
    if (!(weightKg > 0)) e.weightKg = 'Weight must be above 0';
    if (!(reorderLevel >= 0)) e.reorderLevel = '0 or more';
    if (!product && !(opening >= 0)) e.openingStock = '0 or more';
    const sku = form.sku.trim();
    if (sku && db.products.some((p) => p.id !== product?.id && p.sku.toLowerCase() === sku.toLowerCase())) e.sku = 'SKU already used';
    const barcode = form.barcode.trim();
    if (barcode && db.products.some((p) => p.id !== product?.id && p.barcode === barcode)) e.barcode = 'Barcode already used';
    setErrors(e);
    if (Object.keys(e).length) return;

    const channelSkus: Record<string, string> = {};
    for (const k of ['shopee', 'lazada', 'tiktok_shop'] as const) if (form[k].trim()) channelSkus[k] = form[k].trim();
    const common = {
      name: form.name.trim(),
      category: form.category.trim() || 'Uncategorised',
      description: form.description,
      barcode,
      supplierId: form.supplierId === NONE ? null : form.supplierId,
      unitCost,
      price,
      weightKg,
      reorderLevel,
      status: form.status,
      channelSkus,
    };
    const res = product
      ? run((d, a) => ops.updateProduct(d, product.id, { ...common, sku: sku || product.sku }, a), 'Product updated')
      : run((d, a) => ops.createProduct(d, { ...common, sku: sku || undefined, openingStock: opening }, a), 'Product added');
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>{product ? `Edit ${product.name}` : 'New product'}</DialogTitle>
          <DialogDescription>
            {product ? 'Stock levels change only through stock movements, not here.' : 'Opening stock is recorded as a stock-in movement.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name *" error={errors.name} className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Field>
          <Field label="SKU" hint={product ? undefined : 'Leave blank to generate from the name'} error={errors.sku}>
            <Input value={form.sku} onChange={(e) => set('sku', e.target.value)} />
          </Field>
          <Field label="Barcode" hint="Type or scan" error={errors.barcode}>
            <Input value={form.barcode} onChange={(e) => set('barcode', e.target.value)} />
          </Field>
          <Field label="Category">
            <Input value={form.category} onChange={(e) => set('category', e.target.value)} />
          </Field>
          <Field label="Supplier">
            <SimpleSelect
              value={form.supplierId}
              onChange={(v) => set('supplierId', v)}
              options={[{ value: NONE, label: 'No supplier' }, ...db.suppliers.map((s) => ({ value: s.id, label: s.name }))]}
            />
          </Field>
          <Field label="Unit cost (RM) *" error={errors.unitCost}>
            <Input type="number" min="0" step="0.01" value={form.unitCost} onChange={(e) => set('unitCost', e.target.value)} />
          </Field>
          <Field label="Selling price before tax (RM) *" error={errors.price}>
            <Input type="number" min="0" step="0.01" value={form.price} onChange={(e) => set('price', e.target.value)} />
          </Field>
          <Field label="Weight (kg)" hint="Used for courier quotes" error={errors.weightKg}>
            <Input type="number" min="0" step="0.01" value={form.weightKg} onChange={(e) => set('weightKg', e.target.value)} />
          </Field>
          <Field label="Reorder level (units)" error={errors.reorderLevel}>
            <Input type="number" min="0" step="1" value={form.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} />
          </Field>
          <Field label="Status">
            <SimpleSelect
              value={form.status}
              onChange={(v) => set('status', v as Product['status'])}
              options={STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))}
            />
          </Field>
          {!product && (
            <Field label="Opening stock (units)" error={errors.openingStock}>
              <Input type="number" min="0" step="1" value={form.openingStock} onChange={(e) => set('openingStock', e.target.value)} />
            </Field>
          )}
          <Field label="Description" className="sm:col-span-2">
            <Textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-xs font-medium text-slate-600">Channel SKUs (to match imported marketplace orders)</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Shopee">
                <Input value={form.shopee} onChange={(e) => set('shopee', e.target.value)} />
              </Field>
              <Field label="Lazada">
                <Input value={form.lazada} onChange={(e) => set('lazada', e.target.value)} />
              </Field>
              <Field label="TikTok Shop">
                <Input value={form.tiktok_shop} onChange={(e) => set('tiktok_shop', e.target.value)} />
              </Field>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            {product ? 'Save changes' : 'Add product'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
