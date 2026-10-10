import { useState } from 'react';
import { CheckCircle2, Factory, Pencil, Play, Plus, ShoppingCart, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { Product, ProductionOrder } from '@/lib/db/types';
import { fmtDate, money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Field, Pill, SectionCard, SimpleSelect, StatusPill, primaryBtn } from './common';

/** Render-safe: a deleted material shows as a problem instead of breaking the page. */
function shortages(db: Parameters<typeof ops.materialRequirements>[0], o: ProductionOrder) {
  try {
    return ops.materialRequirements(db, o.productId, o.quantity, o.locationId, o.id).filter((m) => m.shortage > 0).map((m) => `${m.shortage} ${m.product.name}`);
  } catch (e) {
    return [e instanceof Error ? e.message : 'Recipe problem'];
  }
}

const STATUS_LABEL: Record<ProductionOrder['status'], string> = {
  pending_approval: 'waiting for approval',
  approved: 'approved',
  in_progress: 'in production',
  completed: 'completed',
  cancelled: 'cancelled',
};

/** Blueprint A2: recipes (bill of materials), production orders, shortage checks, QC and costing. */
const canMake = (db: Parameters<typeof ops.maxProducible>[0], p: Product) => {
  try { return ops.maxProducible(db, p); } catch { return 0; }
};

export function ProductionTab() {
  const { db, run } = useBizPilot();
  const [recipe, setRecipe] = useState<Product | 'new' | null>(null);
  const [plan, setPlan] = useState<{ productId?: string; quantity?: number } | null>(null);
  const [completing, setCompleting] = useState<ProductionOrder | null>(null);
  const made = db.products.filter((p) => p.bom?.length);
  const name = (id: string) => db.products.find((p) => p.id === id)?.name ?? 'item';
  const where = (id: string) => (id ? db.locations.find((l) => l.id === id)?.name ?? '' : '');
  const toMake = ops.reorderSuggestions(db).filter((s) => s.make);
  const orders = db.productionOrders ?? [];

  const buyMaterials = (o: ProductionOrder) => {
    const r = run((d, a) => ops.draftMaterialPurchases(d, o.id, a));
    if (!r) return;
    if (r.purchaseOrders.length) toast.success(`${r.purchaseOrders.map((p) => p.poNumber).join(', ')} sent to Approvals`);
    if (r.noSupplier.length) toast.warning(`No supplier set for ${r.noSupplier.join(', ')}. Set one on the product to order it.`);
  };

  if (!made.length && !orders.length) {
    return (
      <>
        <EmptyState
          icon={Factory}
          title="Do you make or assemble your products?"
          body="Add a recipe: the materials (also products in Inventory) and quantities used to make one unit, plus labour and overhead. BizPilot then works out the cost per unit, checks materials before production and drafts purchase orders for anything short."
          actionLabel="Add a recipe"
          onAction={() => setRecipe('new')}
        />
        {recipe && <RecipeDialog product={recipe === 'new' ? null : recipe} onClose={() => setRecipe(null)} />}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {toMake.length > 0 && (
        <SectionCard title="Suggested production" description="Made products below their reorder level, counting what is already planned.">
          <div className="space-y-2">
            {toMake.map((s) => {
              const can = canMake(db, s.product);
              return (
                <div key={s.product.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm">
                  <span className="flex-1">
                    Make <b>{s.suggestedQty}× {s.product.name}</b>
                    <span className="ml-2 text-xs text-slate-500">{s.reason} Materials on hand make {can}.</span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setPlan({ productId: s.product.id, quantity: s.suggestedQty })}>Plan</Button>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Production orders"
        description="Each run waits in Approvals. Starting takes the materials from stock; completing adds the good units at their actual cost."
        actions={<Button size="sm" className={primaryBtn} disabled={!made.length} onClick={() => setPlan({})}><Plus className="mr-1 h-4 w-4" /> Plan production</Button>}
      >
        {orders.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-500">No production orders yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Materials</TableHead>
                <TableHead className="text-right">Cost / unit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.slice(0, 100).map((o) => {
                const open = o.status === 'pending_approval' || o.status === 'approved';
                const short = open ? shortages(db, o) : [];
                return (
                  <TableRow key={o.id}>
                    <TableCell className="whitespace-nowrap">
                      <div className="font-medium">{o.orderNumber}</div>
                      <div className="text-xs text-slate-400">{o.dueDate ? `due ${fmtDate(o.dueDate)}` : fmtDate(o.createdAt)}{where(o.locationId) ? ` · ${where(o.locationId)}` : ''}</div>
                    </TableCell>
                    <TableCell>
                      {o.quantity}× {name(o.productId)}
                      {o.status === 'completed' && <div className="text-xs text-slate-500">{o.goodQty} good{o.rejectedQty ? `, ${o.rejectedQty} rejected` : ''} · batch {o.batchNumber}</div>}
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal break-words max-w-xs text-xs">
                      {open ? (
                        short.length ? <span className="text-red-600">Short: {short.join(', ')}</span> : <span className="text-teal-700">All in stock</span>
                      ) : (
                        <span className="text-slate-500">{o.materials.map((m) => `${m.consumed || m.required} ${name(m.productId)}`).join(', ')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {o.status === 'completed' && o.goodQty ? (
                        <span className={o.actualUnitCost > o.plannedUnitCost * 1.05 ? 'text-red-600' : ''}>{money(o.actualUnitCost)}<div className="text-[11px] text-slate-400">plan {money(o.plannedUnitCost)}</div></span>
                      ) : money(o.plannedUnitCost)}
                    </TableCell>
                    <TableCell><StatusPill status={o.status} label={STATUS_LABEL[o.status]} /></TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {open && short.length > 0 && <Button size="sm" variant="outline" className="mr-1" onClick={() => buyMaterials(o)}><ShoppingCart className="mr-1 h-3.5 w-3.5" /> Buy materials</Button>}
                      {o.status === 'approved' && <Button size="sm" className={`mr-1 ${primaryBtn}`} disabled={short.length > 0} onClick={() => run((d, a) => ops.startProduction(d, o.id, a), `${o.orderNumber} started`)}><Play className="mr-1 h-3.5 w-3.5" /> Start</Button>}
                      {o.status === 'in_progress' && <Button size="sm" className={`mr-1 ${primaryBtn}`} onClick={() => setCompleting(o)}><CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Complete</Button>}
                      {(open || o.status === 'in_progress') && (
                        <Button size="sm" variant="ghost" title="Cancel" onClick={() => window.confirm(`Cancel ${o.orderNumber}?${o.status === 'in_progress' ? ' Materials taken will be returned to stock.' : ''}`) && run((d, a) => ops.cancelProduction(d, o.id, a), `${o.orderNumber} cancelled`)}><X className="h-4 w-4" /></Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title="Recipes"
        description="What one unit is made from. Labour and overhead are for costing only: keep recording wages and rent as expenses in Finance."
        actions={<Button size="sm" variant="outline" onClick={() => setRecipe('new')}><Plus className="mr-1 h-4 w-4" /> Add a recipe</Button>}
      >
        {made.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-500">No recipes yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Made from (per unit)</TableHead>
                <TableHead className="text-right">Cost / unit</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right">Can make now</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {made.map((p) => {
                const unit = ops.plannedUnitCost(db, p);
                const margin = p.price > 0 ? (p.price - unit) / p.price : null;
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}<div className="text-xs text-slate-400">{p.stock} in stock</div></TableCell>
                    <TableCell className="min-w-48 whitespace-normal break-words max-w-sm text-xs text-slate-600">{p.bom!.map((l) => `${l.quantity} ${name(l.productId)}`).join(', ')}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(unit)}</TableCell>
                    <TableCell className="text-right">{margin === null ? '—' : <Pill tone={margin < 0 ? 'red' : margin < 0.2 ? 'amber' : 'green'}>{Math.round(margin * 100)}%</Pill>}</TableCell>
                    <TableCell className="text-right tabular-nums">{canMake(db, p)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button size="sm" variant="outline" className="mr-1" onClick={() => setPlan({ productId: p.id })}>Plan</Button>
                      <Button size="sm" variant="ghost" title="Edit recipe" onClick={() => setRecipe(p)}><Pencil className="h-4 w-4" /></Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {recipe && <RecipeDialog product={recipe === 'new' ? null : recipe} onClose={() => setRecipe(null)} />}
      {plan && <PlanDialog initial={plan} onClose={() => setPlan(null)} />}
      {completing && <CompleteDialog order={completing} onClose={() => setCompleting(null)} />}
    </div>
  );
}

function RecipeDialog({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const { db, run } = useBizPilot();
  const [productId, setProductId] = useState(product?.id ?? '');
  const [lines, setLines] = useState<{ productId: string; quantity: string }[]>(
    product?.bom?.length ? product.bom.map((l) => ({ productId: l.productId, quantity: String(l.quantity) })) : [{ productId: '', quantity: '1' }],
  );
  const [labour, setLabour] = useState(String(product?.labourCost ?? 0));
  const [overhead, setOverhead] = useState(String(product?.overheadCost ?? 0));
  const target = db.products.find((p) => p.id === productId);
  const choices = db.products.filter((p) => p.id !== productId && p.status !== 'discontinued').map((p) => ({ value: p.id, label: `${p.name} (${p.sku})` }));
  const valid = lines.filter((l) => l.productId && Number(l.quantity) > 0);
  const material = valid.reduce((s, l) => s + Number(l.quantity) * (db.products.find((p) => p.id === l.productId)?.unitCost ?? 0), 0);
  const unit = material + (Number(labour) || 0) + (Number(overhead) || 0);
  const save = (remove = false) => {
    const input = remove ? { lines: [] } : { lines: valid.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })), labourCost: Number(labour) || 0, overheadCost: Number(overhead) || 0 };
    if (run((d, a) => ops.setBom(d, productId, input, a), remove ? 'Recipe removed' : 'Recipe saved')) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{product ? `Recipe for ${product.name}` : 'Add a recipe'}</DialogTitle>
          <DialogDescription>Materials are products in Inventory, so they have stock, a cost and a supplier. Quantities can be fractions, e.g. 0.25 kg.</DialogDescription>
        </DialogHeader>
        {!product && (
          <Field label="Product you make" hint="Add it in Inventory first if it isn't there.">
            <SimpleSelect value={productId} onChange={setProductId} options={db.products.filter((p) => p.status !== 'discontinued').map((p) => ({ value: p.id, label: `${p.name} (${p.sku})` }))} />
          </Field>
        )}
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-600">Materials for one unit</div>
          {lines.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="flex-1"><SimpleSelect value={l.productId} onChange={(v) => setLines((x) => x.map((y, j) => (j === i ? { ...y, productId: v } : y)))} options={choices} placeholder="Choose material…" /></div>
              <Input type="number" min={0} step="any" className="h-9 w-24" value={l.quantity} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, quantity: e.target.value } : y)))} />
              <Button size="sm" variant="ghost" onClick={() => setLines((x) => x.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setLines((x) => [...x, { productId: '', quantity: '1' }])}><Plus className="mr-1 h-4 w-4" /> Add material</Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Labour per unit (RM)"><Input type="number" min={0} step="0.01" value={labour} onChange={(e) => setLabour(e.target.value)} /></Field>
          <Field label="Overhead per unit (RM)" hint="Electricity, rent share, packaging…"><Input type="number" min={0} step="0.01" value={overhead} onChange={(e) => setOverhead(e.target.value)} /></Field>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          Cost per unit: <b>{money(unit)}</b> <span className="text-xs text-slate-500">(materials {money(material)})</span>
          {target && target.price > 0 && <span className="ml-2 text-xs text-slate-500">· selling at {money(target.price)}, margin {Math.round(((target.price - unit) / target.price) * 100)}%</span>}
        </div>
        <DialogFooter className="gap-2">
          {product?.bom?.length ? <Button variant="ghost" className="mr-auto text-red-600" onClick={() => window.confirm(`Remove the recipe? ${product.name} will be treated as bought in.`) && save(true)}>Remove recipe</Button> : null}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className={primaryBtn} disabled={!productId || !valid.length} onClick={() => save()}>Save recipe</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanDialog({ initial, onClose }: { initial: { productId?: string; quantity?: number }; onClose: () => void }) {
  const { db, run } = useBizPilot();
  const made = db.products.filter((p) => p.bom?.length);
  const active = db.locations.filter((l) => l.active);
  const [productId, setProductId] = useState(initial.productId ?? made[0]?.id ?? '');
  const [qty, setQty] = useState(String(initial.quantity ?? 1));
  const [locationId, setLocationId] = useState(active.find((l) => l.isDefault)?.id ?? '');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const n = Math.floor(Number(qty) || 0);
  const p = db.products.find((x) => x.id === productId);
  let needs: ops.MaterialNeed[] = [];
  let problem = '';
  try {
    if (p && n > 0) needs = ops.materialRequirements(db, p.id, n, locationId);
  } catch (e) {
    problem = e instanceof Error ? e.message : 'Recipe problem';
  }
  const unit = p ? ops.plannedUnitCost(db, p) : 0;
  const save = () => {
    if (run((d, a) => ops.createProductionOrder(d, { productId, quantity: n, locationId, dueDate: dueDate || undefined, note }, a), 'Production order sent to Approvals')) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Plan production</DialogTitle>
          <DialogDescription>The order goes to Approvals. Nothing leaves stock until you press Start.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Product" className="col-span-2"><SimpleSelect value={productId} onChange={setProductId} options={made.map((x) => ({ value: x.id, label: x.name }))} /></Field>
          <Field label="Quantity to make"><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Due date (optional)"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          {active.length > 1 && <Field label="Made at" className="col-span-2"><SimpleSelect value={locationId} onChange={setLocationId} options={active.map((l) => ({ value: l.id, label: l.name }))} /></Field>}
        </div>
        {needs.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Material</TableHead><TableHead className="text-right">Needed</TableHead><TableHead className="text-right">Available</TableHead><TableHead className="text-right">Short</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {needs.map((m) => (
                <TableRow key={m.product.id}>
                  <TableCell>{m.product.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.required}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.available}</TableCell>
                  <TableCell className={`text-right tabular-nums ${m.shortage ? 'font-medium text-red-600' : 'text-slate-400'}`}>{m.shortage || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {problem && <div className="text-xs text-red-600">{problem}</div>}
        {needs.some((m) => m.shortage) && <div className="text-xs text-amber-700">Some materials are short. After saving, press Buy materials on the order to draft purchase orders.</div>}
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="text-sm">Planned cost: <b>{money(unit * Math.max(n, 0))}</b> <span className="text-xs text-slate-500">({money(unit)} per unit)</span></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className={primaryBtn} disabled={!productId || n <= 0} onClick={save}>Send for approval</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompleteDialog({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const { db, run } = useBizPilot();
  const [good, setGood] = useState(String(order.quantity));
  const [rejected, setRejected] = useState('0');
  const [qc, setQc] = useState('');
  const [batch, setBatch] = useState(order.batchNumber);
  const [expiry, setExpiry] = useState('');
  const save = () => {
    const input = { goodQty: Math.floor(Number(good) || 0), rejectedQty: Math.floor(Number(rejected) || 0), qcNotes: qc, batchNumber: batch, expiryDate: expiry || undefined };
    if (run((d, a) => ops.completeProduction(d, order.id, input, a), `${order.orderNumber} completed`)) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Complete {order.orderNumber}</DialogTitle>
          <DialogDescription>{order.quantity}× {db.products.find((p) => p.id === order.productId)?.name}. Good units go into stock; rejected units are recorded for quality tracking.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Good units"><Input type="number" min={0} value={good} onChange={(e) => setGood(e.target.value)} /></Field>
          <Field label="Rejected in QC"><Input type="number" min={0} value={rejected} onChange={(e) => setRejected(e.target.value)} /></Field>
          <Field label="Batch number"><Input value={batch} onChange={(e) => setBatch(e.target.value)} /></Field>
          <Field label="Expiry date (optional)"><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
          <Field label="QC notes" className="col-span-2"><Input value={qc} onChange={(e) => setQc(e.target.value)} placeholder="e.g. 2 burnt, oven too hot" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className={primaryBtn} onClick={save}><CheckCircle2 className="mr-1 h-4 w-4" /> Complete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
