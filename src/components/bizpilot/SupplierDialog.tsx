import { useEffect, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { Supplier } from '@/lib/db/types';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Field, dialogWide, num, primaryBtn } from './common';

interface Form {
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  categories: string;
  unitCost: string;
  minOrderQty: string;
  leadTimeDays: string;
  paymentTerms: string;
  defectRate: string; // percent in the form
  notes: string;
}

const blank: Form = {
  name: '',
  contactPerson: '',
  email: '',
  phone: '',
  categories: '',
  unitCost: '0',
  minOrderQty: '0',
  leadTimeDays: '7',
  paymentTerms: '',
  defectRate: '0',
  notes: '',
};

export function SupplierDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplier?: Supplier | null;
}) {
  const { run } = useBizPilot();
  const [form, setForm] = useState<Form>(blank);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      supplier
        ? {
            name: supplier.name,
            contactPerson: supplier.contactPerson,
            email: supplier.email,
            phone: supplier.phone,
            categories: supplier.categories.join(', '),
            unitCost: String(supplier.unitCost),
            minOrderQty: String(supplier.minOrderQty),
            leadTimeDays: String(supplier.leadTimeDays),
            paymentTerms: supplier.paymentTerms,
            defectRate: String(Math.round(supplier.defectRate * 1000) / 10),
            notes: supplier.notes,
          }
        : blank,
    );
  }, [open, supplier]);

  const set = <K extends keyof Form>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!form.name.trim()) e.name = 'Name is required';
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = 'Invalid email';
    const unitCost = num(form.unitCost);
    const moq = num(form.minOrderQty);
    const lead = num(form.leadTimeDays);
    const defect = num(form.defectRate);
    if (!(unitCost >= 0)) e.unitCost = '0 or more';
    if (!(moq >= 0)) e.minOrderQty = '0 or more';
    if (!(lead >= 0)) e.leadTimeDays = '0 or more';
    if (!(defect >= 0 && defect <= 100)) e.defectRate = '0–100';
    setErrors(e);
    if (Object.keys(e).length) return;
    const data = {
      name: form.name.trim(),
      contactPerson: form.contactPerson.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      categories: form.categories
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      unitCost,
      minOrderQty: Math.round(moq),
      leadTimeDays: Math.round(lead),
      paymentTerms: form.paymentTerms.trim(),
      defectRate: defect / 100,
      notes: form.notes,
    };
    const res = supplier
      ? run((d, a) => ops.updateSupplier(d, supplier.id, data, a), 'Supplier updated')
      : run((d, a) => ops.createSupplier(d, data, a), 'Supplier added');
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogWide}>
        <DialogHeader>
          <DialogTitle>{supplier ? `Edit ${supplier.name}` : 'New supplier'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Supplier name *" error={errors.name} className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Field>
          <Field label="Contact person">
            <Input value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+60…" />
          </Field>
          <Field label="Email" error={errors.email}>
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Categories" hint="Comma separated">
            <Input value={form.categories} onChange={(e) => set('categories', e.target.value)} />
          </Field>
          <Field label="Indicative unit cost (RM)" error={errors.unitCost}>
            <Input type="number" min="0" step="0.01" value={form.unitCost} onChange={(e) => set('unitCost', e.target.value)} />
          </Field>
          <Field label="Minimum order qty" error={errors.minOrderQty}>
            <Input type="number" min="0" value={form.minOrderQty} onChange={(e) => set('minOrderQty', e.target.value)} />
          </Field>
          <Field label="Lead time (days)" error={errors.leadTimeDays}>
            <Input type="number" min="0" value={form.leadTimeDays} onChange={(e) => set('leadTimeDays', e.target.value)} />
          </Field>
          <Field label="Defect rate (%)" error={errors.defectRate}>
            <Input type="number" min="0" max="100" step="0.1" value={form.defectRate} onChange={(e) => set('defectRate', e.target.value)} />
          </Field>
          <Field label="Payment terms" className="sm:col-span-2">
            <Input value={form.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} placeholder="e.g. 30 days, COD" />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          <p className="text-[11px] text-slate-400 sm:col-span-2">
            On-time rate and reliability are calculated from received purchase orders, not entered by hand.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            {supplier ? 'Save changes' : 'Add supplier'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
