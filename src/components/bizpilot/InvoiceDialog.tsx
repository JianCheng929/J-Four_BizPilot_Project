import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { money } from '@/lib/format';
import type { Invoice, InvoiceLine, InvoiceRecurrence, Quotation } from '@/lib/db/types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Field, NONE, SimpleSelect, dialogXL, num, primaryBtn } from './common';

/** MyInvois TIN for buyers who are the general public / individuals without a TIN. */
export const GENERAL_PUBLIC_TIN = 'EI00000000010';

interface LineForm {
  productId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

type Repeat = 'none' | InvoiceRecurrence['every'];
const REPEAT_OPTIONS = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'week', label: 'Every week' },
  { value: 'month', label: 'Every month' },
  { value: 'quarter', label: 'Every 3 months' },
  { value: 'year', label: 'Every year' },
];

/** Invoices and quotations share this form; `quotation` mode saves a quotation instead. */
export function InvoiceDialog({
  open,
  onOpenChange,
  invoice,
  quotation,
  mode = 'invoice',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice?: Invoice | null;
  quotation?: Quotation | null;
  mode?: 'invoice' | 'quotation';
}) {
  const isQuote = mode === 'quotation';
  const [validDays, setValidDays] = useState('14');
  const [note, setNote] = useState('');
  const [repeat, setRepeat] = useState<Repeat>('none');
  const { db, run, callServer } = useBizPilot();
  const defaultRate = String(db.settings.defaultTaxRate ?? 0);
  const [buyerType, setBuyerType] = useState<'individual' | 'business'>('individual');
  const [c, setC] = useState({ name: '', email: '', phone: '', address: '', tin: '', brn: '' });
  const [idType, setIdType] = useState('BRN');
  const [dueDays, setDueDays] = useState('30');
  const [lines, setLines] = useState<LineForm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tinCheck, setTinCheck] = useState<{ valid: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTinCheck(null);
    const source = isQuote ? quotation : invoice;
    setRepeat(!isQuote && invoice?.recurrence?.active ? invoice.recurrence.every : 'none');
    setNote(quotation?.note ?? '');
    setValidDays(quotation ? String(Math.max(1, Math.round((new Date(quotation.validUntil).getTime() - new Date(quotation.issuedDate).getTime()) / 86400000))) : '14');
    if (source) {
      const invoice = source;
      const isBiz = !!invoice.customerTin && invoice.customerTin !== GENERAL_PUBLIC_TIN;
      setBuyerType(isBiz ? 'business' : 'individual');
      setC({
        name: invoice.customerName,
        email: invoice.customerEmail,
        phone: invoice.customerPhone,
        address: invoice.customerAddress,
        tin: isBiz ? invoice.customerTin : '',
        brn: invoice.customerBrn,
      });
      const days = 'paymentDays' in invoice ? invoice.paymentDays : Math.max(0, Math.round((new Date(invoice.dueDate).getTime() - new Date(invoice.issuedDate).getTime()) / 86400000));
      setDueDays(String(days));
      setLines(
        invoice.lines.map((l) => ({
          productId: l.productId ?? NONE,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          taxRate: String(l.taxRate ?? 0),
        })),
      );
    } else {
      setBuyerType('individual');
      setC({ name: '', email: '', phone: '', address: '', tin: '', brn: '' });
      setDueDays('30');
      setLines([{ productId: NONE, description: '', quantity: '1', unitPrice: '', taxRate: defaultRate }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice, quotation]);

  const setLine = (i: number, patch: Partial<LineForm>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const parsedLines: InvoiceLine[] = lines.map((l) => ({
    description: l.description.trim(),
    quantity: num(l.quantity) || 0,
    unitPrice: num(l.unitPrice) || 0,
    taxRate: num(l.taxRate) || 0,
    productId: l.productId === NONE ? null : l.productId,
  }));
  const totals = ops.invoiceTotals(parsedLines);

  const validateTin = async () => {
    if (!c.tin.trim()) return setTinCheck({ valid: false, message: 'Enter the buyer TIN first.' });
    if (!c.brn.trim()) return setTinCheck({ valid: false, message: `Enter the buyer ${idType} number to validate against.` });
    setChecking(true);
    const res = await callServer<{ valid: boolean; message: string }>('/api/einvoice/validate-tin', {
      tin: c.tin.trim(),
      idType,
      idValue: c.brn.trim(),
    });
    setChecking(false);
    if (res) setTinCheck(res);
  };

  const save = () => {
    if (!c.name.trim()) return setError('Customer name is required.');
    if (c.email && !/^\S+@\S+\.\S+$/.test(c.email.trim())) return setError('Invalid email.');
    if (buyerType === 'business' && (!c.tin.trim() || !c.brn.trim())) return setError('Business buyers need a TIN and registration number for e-invoicing.');
    if (!lines.length) return setError('Add at least one line.');
    for (const l of lines) {
      if (!l.description.trim()) return setError('Every line needs a description.');
      if (!(num(l.quantity) > 0)) return setError('Quantities must be above 0.');
      if (!(num(l.unitPrice) >= 0)) return setError('Unit prices must be 0 or more.');
      const t = num(l.taxRate);
      if (!(t >= 0 && t <= 100)) return setError('Tax rate must be 0–100%.');
    }
    const due = num(dueDays);
    if (!(due >= 0)) return setError('Payment terms must be 0 or more days.');
    const buyer = {
      customerName: c.name.trim(),
      customerEmail: c.email.trim(),
      customerPhone: c.phone.trim(),
      customerAddress: c.address.trim(),
      customerTin: buyerType === 'business' ? c.tin.trim() : GENERAL_PUBLIC_TIN,
      customerBrn: buyerType === 'business' ? c.brn.trim() : '',
    };
    const every = repeat === 'none' ? null : repeat;
    if (isQuote) {
      const vd = num(validDays);
      if (!(vd >= 1)) return setError('Valid for must be at least 1 day.');
      const input = { ...buyer, lines: parsedLines, validDays: vd, paymentDays: due, note };
      const r = quotation
        ? run((d, a) => ops.updateQuotation(d, quotation.id, input, a), 'Quotation updated')
        : run((d, a) => ops.createQuotation(d, input, a), 'Draft quotation created');
      if (r) onOpenChange(false);
      return;
    }
    const res = invoice
      ? run((d, a) => {
          const inv = d.invoices.find((x) => x.id === invoice.id);
          if (!inv) throw new ops.OpError('Invoice not found.');
          if (inv.status !== 'draft') throw new ops.OpError(`${inv.invoiceNumber} is ${inv.status}; only drafts can be edited.`);
          Object.assign(inv, buyer, {
            lines: parsedLines.map((l) => ({ ...l, classificationCode: '022' })),
            ...ops.invoiceTotals(parsedLines),
            dueDate: new Date(new Date(inv.issuedDate).getTime() + due * 86400000).toISOString(),
          });
          ops.audit(d, a, 'update', 'invoice', inv.invoiceNumber, `Draft ${inv.invoiceNumber} edited (${money(inv.total)})`);
          if (!inv.recurringFrom && (every ?? null) !== (inv.recurrence?.active ? inv.recurrence.every : null)) ops.setInvoiceRecurrence(d, inv.id, every, a);
          return inv;
        }, 'Invoice updated')
      : run((d, a) => {
          const inv = ops.createInvoice(d, { ...buyer, lines: parsedLines, dueDays: due }, a);
          if (every) ops.setInvoiceRecurrence(d, inv.id, every, a);
          return inv;
        }, every ? 'Draft invoice created; copies will be made on schedule' : 'Draft invoice created');
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogXL}>
        <DialogHeader>
          <DialogTitle>
            {isQuote ? (quotation ? `Edit ${quotation.quoteNumber}` : 'New quotation') : invoice ? `Edit ${invoice.invoiceNumber}` : 'New invoice'}
          </DialogTitle>
          <DialogDescription>
            {isQuote
              ? 'Saved as a draft. Sending it goes through Approvals; once the customer accepts, turn it into an invoice in one click.'
              : 'Saved as a draft. Issuing it to the customer goes through Approvals.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={buyerType} onValueChange={(v) => setBuyerType(v as 'individual' | 'business')}>
          <TabsList>
            <TabsTrigger value="individual">Individual (B2C)</TabsTrigger>
            <TabsTrigger value="business">Business (B2B)</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Customer / company name *">
            <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          </Field>
          <Field label="Email" hint="Needed to email the invoice">
            <Input value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
          </Field>
          <Field label="Address" className="sm:col-span-3">
            <Input value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} />
          </Field>
          {buyerType === 'business' ? (
            <>
              <Field label="Buyer TIN *">
                <Input value={c.tin} onChange={(e) => { setC({ ...c, tin: e.target.value }); setTinCheck(null); }} placeholder="e.g. C1234567890" />
              </Field>
              <Field label="ID type">
                <SimpleSelect
                  value={idType}
                  onChange={setIdType}
                  options={[
                    { value: 'BRN', label: 'BRN (SSM)' },
                    { value: 'NRIC', label: 'NRIC' },
                    { value: 'PASSPORT', label: 'Passport' },
                    { value: 'ARMY', label: 'Army ID' },
                  ]}
                />
              </Field>
              <Field label={`${idType} number *`}>
                <div className="flex gap-2">
                  <Input value={c.brn} onChange={(e) => { setC({ ...c, brn: e.target.value }); setTinCheck(null); }} />
                  <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={validateTin} disabled={checking}>
                    {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Validate TIN'}
                  </Button>
                </div>
              </Field>
              {tinCheck && (
                <div className={`flex items-center gap-1.5 text-xs sm:col-span-3 ${tinCheck.valid ? 'text-teal-700' : 'text-red-600'}`}>
                  {tinCheck.valid ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  {tinCheck.message}
                </div>
              )}
            </>
          ) : (
            <p className="text-[11px] text-slate-500 sm:col-span-3">
              Individuals use the general-public TIN {GENERAL_PUBLIC_TIN} on MyInvois e-invoices.
            </p>
          )}
        </div>

        <div className="rounded-md border border-slate-200">
          <div className="grid grid-cols-[160px_1fr_70px_100px_70px_90px_32px] gap-2 border-b bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-500">
            <span>Product (optional)</span>
            <span>Description</span>
            <span>Qty</span>
            <span>Unit price</span>
            <span>Tax %</span>
            <span className="text-right">Amount</span>
            <span />
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[160px_1fr_70px_100px_70px_90px_32px] items-center gap-2 px-3 py-2">
              <SimpleSelect
                size="sm"
                value={l.productId}
                onChange={(v) => {
                  const p = db.products.find((x) => x.id === v);
                  setLine(i, p ? { productId: v, description: p.name, unitPrice: String(p.price) } : { productId: NONE });
                }}
                options={[{ value: NONE, label: 'Custom line' }, ...db.products.map((p) => ({ value: p.id, label: p.name }))]}
              />
              <Input className="h-8" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
              <Input className="h-8" type="number" min="0" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
              <Input className="h-8" type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
              <Input className="h-8" type="number" min="0" step="0.1" value={l.taxRate} onChange={(e) => setLine(i, { taxRate: e.target.value })} />
              <span className="text-right text-sm">{money((num(l.quantity) || 0) * (num(l.unitPrice) || 0))}</span>
              <Button size="icon-sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-start justify-between gap-3 border-t px-3 py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLines((ls) => [...ls, { productId: NONE, description: '', quantity: '1', unitPrice: '', taxRate: defaultRate }])}
            >
              <Plus className="mr-1 h-4 w-4" /> Add line
            </Button>
            <div className="min-w-48 space-y-0.5 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Subtotal</span>
                <span>{money(totals.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Tax</span>
                <span>{money(totals.taxTotal)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span>{money(totals.total)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Payment terms (days)">
            <Input type="number" min="0" value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
          </Field>
          {isQuote ? (
            <>
              <Field label="Valid for (days)">
                <Input type="number" min="1" value={validDays} onChange={(e) => setValidDays(e.target.value)} />
              </Field>
              <Field label="Note to customer" hint="e.g. delivery time, what is included">
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </>
          ) : (
            !invoice?.recurringFrom && (
              <Field label="Repeat" hint={repeat === 'none' ? 'For rent, retainers, subscriptions' : 'A new draft is made each period and sent to Approvals'}>
                <SimpleSelect value={repeat} onChange={(v) => setRepeat(v as Repeat)} options={REPEAT_OPTIONS} />
              </Field>
            )
          )}
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            {isQuote ? (quotation ? 'Save draft' : 'Create draft quotation') : invoice ? 'Save draft' : 'Create draft invoice'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
