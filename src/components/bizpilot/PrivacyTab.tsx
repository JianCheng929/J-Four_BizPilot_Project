import { useState } from 'react';
import { toast } from 'sonner';
import { Download, FileLock2, ShieldCheck, Trash2, UserCheck } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { Consent } from '@/lib/db/types';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Field, Kpi, Pill, SectionCard, SimpleSelect, primaryBtn } from './common';
import { deriveCustomers } from './customers';

const DAY = 86_400_000;

function noticeTemplate(s: { name: string; legalName?: string; email: string; phone: string; addressLine?: string; city?: string }, months: number) {
  const who = s.legalName || s.name || 'We';
  return `PRIVACY NOTICE (Personal Data Protection Act 2010)

${who} collects your name, phone number, email, delivery address and order history when you buy from us, contact us or join our mailing list.

Why we use it: to process and deliver your orders, issue invoices and e-invoices (LHDN), handle returns and support, and, only if you agree, to send you offers and news.

Who we share it with: couriers that deliver your order, marketplaces you ordered through, payment providers, and LHDN for e-invoices. We do not sell your data.

How long we keep it: ${months} months after your last order, except invoices, which the law requires us to keep for 7 years.

Your choices: you may ask to see, correct or delete your data, and you may stop marketing messages at any time by replying STOP or contacting us. Giving your data is voluntary, but without it we cannot fulfil orders.

Contact: ${s.email || '[email]'}${s.phone ? `, ${s.phone}` : ''}${s.addressLine ? `, ${s.addressLine}${s.city ? `, ${s.city}` : ''}` : ''}.`;
}

function ConsentDialog({ open, onOpenChange, preset }: { open: boolean; onOpenChange: (o: boolean) => void; preset: Partial<Consent> | null }) {
  const { run } = useBizPilot();
  const [form, setForm] = useState({ customerName: '', email: '', phone: '', purpose: 'marketing', channel: 'any', status: 'granted', source: '', note: '' });
  const [seen, setSeen] = useState<Partial<Consent> | null>(null);
  if (open && preset !== seen) {
    setSeen(preset);
    setForm({ customerName: preset?.customerName ?? '', email: preset?.email ?? '', phone: preset?.phone ?? '', purpose: 'marketing', channel: 'any', status: preset?.status ?? 'granted', source: '', note: '' });
  }
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = () => {
    const c = run((d, a) => ops.recordConsent(d, { ...form, purpose: form.purpose as Consent['purpose'], channel: form.channel as Consent['channel'], status: form.status as Consent['status'] }, a), 'Consent recorded');
    if (c) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Record consent</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer name" className="col-span-2"><Input value={form.customerName} onChange={(e) => set('customerName')(e.target.value)} /></Field>
          <Field label="Email"><Input value={form.email} onChange={(e) => set('email')(e.target.value)} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => set('phone')(e.target.value)} /></Field>
          <Field label="Decision"><SimpleSelect value={form.status} onChange={set('status')} options={[{ value: 'granted', label: 'Agreed' }, { value: 'withdrawn', label: 'Withdrew / said STOP' }]} /></Field>
          <Field label="Channel"><SimpleSelect value={form.channel} onChange={set('channel')} options={[{ value: 'any', label: 'Any channel' }, { value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }]} /></Field>
          <Field label="For"><SimpleSelect value={form.purpose} onChange={set('purpose')} options={[{ value: 'marketing', label: 'Offers and news (marketing)' }, { value: 'service', label: 'Order and service messages' }]} /></Field>
          <Field label="How it was given"><Input value={form.source} onChange={(e) => set('source')(e.target.value)} placeholder="e.g. ticked box at checkout" /></Field>
          <Field label="Note" className="col-span-2"><Input value={form.note} onChange={(e) => set('note')(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button className={primaryBtn} disabled={!form.source.trim() || !(form.email.trim() || form.phone.trim())} onClick={save}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Blueprint §17: PDPA 2010 — privacy notice, consent records, access and deletion requests, retention. */
export function PrivacyTab() {
  const { db, run, can } = useBizPilot();
  const [nowMs] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; preset: Partial<Consent> | null }>({ open: false, preset: null });
  const [who, setWho] = useState('');
  const months = db.settings.dataRetentionMonths ?? 24;
  const customers = deriveCustomers(db.salesOrders);
  const consents = db.consents ?? [];
  const rows = customers.map((c) => {
    const key = c.email || c.phone;
    const latest = key ? ops.consentStatus(db, key, 'marketing') : null;
    return { c, key, latest };
  });
  const keysWithOrders = new Set(rows.map((r) => ops.customerKeyOf(r.c.email, r.c.phone)));
  const consentOnly = [...new Map(consents.filter((x) => !keysWithOrders.has(x.customerKey)).map((x) => [x.customerKey, x])).values()];
  const granted = rows.filter((r) => r.latest?.status === 'granted').length + consentOnly.filter((x) => ops.consentStatus(db, x.email || x.phone, 'marketing')?.status === 'granted').length;
  const pastRetention = customers.filter((c) => c.name !== 'Erased customer' && nowMs - Date.parse(c.lastOrder) > months * 30 * DAY);

  const saveNotice = (text: string, retention = months) =>
    run((d, a) => { d.settings.privacyNotice = text; d.settings.dataRetentionMonths = retention; ops.audit(d, a, 'update', 'settings', 'privacy', 'Privacy notice / retention updated'); }, 'Privacy settings saved');

  const exportData = (key: string) => {
    const data = ops.customerDataExport(db, key);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `customer-data-${key.replace(/[^\w@.-]/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const erase = (key: string) => {
    if (!window.confirm(`Ask to erase all personal data of ${key}? It goes to Approvals and cannot be undone once approved.`)) return;
    run((d, a) => ops.requestDataErasure(d, key, 'Customer asked to delete their data (PDPA)', a), 'Erasure request sent to Approvals');
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi icon={UserCheck} label="Agreed to marketing" value={String(granted)} hint={`of ${rows.length + consentOnly.length} known customers`} />
        <Kpi icon={FileLock2} label="Privacy notice" value={db.settings.privacyNotice ? 'Published' : 'Missing'} tone={db.settings.privacyNotice ? 'teal' : 'amber'} />
        <Kpi icon={ShieldCheck} label={`Past ${months}-month retention`} value={String(pastRetention.length)} hint="customers to review" tone={pastRetention.length ? 'amber' : 'slate'} />
      </div>

      <SectionCard
        title="Marketing consent"
        description="Under the PDPA, promotions go only to customers who agreed. BizPilot's agent checks this before any marketing email; order, invoice and support messages are always allowed."
        actions={can.write && <Button size="sm" className={primaryBtn} onClick={() => setDialog({ open: true, preset: null })}>Record consent</Button>}
      >
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Contact</TableHead><TableHead>Marketing</TableHead><TableHead>Recorded</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {rows.map(({ c, key, latest }) => (
                <TableRow key={c.key}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-xs">{c.email}{c.email && c.phone ? ' · ' : ''}{c.phone}</TableCell>
                  <TableCell>{latest ? <Pill tone={latest.status === 'granted' ? 'green' : 'red'}>{latest.status === 'granted' ? 'agreed' : 'withdrawn'}</Pill> : <Pill>not asked</Pill>}</TableCell>
                  <TableCell className="text-xs text-slate-500">{latest ? `${fmtDate(latest.at)} · ${latest.source}` : '—'}</TableCell>
                  <TableCell className="text-right">
                    {can.write && key && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => setDialog({ open: true, preset: { customerName: c.name, email: c.email, phone: c.phone, status: latest?.status === 'granted' ? 'withdrawn' : 'granted' } })}>{latest?.status === 'granted' ? 'Withdraw' : 'Record'}</Button>
                        <Button size="icon-sm" variant="ghost" title="Download their data" onClick={() => exportData(key)}><Download className="h-4 w-4" /></Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {consentOnly.map((x) => {
                const latest = ops.consentStatus(db, x.email || x.phone, 'marketing');
                return (
                  <TableRow key={x.customerKey}>
                    <TableCell className="font-medium">{x.customerName || '—'}<div className="text-[11px] text-slate-400">no orders yet</div></TableCell>
                    <TableCell className="text-xs">{x.email}{x.email && x.phone ? ' · ' : ''}{x.phone}</TableCell>
                    <TableCell>{latest ? <Pill tone={latest.status === 'granted' ? 'green' : 'red'}>{latest.status === 'granted' ? 'agreed' : 'withdrawn'}</Pill> : <Pill>service only</Pill>}</TableCell>
                    <TableCell className="text-xs text-slate-500">{latest ? `${fmtDate(latest.at)} · ${latest.source}` : '—'}</TableCell>
                    <TableCell />
                  </TableRow>
                );
              })}
              {!rows.length && !consentOnly.length && <TableRow><TableCell colSpan={5} className="text-center text-sm text-slate-500">No customers with contact details yet.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard title="Requests from customers" description="A customer may ask to see their data (send them the download) or to delete it. Deletion goes to Approvals; invoice amounts are kept for tax records.">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-9 max-w-xs" placeholder="Customer email, phone or exact name" value={who} onChange={(e) => setWho(e.target.value)} />
          <Button size="sm" variant="outline" disabled={!who.trim()} onClick={() => exportData(who.trim())}><Download className="mr-1 h-4 w-4" /> Download their data</Button>
          {can.write && <Button size="sm" variant="outline" className="text-red-600" disabled={!who.trim()} onClick={() => erase(who.trim())}><Trash2 className="mr-1 h-4 w-4" /> Request deletion</Button>}
        </div>
        {pastRetention.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-xs font-medium text-slate-600">No order for more than {months} months (your retention period):</div>
            <div className="flex flex-wrap gap-2">
              {pastRetention.slice(0, 30).map((c) => (
                <span key={c.key} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                  {c.name} · last {fmtDate(c.lastOrder)}
                  {can.write && <button className="text-red-600 hover:underline" onClick={() => erase(c.email || c.phone || c.name)}>erase</button>}
                </span>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Privacy notice"
        description="Show this to customers (website, receipt footer, WhatsApp auto-reply). PDPA requires telling people what you collect, why, who you share it with and how to opt out."
        actions={can.manage && (
          <div className="w-44">
            <SimpleSelect value={String(months)} onChange={(v) => saveNotice(notice ?? db.settings.privacyNotice ?? '', Number(v))} options={[12, 24, 36, 60, 84].map((m) => ({ value: String(m), label: `Keep data ${m} months` }))} />
          </div>
        )}
      >
        <Textarea rows={12} className="font-mono text-xs" disabled={!can.manage} value={notice ?? db.settings.privacyNotice ?? ''} placeholder="No privacy notice yet. Use the standard one below and adjust it." onChange={(e) => setNotice(e.target.value)} />
        {can.manage && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setNotice(noticeTemplate(db.settings, months))}>Use the standard notice</Button>
            <Button size="sm" className={primaryBtn} disabled={notice === null} onClick={() => { saveNotice(notice ?? ''); setNotice(null); }}>Save notice</Button>
            {db.settings.privacyNotice && <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(db.settings.privacyNotice ?? ''); toast.success('Copied'); }}>Copy</Button>}
          </div>
        )}
      </SectionCard>
      <ConsentDialog open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} preset={dialog.preset} />
    </div>
  );
}
