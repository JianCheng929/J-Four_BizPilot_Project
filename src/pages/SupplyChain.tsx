import { AgentPanel } from '@/components/bizpilot/AgentPanel';
import { useMemo, useState } from 'react';
import { AlertTriangle, ClipboardList, Factory, PackageCheck, Pencil, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { cashPosition, latePurchaseOrders } from '@/lib/metrics';
import { fmtDate, money, relDay } from '@/lib/format';
import type { BizPilotDB, PurchaseOrder, Supplier } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { EmptyState, Pill, SectionCard, StatusPill, primaryBtn } from '@/components/bizpilot/common';
import { SupplierDialog } from '@/components/bizpilot/SupplierDialog';
import { PurchaseOrderDialog } from '@/components/bizpilot/PurchaseOrderDialog';
import { ReceivePODialog } from '@/components/bizpilot/ReceivePODialog';
import { submitExistingPO } from '@/components/bizpilot/actions';
import { ReturnsTab } from '@/components/bizpilot/ReturnsTab';
import { ProductionTab } from '@/components/bizpilot/ProductionTab';

const PO_FILTERS = ['open', 'all', 'draft', 'pending_approval', 'ordered', 'partially_received', 'received', 'cancelled'] as const;

export function SupplyChain() {
  const { db, run } = useBizPilot();
  const [supplierDialog, setSupplierDialog] = useState<{ open: boolean; supplier: Supplier | null }>({ open: false, supplier: null });
  const [poDialog, setPoDialog] = useState<{ open: boolean; supplierId: string | null }>({ open: false, supplierId: null });
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const [poFilter, setPoFilter] = useState<(typeof PO_FILTERS)[number]>('open');
  const [tab, setTab] = useState('orders');

  const late = latePurchaseOrders(db);
  const lateIds = new Set(late.map((p) => p.id));

  // Supplier performance recalculated from real PO history (on a copy; display only)
  const stats = useMemo(() => {
    const copy = structuredClone({ suppliers: db.suppliers, purchaseOrders: db.purchaseOrders }) as unknown as BizPilotDB;
    ops.recalcSupplierStats(copy);
    return new Map(copy.suppliers.map((s) => [s.id, s]));
  }, [db.suppliers, db.purchaseOrders]);

  const pos = db.purchaseOrders.filter((po) =>
    poFilter === 'all'
      ? true
      : poFilter === 'open'
        ? !['received', 'cancelled'].includes(po.status)
        : po.status === poFilter,
  );

  const openSpend = db.purchaseOrders
    .filter((p) => ['ordered', 'partially_received', 'pending_approval', 'approved'].includes(p.status))
    .reduce((s, p) => s + p.totalCost, 0);

  const deleteSupplier = (s: Supplier) => {
    if (db.purchaseOrders.some((p) => p.supplierId === s.id)) {
      toast.error(`${s.name} has purchase orders on record and can't be deleted. Edit it instead.`);
      return;
    }
    if (!window.confirm(`Delete supplier ${s.name}?`)) return;
    run((d, a) => {
      d.suppliers = d.suppliers.filter((x) => x.id !== s.id);
      for (const p of d.products) if (p.supplierId === s.id) p.supplierId = null;
      ops.audit(d, a, 'delete', 'supplier', s.id, `Supplier deleted: ${s.name}`);
    }, 'Supplier deleted');
  };

  const cancelPO = (po: PurchaseOrder) => {
    if (!window.confirm(`Cancel ${po.poNumber}?`)) return;
    run((d, a) => {
      ops.cancelPurchaseOrder(d, po.id, a);
      // withdraw any pending approval for this PO
      for (const ap of d.approvals) {
        if (ap.status === 'pending' && ap.type === 'purchase_order' && ap.payload.purchaseOrderId === po.id) {
          ap.status = 'rejected';
          ap.decidedAt = new Date().toISOString();
          ap.decidedBy = a;
          ap.executionResult = 'Withdrawn: PO cancelled.';
        }
      }
    }, `${po.poNumber} cancelled`);
  };

  const supplierName = (id: string) => db.suppliers.find((s) => s.id === id)?.name ?? 'Unknown supplier';

  return (
    <div>
      <PageHeader
        title="Supply Chain"
        subtitle={
          db.suppliers.length
            ? `${db.suppliers.length} supplier(s) · ${money(openSpend)} in open purchase orders · ${money(cashPosition(db).balance)} money available`
            : 'Suppliers, purchase orders and deliveries'
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setSupplierDialog({ open: true, supplier: null })}>
              <Plus className="mr-1 h-4 w-4" /> Add supplier
            </Button>
            <Button
              size="sm"
              className={primaryBtn}
              disabled={!db.suppliers.length || !db.products.length}
              onClick={() => setPoDialog({ open: true, supplierId: null })}
            >
              <ClipboardList className="mr-1 h-4 w-4" /> New purchase order
            </Button>
          </>
        }
      />
      <AgentPanel page="supplychain" className="mb-4" />

      {late.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <b>{late.length} delivery(ies) late:</b>{' '}
            {late.map((po) => `${po.poNumber} from ${supplierName(po.supplierId)} (due ${relDay(po.expectedDate)})`).join('; ')}. Chase the
            supplier or receive the goods if they've arrived.
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="orders">Purchase orders</TabsTrigger>
          <TabsTrigger value="production">Production{(db.productionOrders ?? []).some((o) => o.status === 'in_progress') ? ` (${db.productionOrders.filter((o) => o.status === 'in_progress').length})` : ''}</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          <TabsTrigger value="compare">Compare suppliers</TabsTrigger>
          <TabsTrigger value="returns">Returns{db.returns.some((r) => r.status === 'open') ? ` (${db.returns.filter((r) => r.status === 'open').length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-4">
          {db.purchaseOrders.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No purchase orders yet"
              body={
                !db.suppliers.length
                  ? 'Add a supplier first, then raise purchase orders. Each PO goes to Approvals before it is placed.'
                  : !db.products.length
                    ? 'Add products in Inventory first, then raise a purchase order.'
                    : 'Raise a purchase order to restock. You can also draft POs from the Reorder tab in Inventory.'
              }
              actionLabel={!db.suppliers.length ? 'Add your first supplier' : db.products.length ? 'Create first PO' : undefined}
              onAction={
                !db.suppliers.length
                  ? () => setSupplierDialog({ open: true, supplier: null })
                  : db.products.length
                    ? () => setPoDialog({ open: true, supplierId: null })
                    : undefined
              }
            />
          ) : (
            <SectionCard
              title="Purchase orders"
              actions={
                <select
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
                  value={poFilter}
                  onChange={(e) => setPoFilter(e.target.value as (typeof PO_FILTERS)[number])}
                >
                  {PO_FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {f === 'open' ? 'Open' : f === 'all' ? 'All' : f.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              }
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Expected</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pos.map((po) => {
                      const isLate = lateIds.has(po.id);
                      return (
                        <TableRow key={po.id} className={cn(isLate && 'bg-amber-50/70')}>
                          <TableCell className="font-medium">{po.poNumber}</TableCell>
                          <TableCell>{supplierName(po.supplierId)}</TableCell>
                          <TableCell className="min-w-48 whitespace-normal break-words max-w-60 space-y-0.5 text-xs text-slate-600">
                            {po.lines.map((l, i) => {
                              const p = db.products.find((x) => x.id === l.productId);
                              const rec = l.receivedQty ? ` (${l.receivedQty} recv)` : '';
                              return <div key={i}>{`${l.quantity} × ${p?.name ?? 'item'}${rec}`}</div>;
                            })}
                          </TableCell>
                          <TableCell className="text-right">{money(po.totalCost)}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{fmtDate(po.createdAt)}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {fmtDate(po.expectedDate)}
                            {isLate && <div className="font-medium text-amber-700">Late · {relDay(po.expectedDate)}</div>}
                            {po.receivedAt && <div className="text-slate-400">recv {fmtDate(po.receivedAt)}</div>}
                          </TableCell>
                          <TableCell>
                            <StatusPill status={po.status} />
                            {(po.status === 'ordered' || po.status === 'partially_received') && (() => {
                              // Approving a PO places it in BizPilot; the supplier only gets it if it was emailed.
                              const res = db.approvals.find((a) => a.type === 'purchase_order' && a.executionResult?.startsWith(`${po.poNumber} `))?.executionResult ?? '';
                              const sent = /Emailed to/.test(res);
                              return (
                                <div className={cn('mt-1 text-xs', sent ? 'text-teal-700' : 'text-amber-700')}>
                                  {sent ? 'Emailed to supplier' : /Email to supplier failed/.test(res) ? 'Email failed: contact supplier' : 'Not sent: contact supplier'}
                                </div>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              {po.status === 'draft' && (
                                <Button size="sm" variant="outline" onClick={() => run((d, a) => submitExistingPO(d, po.id, a), 'Sent to Approvals')}>
                                  <Send className="mr-1 h-3.5 w-3.5" /> Submit
                                </Button>
                              )}
                              {(po.status === 'ordered' || po.status === 'partially_received') && (
                                <Button size="sm" className={primaryBtn} title="Receive goods" onClick={() => setReceiving(po)}>
                                  <PackageCheck className="mr-1 h-3.5 w-3.5" /> Receive
                                </Button>
                              )}
                              {!['received', 'cancelled'].includes(po.status) && (
                                <Button size="icon-sm" variant="ghost" title="Cancel PO" onClick={() => cancelPO(po)}>
                                  <XCircle className="h-4 w-4 text-red-600" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {pos.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="py-6 text-center text-sm text-slate-500">
                          No purchase orders with this status.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="production" className="mt-4">
          <ProductionTab />
        </TabsContent>

        <TabsContent value="suppliers" className="mt-4">
          {db.suppliers.length === 0 ? (
            <EmptyState
              icon={Factory}
              title="No suppliers yet"
              body="Add the companies you buy stock from — with MOQ, lead time and payment terms — so BizPilot can plan reorders."
              actionLabel="Add your first supplier"
              onAction={() => setSupplierDialog({ open: true, supplier: null })}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {db.suppliers.map((s) => {
                const products = db.products.filter((p) => p.supplierId === s.id);
                return (
                  <div key={s.id} className="rounded-lg border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold">{s.name}</div>
                        <div className="text-xs text-slate-500">
                          {[s.contactPerson, s.phone, s.email].filter(Boolean).join(' · ') || 'No contact details'}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button size="icon-sm" variant="ghost" title="Edit" onClick={() => setSupplierDialog({ open: true, supplier: s })}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" title="Delete" onClick={() => deleteSupplier(s)}>
                          <Trash2 className="h-4 w-4 text-slate-400" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-slate-400">Lead time</div>
                        <div className="font-medium">{s.leadTimeDays} days</div>
                      </div>
                      <div>
                        <div className="text-slate-400">MOQ</div>
                        <div className="font-medium">{s.minOrderQty}</div>
                      </div>
                      <div>
                        <div className="text-slate-400">Terms</div>
                        <div className="font-medium">{s.paymentTerms || '—'}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.categories.map((c) => (
                        <Pill key={c}>{c}</Pill>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px] text-slate-500">
                      {products.length ? `Supplies: ${products.map((p) => p.name).join(', ')}` : 'Not linked to any product yet'}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 w-full"
                      disabled={!db.products.length}
                      onClick={() => setPoDialog({ open: true, supplierId: s.id })}
                    >
                      New PO to {s.name}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="compare" className="mt-4">
          {db.suppliers.length === 0 ? (
            <EmptyState
              icon={Factory}
              title="Nothing to compare yet"
              body="Add suppliers to compare cost, MOQ, lead time and delivery performance."
              actionLabel="Add a supplier"
              onAction={() => setSupplierDialog({ open: true, supplier: null })}
            />
          ) : (
            <SectionCard
              title="Supplier comparison"
              description="On-time rate and reliability are calculated from received POs (60% on-time, 30% fill rate, 10% quality)."
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Supplier</TableHead>
                      <TableHead className="text-right">Unit cost</TableHead>
                      <TableHead className="text-right">MOQ</TableHead>
                      <TableHead className="text-right">Lead time</TableHead>
                      <TableHead className="text-right">POs received</TableHead>
                      <TableHead className="text-right">On-time</TableHead>
                      <TableHead className="text-right">Defect rate</TableHead>
                      <TableHead className="text-right">Reliability</TableHead>
                      <TableHead className="text-right">Total purchased</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...db.suppliers]
                      .sort((a, b) => (stats.get(b.id)?.reliabilityScore ?? 0) - (stats.get(a.id)?.reliabilityScore ?? 0))
                      .map((s) => {
                        const st = stats.get(s.id) ?? s;
                        const received = db.purchaseOrders.filter((p) => p.supplierId === s.id && p.receivedAt);
                        const spend = db.purchaseOrders
                          .filter((p) => p.supplierId === s.id && p.status !== 'cancelled' && p.status !== 'draft')
                          .reduce((t, p) => t + p.totalCost, 0);
                        const hasHistory = received.length > 0;
                        return (
                          <TableRow key={s.id}>
                            <TableCell className="font-medium">{s.name}</TableCell>
                            <TableCell className="text-right">{s.unitCost ? money(s.unitCost) : '—'}</TableCell>
                            <TableCell className="text-right">{s.minOrderQty}</TableCell>
                            <TableCell className="text-right">{s.leadTimeDays}d</TableCell>
                            <TableCell className="text-right">{received.length}</TableCell>
                            <TableCell className="text-right">{hasHistory ? `${Math.round(st.onTimeRate * 100)}%` : <span className="text-xs text-slate-400">no history</span>}</TableCell>
                            <TableCell className="text-right">{(s.defectRate * 100).toFixed(1)}%</TableCell>
                            <TableCell className="text-right">
                              {hasHistory ? (
                                <Pill tone={st.reliabilityScore >= 85 ? 'green' : st.reliabilityScore >= 65 ? 'amber' : 'red'}>{st.reliabilityScore}/100</Pill>
                              ) : (
                                <span className="text-xs text-slate-400">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">{money(spend)}</TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="returns" className="mt-4">
          <ReturnsTab />
        </TabsContent>
      </Tabs>

      <SupplierDialog
        open={supplierDialog.open}
        onOpenChange={(o) => setSupplierDialog((s) => ({ ...s, open: o }))}
        supplier={supplierDialog.supplier}
      />
      <PurchaseOrderDialog
        open={poDialog.open}
        onOpenChange={(o) => setPoDialog((s) => ({ ...s, open: o }))}
        supplierId={poDialog.supplierId}
      />
      <ReceivePODialog po={receiving} onOpenChange={(o) => !o && setReceiving(null)} />
    </div>
  );
}
