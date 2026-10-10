import { WarehouseTab } from '@/components/bizpilot/WarehouseTab';
import { AgentPanel } from '@/components/bizpilot/AgentPanel';
import { useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  ClipboardList,
  Download,
  HeartPulse,
  ShieldAlert,
  Upload,
  History,
  PackagePlus,
  Pencil,
  Plus,
  ScanBarcode,
  ShoppingBasket,
} from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { availableStock, daysOfStockLeft, inventoryAlerts, stockValuation } from '@/lib/metrics';
import { importProductsCsv, productsToCsv } from '@/lib/csv';
import { fmtDateTime, money } from '@/lib/format';
import type { Product } from '@/lib/db/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/layout/AppShell';
import { cn } from '@/lib/utils';
import { EmptyState, Pill, SectionCard, primaryBtn } from '@/components/bizpilot/common';
import { ProductDialog } from '@/components/bizpilot/ProductDialog';
import { StockDialog, type StockMode } from '@/components/bizpilot/StockDialog';
import { draftPOForApproval } from '@/components/bizpilot/actions';
import { LocationsTab } from '@/components/bizpilot/LocationsTab';
import { StockCountsTab } from '@/components/bizpilot/StockCountsTab';

function stockBadge(p: Product, lowDays: number) {
  const avail = availableStock(p);
  const days = daysOfStockLeft(p);
  if (p.status === 'discontinued') return <Pill tone="slate">Discontinued</Pill>;
  if (p.status === 'draft') return <Pill tone="slate">Draft</Pill>;
  if (avail <= 0) return <Pill tone="red">Out of stock</Pill>;
  if (avail <= p.reorderLevel) return <Pill tone="amber">Low</Pill>;
  if (days <= lowDays) return <Pill tone="amber">Watch</Pill>;
  return <Pill tone="green">Healthy</Pill>;
}

export function Inventory() {
  const { db, run } = useBizPilot();
  const [productDialog, setProductDialog] = useState<{ open: boolean; product: Product | null; barcode?: string }>({
    open: false,
    product: null,
  });
  const [stockDialog, setStockDialog] = useState<{ open: boolean; mode: StockMode; productId: string | null }>({
    open: false,
    mode: 'in',
    productId: null,
  });
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [scanMiss, setScanMiss] = useState<string | null>(null);
  const [mvFilter, setMvFilter] = useState('');
  const [qtyOverride, setQtyOverride] = useState<Record<string, string>>({});

  const suggestions = useMemo(() => ops.reorderSuggestions(db), [db]);
  const alerts = useMemo(() => inventoryAlerts(db), [db]);
  const valuation = useMemo(() => stockValuation(db), [db]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const exportCsv = () => {
    const blob = new Blob([productsToCsv(db)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bizpilot-products-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    let errs: string[] = [];
    run((d, a) => {
      const r = importProductsCsv(d, text, a);
      errs = r.errors;
      if (r.errors.length) throw new ops.OpError(`Nothing imported: ${r.errors.length} problem(s) found. See the list below.`);
      return r;
    }, 'Catalogue imported');
    setImportErrors(errs);
  };

  const q = query.trim().toLowerCase();
  const products = db.products.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      (p.barcode && p.barcode.includes(query.trim())) ||
      Object.values(p.channelSkus ?? {}).some((s) => s.toLowerCase().includes(q)),
  );

  const onScanEnter = () => {
    const code = query.trim();
    if (!code) return;
    const p = ops.findProduct(db, code);
    if (p) {
      setHighlight(p.id);
      setScanMiss(null);
      setTimeout(() => document.getElementById(`prod-${p.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    } else {
      setHighlight(null);
      setScanMiss(code);
    }
  };

  const openStock = (mode: StockMode, productId: string | null = null) => setStockDialog({ open: true, mode, productId });

  const totalValue = db.products.reduce((s, p) => s + p.stock * p.unitCost, 0);
  const movements = db.stockMovements.filter((m) => !mvFilter || m.productId === mvFilter);

  // group reorder suggestions by supplier
  const groups = new Map<string, typeof suggestions>();
  for (const s of suggestions) {
    const key = s.make ? '__make' : s.supplier?.id ?? '__none';
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  const draftPO = (supplierId: string, items: typeof suggestions) => {
    const lines = items
      .map((s) => ({
        productId: s.product.id,
        quantity: Math.round(Number(qtyOverride[s.product.id] ?? s.suggestedQty)),
        unitCost: s.product.unitCost || s.supplier?.unitCost || 0,
      }))
      .filter((l) => l.quantity > 0);
    if (!lines.length) return;
    run((d, a) => draftPOForApproval(d, { supplierId, lines, note: 'Drafted from reorder suggestions' }, a), 'Draft PO sent to Approvals');
  };
  const planProduction = (items: typeof suggestions) => {
    const lines = items.map((s) => ({ productId: s.product.id, quantity: Math.round(Number(qtyOverride[s.product.id] ?? s.suggestedQty)) })).filter((l) => l.quantity > 0);
    if (!lines.length) return;
    run((d, a) => lines.map((l) => ops.createProductionOrder(d, l, a)), 'Production orders sent to Approvals (see Supply Chain → Production)');
  };

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle={
          db.products.length
            ? `${db.products.length} products · stock value ${money(totalValue)} at cost`
            : 'What you own, where it is, and how fast it sells'
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => openStock('in')} disabled={!db.products.length}>
              <ArrowDownToLine className="mr-1 h-4 w-4" /> Stock in
            </Button>
            <Button size="sm" variant="outline" onClick={() => openStock('out')} disabled={!db.products.length}>
              <ArrowUpFromLine className="mr-1 h-4 w-4" /> Stock out
            </Button>
            <Button size="sm" variant="outline" onClick={() => openStock('count')} disabled={!db.products.length}>
              <ClipboardList className="mr-1 h-4 w-4" /> Stock count
            </Button>
            <Button size="sm" variant="outline" onClick={() => openStock('hold')} disabled={!db.products.length}>
              <ShieldAlert className="mr-1 h-4 w-4" /> Damaged / held
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} title="Import products from a CSV file">
              <Upload className="mr-1 h-4 w-4" /> Import CSV
            </Button>
            <Button size="sm" variant="outline" onClick={exportCsv} title="Download the catalogue as CSV (also the import template)">
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                void importCsv(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button size="sm" className={primaryBtn} onClick={() => setProductDialog({ open: true, product: null })}>
              <Plus className="mr-1 h-4 w-4" /> Add product
            </Button>
          </>
        }
      />
      <AgentPanel page="inventory" className="mb-4" />

      {importErrors.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm">
          <div className="mb-1 flex items-center justify-between">
            <b>CSV not imported. Fix these rows and try again:</b>
            <Button size="sm" variant="ghost" onClick={() => setImportErrors([])}>Dismiss</Button>
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-red-800">
            {importErrors.slice(0, 30).map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm">
          <b>{suggestions.length} product(s) need replenishing.</b>{' '}
          <span className="text-slate-600">See the Reorder tab to draft purchase orders — each waits for your approval.</span>
        </div>
      )}

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="health">
            Stock health{alerts.some((a) => a.severity !== 'info') && <Badge className="ml-1.5 h-4 bg-red-500 px-1.5 text-[10px]">{alerts.filter((a) => a.severity !== 'info').length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="locations">
            Locations &amp; transfers{db.transfers.some((t) => t.status === 'in_transit') && <Badge className="ml-1.5 h-4 bg-blue-500 px-1.5 text-[10px]">{db.transfers.filter((t) => t.status === 'in_transit').length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="warehouse">Warehouse{(db.staffTasks ?? []).some((t) => t.status === 'open') ? ' •' : ''}</TabsTrigger>
          <TabsTrigger value="counts">Stock counts</TabsTrigger>
          <TabsTrigger value="movements">Movement history</TabsTrigger>
          <TabsTrigger value="reorder">
            Reorder{suggestions.length > 0 && <Badge className="ml-1.5 h-4 bg-amber-500 px-1.5 text-[10px]">{suggestions.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="mt-4">
          {db.products.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No products yet"
              body="Add your first product with its cost, price and opening stock. Imported marketplace orders are matched to products by their channel SKUs."
              actionLabel="Add your first product"
              onAction={() => setProductDialog({ open: true, product: null })}
            />
          ) : (
            <SectionCard
              title="Products"
              description="Available = on hand − reserved for orders − held (damaged, expired, quarantined). Days left uses the last 28 days of real sales."
              actions={
                <div className="relative">
                  <ScanBarcode className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <Input
                    className="h-9 w-72 pl-8"
                    placeholder="Search or scan barcode / SKU, then Enter"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setScanMiss(null);
                      setHighlight(null);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && onScanEnter()}
                  />
                </div>
              }
            >
              {scanMiss && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm">
                  <span>
                    No product has barcode or SKU <b>{scanMiss}</b>.
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setProductDialog({ open: true, product: null, barcode: scanMiss })}>
                    Add product with this barcode
                  </Button>
                </div>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Incoming</TableHead>
                      <TableHead className="text-right">Sold/day</TableHead>
                      <TableHead className="text-right">Days left</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((p) => {
                      const days = daysOfStockLeft(p);
                      const supplier = db.suppliers.find((s) => s.id === p.supplierId);
                      return (
                        <TableRow key={p.id} id={`prod-${p.id}`} className={cn(highlight === p.id && 'bg-teal-50')}>
                          <TableCell>
                            <div className="font-medium">{p.name}</div>
                            <div className="text-[11px] text-slate-500">
                              {p.sku} · {p.category}
                              {p.barcode ? ` · ${p.barcode}` : ''}
                              {supplier ? ` · ${supplier.name}` : ''}
                              {p.expiryDate ? ` · exp ${p.expiryDate}` : ''}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {money(p.price)}
                            <div className="text-[11px] text-slate-400">cost {money(p.unitCost)}</div>
                          </TableCell>
                          <TableCell className="text-right">
                            {p.stock}
                            {p.unavailable > 0 && <div className="text-[11px] text-red-600">{p.unavailable} held</div>}
                          </TableCell>
                          <TableCell className="text-right text-slate-500">{p.reserved}</TableCell>
                          <TableCell className="text-right font-medium">{availableStock(p)}</TableCell>
                          <TableCell className="text-right text-slate-500">{p.incoming}</TableCell>
                          <TableCell className="text-right text-slate-500">{p.avgDailySales}</TableCell>
                          <TableCell className="text-right">
                            {Number.isFinite(days) ? days : <span className="text-xs text-slate-400">no sales</span>}
                          </TableCell>
                          <TableCell>{stockBadge(p, db.settings.lowStockThresholdDays)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="icon-sm" variant="ghost" title="Stock in" onClick={() => openStock('in', p.id)}>
                                <ArrowDownToLine className="h-4 w-4" />
                              </Button>
                              <Button size="icon-sm" variant="ghost" title="Stock out" onClick={() => openStock('out', p.id)}>
                                <ArrowUpFromLine className="h-4 w-4" />
                              </Button>
                              <Button size="icon-sm" variant="ghost" title="Stock count" onClick={() => openStock('count', p.id)}>
                                <ClipboardList className="h-4 w-4" />
                              </Button>
                              <Button size="icon-sm" variant="ghost" title="Edit" onClick={() => setProductDialog({ open: true, product: p })}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {products.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={10} className="py-6 text-center text-sm text-slate-500">
                          No products match “{query}”.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="health" className="mt-4 space-y-4">
          <SectionCard
            title="Stock alerts"
            description="Out of stock, running low, expiring within 30 days, expired, slow-moving and held stock. Calculated from your real records."
          >
            {alerts.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-500">
                <HeartPulse className="mx-auto mb-2 h-6 w-6 text-teal-600" />
                No stock problems found.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Alert</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alerts.map((a, i) => (
                    <TableRow key={`${a.product.id}-${a.kind}-${i}`}>
                      <TableCell className="font-medium">{a.product.name}</TableCell>
                      <TableCell>
                        <Pill tone={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'amber' : 'slate'}>{a.kind.replace(/_/g, ' ')}</Pill>
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{a.detail}</TableCell>
                      <TableCell className="text-right">
                        {a.kind === 'expired' && (
                          <Button size="sm" variant="outline" onClick={() => openStock('hold', a.product.id)}>Hold stock</Button>
                        )}
                        {a.kind === 'held' && (
                          <Button size="sm" variant="outline" onClick={() => openStock('out', a.product.id)}>Write off</Button>
                        )}
                        {(a.kind === 'out_of_stock' || a.kind === 'low_stock') && suggestions.some((s) => s.product.id === a.product.id) && (
                          <span className="text-xs text-slate-500">See Reorder tab</span>
                        )}
                        {(a.kind === 'expiring' || a.kind === 'no_sales' || a.kind === 'slow_moving') && (
                          <span className="text-xs text-slate-500">Promote or discount it</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>

          <SectionCard
            title="Stock valuation"
            description={`${valuation.units} units on hand · ${money(valuation.totalCost)} at cost · ${money(valuation.totalRetail)} at selling price (sellable units)${valuation.totalHeld > 0 ? ` · ${money(valuation.totalHeld)} held as not sellable` : ''}`}
          >
            {valuation.rows.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-500">No stock on hand.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Value at cost</TableHead>
                      <TableHead className="text-right">Value at price</TableHead>
                      <TableHead className="text-right">Potential profit</TableHead>
                      <TableHead className="text-right">Held value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {valuation.rows.map((r) => (
                      <TableRow key={r.product.id}>
                        <TableCell className="font-medium">{r.product.name}</TableCell>
                        <TableCell className="text-right">{r.onHand}</TableCell>
                        <TableCell className="text-right">{money(r.costValue)}</TableCell>
                        <TableCell className="text-right">{money(r.retailValue)}</TableCell>
                        <TableCell className={cn('text-right', r.retailValue - (r.costValue - r.heldValue) < 0 && 'text-red-600')}>
                          {money(r.retailValue - (r.costValue - r.heldValue))}
                        </TableCell>
                        <TableCell className="text-right text-slate-500">{r.heldValue > 0 ? money(r.heldValue) : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="movements" className="mt-4">
          {db.stockMovements.length === 0 ? (
            <EmptyState
              icon={History}
              title="No stock movements yet"
              body="Every change to on-hand stock — opening stock, sales, receipts, write-offs and count corrections — is logged here."
              actionLabel={db.products.length ? 'Record stock in' : 'Add a product first'}
              onAction={() => (db.products.length ? openStock('in') : setProductDialog({ open: true, product: null }))}
            />
          ) : (
            <SectionCard
              title="Movement history"
              description={`${movements.length} movement(s)${movements.length > 300 ? ', latest 300 shown' : ''}`}
              actions={
                <select
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
                  value={mvFilter}
                  onChange={(e) => setMvFilter(e.target.value)}
                >
                  <option value="">All products</option>
                  {db.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.slice(0, 300).map((m) => {
                    const p = db.products.find((x) => x.id === m.productId);
                    const signed = m.type === 'out' ? -m.quantity : m.type === 'transfer' ? 0 : m.quantity;
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(m.date)}</TableCell>
                        <TableCell>{p?.name ?? <span className="text-slate-400">deleted product</span>}</TableCell>
                        <TableCell>
                          <Pill tone={m.type === 'in' ? 'green' : m.type === 'out' ? 'red' : m.type === 'transfer' ? 'blue' : 'amber'}>{m.type}</Pill>
                        </TableCell>
                        <TableCell className={cn('text-right font-medium', signed < 0 ? 'text-red-600' : m.type === 'transfer' ? 'text-slate-600' : 'text-teal-700')}>
                          {m.type === 'transfer' ? `${m.quantity} moved` : `${signed > 0 ? '+' : ''}${signed}`}
                        </TableCell>
                        <TableCell className="text-sm">
                          {m.reason}
                          {m.locationId && m.type !== 'transfer' && <span className="text-xs text-slate-400"> · {db.locations.find((l) => l.id === m.locationId)?.name ?? (m.locationId === ops.IN_TRANSIT ? 'in transit' : '')}</span>}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">{m.reference}</TableCell>
                        <TableCell className="text-xs text-slate-500">{m.actor}</TableCell>
                      </TableRow>
                    );
                  })}
                  {movements.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6 text-center text-sm text-slate-500">
                        No movements for this product.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="locations" className="mt-4"><LocationsTab /></TabsContent>
        <TabsContent value="warehouse" className="mt-4"><WarehouseTab /></TabsContent>
        <TabsContent value="counts" className="mt-4"><StockCountsTab /></TabsContent>

        <TabsContent value="reorder" className="mt-4 space-y-4">
          {suggestions.length === 0 ? (
            <EmptyState
              icon={ShoppingBasket}
              title={db.products.length ? 'Nothing needs reordering' : 'No products yet'}
              body={
                db.products.length
                  ? 'Suggestions appear when available + incoming stock falls to the reorder level, or projected days of stock fall below the supplier lead time.'
                  : 'Add products and set reorder levels to get replenishment suggestions.'
              }
              actionLabel={db.products.length ? undefined : 'Add your first product'}
              onAction={db.products.length ? undefined : () => setProductDialog({ open: true, product: null })}
            />
          ) : (
            [...groups.entries()].map(([key, items]) => {
              const supplier = items[0].supplier;
              const make = key === '__make';
              const total = items.reduce(
                (s, it) => s + Number(qtyOverride[it.product.id] ?? it.suggestedQty) * (it.product.unitCost || supplier?.unitCost || 0),
                0,
              );
              return (
                <SectionCard
                  key={key}
                  title={make ? 'Made in-house' : supplier ? supplier.name : 'No supplier assigned'}
                  description={
                    make
                      ? 'These have a recipe, so they are replenished by production. Materials are checked before production starts.'
                      : supplier
                      ? `Lead time ${supplier.leadTimeDays} days · MOQ ${supplier.minOrderQty} · estimated ${money(total)}`
                      : 'Assign a supplier to these products (Edit product) to draft a PO.'
                  }
                  actions={
                    make ? (
                      <Button size="sm" className={primaryBtn} onClick={() => planProduction(items)}>
                        <PackagePlus className="mr-1 h-4 w-4" /> Plan production for approval
                      </Button>
                    ) : supplier ? (
                      <Button size="sm" className={primaryBtn} onClick={() => draftPO(supplier.id, items)}>
                        <PackagePlus className="mr-1 h-4 w-4" /> Draft PO for approval
                      </Button>
                    ) : undefined
                  }
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Available</TableHead>
                        <TableHead className="text-right">Incoming</TableHead>
                        <TableHead className="text-right">Days left</TableHead>
                        <TableHead>Urgency</TableHead>
                        <TableHead>Why</TableHead>
                        <TableHead className="w-28 text-right">Order qty</TableHead>
                        <TableHead className="text-right">Unit cost</TableHead>
                        {!supplier && !make && <TableHead />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((s) => (
                        <TableRow key={s.product.id}>
                          <TableCell className="font-medium">{s.product.name}</TableCell>
                          <TableCell className="text-right">{s.available}</TableCell>
                          <TableCell className="text-right">{s.product.incoming}</TableCell>
                          <TableCell className="text-right">
                            {s.daysLeft ?? '—'}
                            {s.stockoutDate && <div className="text-[11px] text-slate-400">out ~{s.stockoutDate}</div>}
                          </TableCell>
                          <TableCell>
                            <Pill tone={s.urgency === 'stockout_risk' ? 'red' : s.urgency === 'reorder_now' ? 'amber' : 'slate'}>
                              {s.urgency === 'stockout_risk' ? 'Stockout risk' : s.urgency === 'reorder_now' ? 'Reorder now' : 'Watch'}
                            </Pill>
                          </TableCell>
                          <TableCell className="min-w-48 whitespace-normal break-words max-w-xs text-xs text-slate-500">{s.reason}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              min="0"
                              className="ml-auto h-8 w-24 text-right"
                              value={qtyOverride[s.product.id] ?? String(s.suggestedQty)}
                              onChange={(e) => setQtyOverride((o) => ({ ...o, [s.product.id]: e.target.value }))}
                            />
                          </TableCell>
                          <TableCell className="text-right">{money(s.product.unitCost || supplier?.unitCost || 0)}</TableCell>
                          {!supplier && !make && (
                            <TableCell className="text-right">
                              <Button size="sm" variant="outline" onClick={() => setProductDialog({ open: true, product: s.product })}>
                                Set supplier
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </SectionCard>
              );
            })
          )}
        </TabsContent>
      </Tabs>

      <ProductDialog
        open={productDialog.open}
        onOpenChange={(o) => setProductDialog((s) => ({ ...s, open: o }))}
        product={productDialog.product}
        initialBarcode={productDialog.barcode}
      />
      <StockDialog
        open={stockDialog.open}
        onOpenChange={(o) => setStockDialog((s) => ({ ...s, open: o }))}
        mode={stockDialog.mode}
        productId={stockDialog.productId}
      />
    </div>
  );
}
