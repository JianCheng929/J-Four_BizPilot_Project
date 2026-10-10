import { useState } from 'react';
import { toast } from 'sonner';
import { FileText, Loader2, MoreHorizontal, Plus, RefreshCw, ShoppingCart } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { fmtDateTime, money } from '@/lib/format';
import type { SalesOrder, SalesSource } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, MARKETPLACES, SOURCE_LABEL, SectionCard, SourceBadge, StatusPill, primaryBtn } from '../common';
import { SaleDialog } from '../SaleDialog';
import { ShippingDialog } from '../ShippingDialog';

interface SyncResult {
  orders?: { imported: number; updated: number };
  reviews?: { imported: number };
}

export function SalesTab({ onOpenInvoice }: { onOpenInvoice: (invoiceId: string) => void }) {
  const { db, run, callServer } = useBizPilot();
  const [saleOpen, setSaleOpen] = useState(false);
  const [shipping, setShipping] = useState<SalesOrder | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [tracking, setTracking] = useState<string | null>(null);
  const [source, setSource] = useState<'all' | SalesSource>('all');
  const [status, setStatus] = useState<'all' | SalesOrder['status']>('all');
  const [q, setQ] = useState('');

  const sync = async (provider: string, label: string) => {
    setSyncing(provider);
    const res = await callServer<SyncResult>(`/api/sync/${provider}`);
    setSyncing(null);
    if (res) {
      const o = res.orders ?? { imported: 0, updated: 0 };
      const r = res.reviews ? `, ${res.reviews.imported} new review(s)` : '';
      toast.success(`${label}: ${o.imported} new order(s), ${o.updated} updated${r}`);
    }
  };

  const track = async (o: SalesOrder) => {
    setTracking(o.id);
    const res = await callServer<{ status: string; lastEvent?: string }>('/api/shipping/track', { orderId: o.id });
    setTracking(null);
    if (res) toast.success(`${o.orderNumber}: ${res.status.replace(/_/g, ' ')}${res.lastEvent ? ` — ${res.lastEvent}` : ''}`);
  };

  const orders = db.salesOrders.filter((o) => {
    if (source !== 'all' && o.source !== source) return false;
    if (status !== 'all' && o.status !== status) return false;
    if (q) {
      const s = q.toLowerCase();
      return (
        o.orderNumber.toLowerCase().includes(s) ||
        o.customerName.toLowerCase().includes(s) ||
        (o.externalId ?? '').toLowerCase().includes(s) ||
        o.lines.some((l) => (l.name ?? '').toLowerCase().includes(s))
      );
    }
    return true;
  });
  const unmatched = db.salesOrders.filter((o) => o.status !== 'cancelled' && o.lines.some((l) => !l.productId));

  const syncButtons = (
    <>
      {MARKETPLACES.map((m) => (
        <Button key={m.id} size="sm" variant="outline" onClick={() => sync(m.id, m.label)} disabled={!!syncing}>
          {syncing === m.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          Sync {m.label}
        </Button>
      ))}
    </>
  );

  return (
    <div className="space-y-4">
      {db.salesOrders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="No sales recorded yet"
          body="Record a counter sale or an online order, or pull orders from your marketplaces once they're connected in Settings."
          actionLabel="Record your first sale"
          onAction={() => setSaleOpen(true)}
        >
          <div className="mt-3 flex flex-wrap justify-center gap-2">{syncButtons}</div>
        </EmptyState>
      ) : (
        <SectionCard
          title="Sales orders"
          description={`${orders.length} of ${db.salesOrders.length} order(s)`}
          actions={
            <>
              {syncButtons}
              <Button size="sm" className={primaryBtn} onClick={() => setSaleOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> New sale
              </Button>
            </>
          }
        >
          {unmatched.length > 0 && (
            <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {unmatched.length} imported order(s) contain items not matched to a product, so stock and cost of goods can't be tracked for them.
              Add the marketplace SKU to the product's channel SKUs in Inventory.
            </div>
          )}
          <div className="mb-3 flex flex-wrap gap-2">
            <Input className="h-8 w-56" placeholder="Search order, customer, item" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={source} onChange={(e) => setSource(e.target.value as 'all' | SalesSource)}>
              <option value="all">All sources</option>
              {(Object.keys(SOURCE_LABEL) as SalesSource[]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
            <select className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value as 'all' | SalesOrder['status'])}>
              <option value="all">All statuses</option>
              <option value="awaiting_fulfilment">Awaiting fulfilment</option>
              <option value="fulfilled">Fulfilled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Shipment</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.slice(0, 300).map((o) => {
                  const inv = o.invoiceId ? db.invoices.find((i) => i.id === o.invoiceId) : undefined;
                  return (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">
                        {o.orderNumber}
                        {o.externalId && <div className="text-[11px] font-normal text-slate-400">{o.externalId}</div>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(o.date)}</TableCell>
                      <TableCell>
                        <SourceBadge source={o.source} />
                      </TableCell>
                      <TableCell className="text-sm">{o.customerName || '—'}</TableCell>
                      <TableCell className="min-w-48 whitespace-normal break-words max-w-56 text-xs text-slate-600">
                        {o.lines.map((l) => `${l.quantity} × ${l.name ?? l.sku ?? 'item'}${l.productId ? '' : ' (unmatched)'}`).join(', ')}
                      </TableCell>
                      <TableCell className="text-right font-medium">{money(o.total)}</TableCell>
                      <TableCell className="text-xs">
                        <StatusPill status={o.paymentStatus} />
                        {o.paymentMethod && <div className="mt-0.5 text-slate-400">{o.paymentMethod}</div>}
                      </TableCell>
                      <TableCell>
                        <StatusPill status={o.status} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {o.shipment ? (
                          <>
                            <div className="font-medium">{o.shipment.courier}</div>
                            <div className="text-slate-500">
                              {o.shipment.status.replace(/_/g, ' ')}
                              {o.shipment.trackingNo ? ` · ${o.shipment.trackingNo}` : ''}
                            </div>
                          </>
                        ) : o.channel === 'online' ? (
                          <span className="text-slate-400">not booked</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon-sm" variant="ghost">
                              {tracking === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {o.status === 'awaiting_fulfilment' && (
                              <DropdownMenuItem onClick={() => run((d, a) => ops.fulfilSalesOrder(d, o.id, a), `${o.orderNumber} fulfilled`)}>
                                Mark fulfilled (deduct stock)
                              </DropdownMenuItem>
                            )}
                            {o.paymentStatus === 'pending' && o.status !== 'cancelled' && (
                              <DropdownMenuItem
                                onClick={() =>
                                  run((d, a) => ops.recordOrderPayment(d, o.id, a), 'Payment recorded')
                                }
                              >
                                Mark payment received
                              </DropdownMenuItem>
                            )}
                            {o.channel === 'online' && o.status !== 'cancelled' && (
                              <DropdownMenuItem onClick={() => setShipping(o)}>Courier quote &amp; booking</DropdownMenuItem>
                            )}
                            {o.shipment && (o.shipment.trackingNo || o.shipment.orderNo) && (
                              <DropdownMenuItem onClick={() => track(o)}>Track shipment</DropdownMenuItem>
                            )}
                            {inv ? (
                              <DropdownMenuItem onClick={() => onOpenInvoice(inv.id)}>
                                <FileText className="mr-1 h-3.5 w-3.5" /> View {inv.invoiceNumber}
                              </DropdownMenuItem>
                            ) : (
                              o.status !== 'cancelled' && (
                                <DropdownMenuItem
                                  onClick={() => {
                                    const created = run((d, a) => ops.createInvoiceFromOrder(d, o.id, {}, a), 'Draft invoice created');
                                    if (created) onOpenInvoice(created.id);
                                  }}
                                >
                                  Create invoice
                                </DropdownMenuItem>
                              )
                            )}
                            {o.status !== 'cancelled' && <DropdownMenuSeparator />}
                            {o.status === 'awaiting_fulfilment' && (
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => window.confirm(`Cancel ${o.orderNumber}? Reserved stock is released.`) && run((d, a) => ops.cancelSalesOrder(d, o.id, a, o.paymentStatus === 'paid'), `${o.orderNumber} cancelled`)}
                              >
                                Cancel order{o.paymentStatus === 'paid' ? ' & refund' : ''}
                              </DropdownMenuItem>
                            )}
                            {o.status === 'fulfilled' && (
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => window.confirm(`Refund ${o.orderNumber}? Items are returned to stock.`) && run((d, a) => ops.cancelSalesOrder(d, o.id, a, true), `${o.orderNumber} refunded`)}
                              >
                                Refund &amp; return to stock
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {orders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="py-6 text-center text-sm text-slate-500">
                      No orders match these filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      )}
      <SaleDialog open={saleOpen} onOpenChange={setSaleOpen} />
      <ShippingDialog order={shipping} onOpenChange={(o) => !o && setShipping(null)} />
    </div>
  );
}
