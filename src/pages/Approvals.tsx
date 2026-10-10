import { useState } from 'react';
import { Check, History, Loader2, ScrollText, ShieldCheck, X } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { fmtDateTime, money } from '@/lib/format';
import type { ApprovalRequest, ApprovalType, BizPilotDB } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { EmptyState, Pill, SectionCard, StatusPill, primaryBtn } from '@/components/bizpilot/common';

const TYPE_LABEL: Record<ApprovalType, string> = {
  purchase_order: 'Purchase order',
  price_change: 'Price change',
  marketing_publish: 'Publish content',
  review_response: 'Review reply',
  invoice_issue: 'Issue invoice',
  einvoice_submit: 'MyInvois submission',
  shipment_booking: 'Courier booking',
  stock_adjustment: 'Stock adjustment',
  customer_message: 'Customer message',
  refund: 'Refund',
  stock_count: 'Stock count',
  production_order: 'Production',
  payment_reminder: 'Payment reminder',
  quotation_send: 'Quotation',
  campaign_launch: 'Ad campaign spend',
  data_erasure: 'Erase customer data',
};

/** Live preview of the record an approval will change. */
function Preview({ a, db }: { a: ApprovalRequest; db: BizPilotDB }) {
  const p = a.payload as Record<string, unknown>;
  switch (a.type) {
    case 'purchase_order': {
      const po = db.purchaseOrders.find((x) => x.id === p.purchaseOrderId);
      if (!po) return null;
      const supplier = db.suppliers.find((s) => s.id === po.supplierId);
      return (
        <div className="rounded-md bg-slate-50 p-2 text-xs">
          <div className="mb-1 font-medium">
            {po.poNumber} · {supplier?.name ?? 'Unknown supplier'} · expected {fmtDateTime(po.expectedDate)}
          </div>
          {po.lines.map((l) => {
            const prod = db.products.find((x) => x.id === l.productId);
            return (
              <div key={l.productId} className="flex justify-between">
                <span>
                  {l.quantity} × {prod?.name ?? 'item'} (on hand {prod?.stock ?? '?'})
                </span>
                <span>{money(l.quantity * l.unitCost)}</span>
              </div>
            );
          })}
        </div>
      );
    }
    case 'price_change': {
      const prod = db.products.find((x) => x.id === p.productId);
      if (!prod) return null;
      const np = Number(p.newPrice);
      const margin = np > 0 ? ((np - prod.unitCost) / np) * 100 : 0;
      return (
        <div className="rounded-md bg-slate-50 p-2 text-xs">
          {prod.name}: {money(prod.price)} → <b>{money(np)}</b> · unit cost {money(prod.unitCost)} · new gross margin {margin.toFixed(1)}%
        </div>
      );
    }
    case 'stock_adjustment': {
      const prod = db.products.find((x) => x.id === p.productId);
      if (!prod) return null;
      const q = Number(p.quantity);
      return (
        <div className="rounded-md bg-slate-50 p-2 text-xs">
          {prod.name}: on hand {prod.stock} → <b>{prod.stock + q}</b> ({q > 0 ? '+' : ''}
          {q})
        </div>
      );
    }
    case 'refund': {
      const r = db.returns.find((x) => x.id === p.returnId);
      if (!r) {
        const o = db.salesOrders.find((x) => x.id === p.orderId);
        if (!o) return null;
        return (
          <div className="rounded-md bg-slate-50 p-2 text-xs">
            {o.orderNumber} · {o.customerName || 'customer'} · {o.lines.map((l) => `${l.quantity}× ${l.name ?? db.products.find((x) => x.id === l.productId)?.name ?? "item"}`).join(', ')} · refund <b>{money(Number(p.amount))}</b>
          </div>
        );
      }
      const prod = db.products.find((x) => x.id === r.productId);
      return (
        <div className="rounded-md bg-slate-50 p-2 text-xs">
          {r.returnNumber} · {r.quantity} × {prod?.name ?? 'item'} · {r.reason.replace(/_/g, ' ')} ({r.condition}) · refund <b>{money(Number(p.amount))}</b>
        </div>
      );
    }
    case 'marketing_publish': {
      const c = db.contentItems.find((x) => x.id === p.contentId);
      if (!c) return null;
      return (
        <div className="flex gap-2 rounded-md bg-slate-50 p-2 text-xs">
          {c.imageUrl && <img src={c.imageUrl} alt="" className="h-14 w-14 rounded object-cover" />}
          <div className="whitespace-pre-wrap">{c.body}</div>
        </div>
      );
    }
    case 'review_response': {
      const r = db.reviews.find((x) => x.id === p.reviewId);
      return (
        <div className="space-y-1 rounded-md bg-slate-50 p-2 text-xs">
          {r && (
            <div className="text-slate-500">
              {r.rating}★ {r.source} · {r.customerName}: “{r.text}”
            </div>
          )}
          <div>
            Reply: <b>“{String(p.response ?? '')}”</b>
          </div>
        </div>
      );
    }
    case 'invoice_issue':
    case 'einvoice_submit': {
      const inv = db.invoices.find((x) => x.id === p.invoiceId);
      if (!inv) return null;
      return (
        <div className="rounded-md bg-slate-50 p-2 text-xs">
          {inv.invoiceNumber} · {inv.customerName}
          {inv.customerTin ? ` (TIN ${inv.customerTin})` : ''} · {inv.lines.length} line(s) · {money(inv.total)} · status {inv.status}
        </div>
      );
    }
    case 'shipment_booking': {
      const o = db.salesOrders.find((x) => x.id === p.orderId);
      if (!o) return null;
      return (
        <div className="rounded-md bg-slate-50 p-2 text-xs">
          {o.orderNumber} to {o.customerName} ({o.shippingPostcode || 'no postcode'}) · {String(p.courier ?? '')}{' '}
          {p.price !== undefined ? money(Number(p.price)) : ''}
        </div>
      );
    }
    default:
      return null;
  }
}

export function Approvals() {
  const { db, approve, reject, can, role } = useBizPilot();
  const [busy, setBusy] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | ApprovalType>('all');
  const [auditQ, setAuditQ] = useState('');

  const pending = db.approvals.filter((a) => a.status === 'pending');
  const decided = db.approvals.filter((a) => a.status !== 'pending' && (typeFilter === 'all' || a.type === typeFilter));
  const failedCount = db.approvals.filter((a) => a.executionStatus === 'failed').length;
  const audit = db.auditLog.filter((e) => {
    if (!auditQ) return true;
    const s = auditQ.toLowerCase();
    return [e.actor, e.action, e.entity, e.entityId, e.details].some((x) => x?.toLowerCase().includes(s));
  });

  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusy(id);
    try {
      await fn(id);
    } finally {
      setBusy(null);
    }
  };

  const pendingTotal = pending.reduce((s, a) => s + (a.amount ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle={
          pending.length
            ? `${pending.length} action(s) waiting${pendingTotal ? ` · ${money(pendingTotal)} financial exposure` : ''}`
            : 'Every action with real-world effects waits here for your decision'
        }
      />
      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">Pending{pending.length ? ` (${pending.length})` : ''}</TabsTrigger>
          <TabsTrigger value="history">History{failedCount ? ` · ${failedCount} failed` : ''}</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4 space-y-3">
          {pending.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="Nothing waiting for approval"
              body="Purchase orders, price changes, stock corrections, invoices, e-invoice submissions, courier bookings, review replies and posts appear here before anything is executed."
            />
          ) : (
            pending.map((a) => (
              <div
                key={a.id}
                className={cn(
                  'rounded-lg border bg-white p-4',
                  a.risk === 'high' ? 'border-red-200' : a.risk === 'medium' ? 'border-amber-200' : 'border-slate-200',
                )}
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone="blue">{TYPE_LABEL[a.type] ?? a.type}</Pill>
                      <StatusPill status={a.risk} label={`${a.risk} risk`} />
                      {a.amount ? <span className="text-sm font-semibold">{money(a.amount)}</span> : null}
                    </div>
                    <div className="mt-1.5 text-sm font-semibold">{a.title}</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{a.description}</p>
                    <div className="mt-2">
                      <Preview a={a} db={db} />
                    </div>
                    <div className="mt-2 text-[11px] text-slate-400">
                      Requested by {a.requestedBy} · {fmtDateTime(a.createdAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {!can.manage && <span className="text-xs text-slate-500">Only the owner or a manager can decide ({role} access)</span>}
                    <Button size="sm" variant="outline" disabled={!!busy || !can.manage} onClick={() => act(a.id, reject)}>
                      <X className="mr-1 h-4 w-4" /> Reject
                    </Button>
                    <Button size="sm" className={primaryBtn} disabled={!!busy || !can.manage} onClick={() => act(a.id, approve)}>
                      {busy === a.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
                      Approve
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {db.approvals.filter((a) => a.status !== 'pending').length === 0 ? (
            <EmptyState icon={History} title="No decisions yet" body="Approved and rejected actions, and whether they executed successfully, are listed here." />
          ) : (
            <SectionCard
              title="Decision history"
              actions={
                <select
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as 'all' | ApprovalType)}
                >
                  <option value="all">All types</option>
                  {(Object.keys(TYPE_LABEL) as ApprovalType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Decided</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Execution</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {decided.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {a.decidedAt ? fmtDateTime(a.decidedAt) : '—'}
                        {a.decidedBy && <div className="text-slate-400">{a.decidedBy}</div>}
                      </TableCell>
                      <TableCell className="text-xs">{TYPE_LABEL[a.type] ?? a.type}</TableCell>
                      <TableCell className="min-w-48 whitespace-normal break-words max-w-80 text-sm">{a.title}</TableCell>
                      <TableCell className="text-right text-sm">{a.amount ? money(a.amount) : '—'}</TableCell>
                      <TableCell>
                        <StatusPill status={a.status} />
                      </TableCell>
                      <TableCell className="min-w-48 whitespace-normal break-words max-w-72 text-xs">
                        {a.status === 'approved' ? (
                          <>
                            <StatusPill status={a.executionStatus ?? 'not_started'} label={(a.executionStatus ?? 'not started').replace('_', ' ')} />
                            {a.executionResult && (
                              <div className={cn('mt-1', a.executionStatus === 'failed' ? 'text-red-600' : 'text-slate-600')}>{a.executionResult}</div>
                            )}
                          </>
                        ) : (
                          <span className="text-slate-400">{a.executionResult ?? '—'}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {decided.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-sm text-slate-500">
                        No decisions of this type.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          {db.auditLog.length === 0 ? (
            <EmptyState icon={ScrollText} title="Audit log is empty" body="Every change made by you, the server or WorkBuddy is recorded here with who did it and when." />
          ) : (
            <SectionCard
              title="Audit log"
              description={`${audit.length} entr${audit.length === 1 ? 'y' : 'ies'}${audit.length > 500 ? ', latest 500 shown' : ''}`}
              actions={<Input className="h-8 w-60" placeholder="Search actor, action, record" value={auditQ} onChange={(e) => setAuditQ(e.target.value)} />}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Record</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audit.slice(0, 500).map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(e.at)}</TableCell>
                      <TableCell className="text-xs">{e.actor}</TableCell>
                      <TableCell>
                        <Pill>{e.action.replace(/_/g, ' ')}</Pill>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {e.entity.replace(/_/g, ' ')}
                        {e.entityId && e.entityId.length < 20 ? ` · ${e.entityId}` : ''}
                      </TableCell>
                      <TableCell className="text-sm">{e.details}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SectionCard>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
