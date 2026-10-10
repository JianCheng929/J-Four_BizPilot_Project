import { useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  ClipboardList,
  History,
  PackagePlus,
  Pencil,
  Plus,
  ScanBarcode,
  ShoppingBasket,
} from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { availableStock, daysOfStockLeft } from '@/lib/metrics';
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
    const key = s.supplier?.id ?? '__none';
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
            <Button size="sm" className={primaryBtn} onClick={() => setProductDialog({ open: true, product: null })}>
              <Plus className="mr-1 h-4 w-4" /> Add product
            </Button>
          </>
        }
      />

      {suggestions.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm">
          <b>{suggestions.length} product(s) need replenishing.</b>{' '}
          <span className="text-slate-600">See the Reorder tab to draft purchase orders — each waits for your approval.</span>
        </div>
      )}

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
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
              description="Available = on hand − reserved for unfulfilled orders. Days left uses the last 28 days of real sales."
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
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {money(p.price)}
                            <div className="text-[11px] text-slate-400">cost {money(p.unitCost)}</div>
                          </TableCell>
                          <TableCell className="text-right">{p.stock}</TableCell>
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
                    const signed = m.type === 'out' ? -m.quantity : m.quantity;
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(m.date)}</TableCell>
                        <TableCell>{p?.name ?? <span className="text-slate-400">deleted product</span>}</TableCell>
                        <TableCell>
                          <Pill tone={m.type === 'in' ? 'green' : m.type === 'out' ? 'red' : 'amber'}>{m.type}</Pill>
                        </TableCell>
                        <TableCell className={cn('text-right font-medium', signed < 0 ? 'text-red-600' : 'text-teal-700')}>
                          {signed > 0 ? '+' : ''}
                          {signed}
                        </TableCell>
                        <TableCell className="text-sm">{m.reason}</TableCell>
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
              const total = items.reduce(
                (s, it) => s + Number(qtyOverride[it.product.id] ?? it.suggestedQty) * (it.product.unitCost || supplier?.unitCost || 0),
                0,
              );
              return (
                <SectionCard
                  key={key}
                  title={supplier ? supplier.name : 'No supplier assigned'}
                  description={
                    supplier
                      ? `Lead time ${supplier.leadTimeDays} days · MOQ ${supplier.minOrderQty} · estimated ${money(total)}`
                      : 'Assign a supplier to these products (Edit product) to draft a PO.'
                  }
                  actions={
                    supplier ? (
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
                        <TableHead>Why</TableHead>
                        <TableHead className="w-28 text-right">Order qty</TableHead>
                        <TableHead className="text-right">Unit cost</TableHead>
                        {!supplier && <TableHead />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((s) => (
                        <TableRow key={s.product.id}>
                          <TableCell className="font-medium">{s.product.name}</TableCell>
                          <TableCell className="text-right">{s.available}</TableCell>
                          <TableCell className="text-right">{s.product.incoming}</TableCell>
                          <TableCell className="text-right">{s.daysLeft ?? '—'}</TableCell>
                          <TableCell className="text-xs text-slate-500">{s.reason}</TableCell>
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
                          {!supplier && (
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
