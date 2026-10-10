import { useState } from 'react';
import { ArrowRight, Check, MapPin, Pencil, Plus, Star, Truck, X } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { Location, StockTransfer } from '@/lib/db/types';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Field, Pill, SectionCard, SimpleSelect, StatusPill, primaryBtn } from './common';

const TYPE_LABEL: Record<Location['type'], string> = { store: 'Shop / branch', warehouse: 'Warehouse', online: 'Online fulfilment' };
const TYPE_OPTIONS = (Object.keys(TYPE_LABEL) as Location['type'][]).map((t) => ({ value: t, label: TYPE_LABEL[t] }));

/** Blueprint §3, A5, B5: shops and warehouses, stock at each, and transfers between them. */
export function LocationsTab() {
  const { db, run } = useBizPilot();
  const [editing, setEditing] = useState<Location | 'new' | null>(null);
  const [transferOpen, setTransferOpen] = useState<{ from?: string; to?: string; productId?: string; qty?: number } | null>(null);
  const [receiving, setReceiving] = useState<StockTransfer | null>(null);
  const active = db.locations.filter((l) => l.active);
  const suggestions = ops.transferSuggestions(db);
  const name = (id: string) => db.locations.find((l) => l.id === id)?.name ?? '—';
  const openTransfers = db.transfers.filter((t) => t.status === 'draft' || t.status === 'in_transit');

  if (db.locations.length === 0) {
    return (
      <>
        <EmptyState
          icon={MapPin}
          title="One location so far"
          body="Add your shops, branches and warehouses to see stock at each one, move stock between them and count each place separately. All the stock you have now is placed at the first location you add."
          actionLabel="Add your first location"
          onAction={() => setEditing('new')}
        />
        {editing && <LocationDialog location={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {suggestions.length > 0 && (
        <SectionCard title="Move stock before buying more" description="These locations are below the reorder level while another location has spare">
          <div className="space-y-2">
            {suggestions.slice(0, 10).map((s) => (
              <div key={`${s.product.id}-${s.to.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span className="font-medium">{s.quantity} × {s.product.name}</span>
                <span className="text-slate-500">{s.from.name}</span>
                <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                <span className="text-slate-500">{s.to.name}</span>
                <span className="flex-1 text-xs text-slate-400">{s.reason}</span>
                <Button size="sm" variant="outline" onClick={() => setTransferOpen({ from: s.from.id, to: s.to.id, productId: s.product.id, qty: s.quantity })}>
                  Prepare transfer
                </Button>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Locations"
        description={`${active.length} active · stock not assigned elsewhere sits at the default location`}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing('new')}><Plus className="mr-1 h-4 w-4" /> Add location</Button>
            <Button size="sm" className={primaryBtn} disabled={active.length < 2} onClick={() => setTransferOpen({})}><Truck className="mr-1 h-4 w-4" /> New transfer</Button>
          </>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {db.locations.map((l) => {
            const units = db.products.reduce((s, p) => s + ops.stockAt(db, p, l.id), 0);
            const value = db.products.reduce((s, p) => s + ops.stockAt(db, p, l.id) * p.unitCost, 0);
            return (
              <div key={l.id} className={`rounded-lg border px-3 py-2.5 ${l.active ? 'border-slate-200' : 'border-dashed border-slate-200 opacity-60'}`}>
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-teal-700" />
                  <span className="font-medium">{l.name}</span>
                  {l.isDefault && <Pill tone="teal">default</Pill>}
                  {!l.active && <Pill tone="slate">inactive</Pill>}
                  <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="mt-1 text-xs text-slate-500">{TYPE_LABEL[l.type]}{l.address ? ` · ${l.address}` : ''}</div>
                <div className="mt-1 text-sm">{units} units · RM{value.toFixed(2)} at cost</div>
                {!l.isDefault && l.active && (
                  <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={() => run((d, a) => ops.setDefaultLocation(d, l.id, a), `${l.name} is now the default`)}>
                    <Star className="mr-1 h-3.5 w-3.5" /> Make default
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Stock by location" description="Units on hand at each place. In transit = on a transfer that hasn't arrived yet.">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                {active.map((l) => <TableHead key={l.id} className="text-right">{l.name}</TableHead>)}
                <TableHead className="text-right">In transit</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {db.products.filter((p) => p.status !== 'discontinued').map((p) => {
                const b = ops.locationBreakdown(db, p);
                return (
                  <TableRow key={p.id}>
                    <TableCell>{p.name} <span className="text-xs text-slate-400">{p.sku}</span></TableCell>
                    {active.map((l) => {
                      const n = Math.max(0, b[l.id] ?? 0);
                      return <TableCell key={l.id} className={`text-right tabular-nums ${p.reorderLevel && n < p.reorderLevel ? 'text-amber-700' : ''}`}>{n}</TableCell>;
                    })}
                    <TableCell className="text-right tabular-nums text-slate-500">{b[ops.IN_TRANSIT] ?? 0}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{p.stock}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard title="Transfers" description={`${openTransfers.length} open`}>
        {db.transfers.length === 0 ? (
          <div className="py-4 text-center text-sm text-slate-500">No transfers yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Transfer</TableHead><TableHead>Route</TableHead><TableHead>Items</TableHead><TableHead>Status</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {db.transfers.slice(0, 100).map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-medium">{t.transferNumber}</div>
                    <div className="text-xs text-slate-400">{fmtDateTime(t.createdAt)}</div>
                  </TableCell>
                  <TableCell className="text-sm">{name(t.fromLocationId)} → {name(t.toLocationId)}</TableCell>
                  <TableCell className="text-xs text-slate-600">
                    {t.lines.map((l) => `${l.quantity}× ${db.products.find((p) => p.id === l.productId)?.name ?? 'item'}${t.status === 'received' && (l.receivedQty ?? 0) < l.quantity ? ` (got ${l.receivedQty})` : ''}`).join(', ')}
                  </TableCell>
                  <TableCell><StatusPill status={t.status} /></TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {t.status === 'draft' && (
                      <Button size="sm" className={primaryBtn} onClick={() => run((d, a) => ops.shipTransfer(d, t.id, a), `${t.transferNumber} sent`)}>
                        <Truck className="mr-1 h-4 w-4" /> Send
                      </Button>
                    )}
                    {t.status === 'in_transit' && (
                      <Button size="sm" className={primaryBtn} onClick={() => setReceiving(t)}>
                        <Check className="mr-1 h-4 w-4" /> Receive
                      </Button>
                    )}
                    {(t.status === 'draft' || t.status === 'in_transit') && (
                      <Button size="sm" variant="ghost" onClick={() => window.confirm(`Cancel ${t.transferNumber}?${t.status === 'in_transit' ? ' The goods go back to where they came from.' : ''}`) && run((d, a) => ops.cancelTransfer(d, t.id, a), 'Transfer cancelled')}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {editing && <LocationDialog location={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {transferOpen && <TransferDialog initial={transferOpen} onClose={() => setTransferOpen(null)} />}
      {receiving && <ReceiveTransferDialog transfer={receiving} onClose={() => setReceiving(null)} />}
    </div>
  );
}

function LocationDialog({ location, onClose }: { location: Location | null; onClose: () => void }) {
  const { db, run } = useBizPilot();
  const [name, setName] = useState(location?.name ?? '');
  const [type, setType] = useState<Location['type']>(location?.type ?? (db.locations.length ? 'store' : 'store'));
  const [address, setAddress] = useState(location?.address ?? '');
  const save = () => {
    const ok = location
      ? run((d, a) => ops.updateLocation(d, location.id, { name, type, address }, a), 'Location saved')
      : run((d, a) => ops.createLocation(d, { name, type, address }, a), db.locations.length ? 'Location added' : 'Location added; all current stock is placed here');
    if (ok) onClose();
  };
  const toggleActive = () => {
    if (!location) return;
    if (run((d, a) => ops.updateLocation(d, location.id, { active: !location.active }, a), location.active ? 'Location closed' : 'Location reopened')) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{location ? `Edit ${location.name}` : 'Add a location'}</DialogTitle>
          {!location && db.locations.length === 0 && (
            <DialogDescription>This becomes your default location, and all the stock you have now is placed here.</DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name"><Input autoFocus value={name} placeholder="e.g. Kota Kinabalu shop" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Type"><SimpleSelect value={type} onChange={(v) => setType(v as Location['type'])} options={TYPE_OPTIONS} /></Field>
          <Field label="Address (optional)"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        </div>
        <DialogFooter className="gap-2">
          {location && !location.isDefault && (
            <Button variant="ghost" className="mr-auto" onClick={toggleActive}>{location.active ? 'Close location' : 'Reopen location'}</Button>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className={primaryBtn} disabled={!name.trim()} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({ initial, onClose }: { initial: { from?: string; to?: string; productId?: string; qty?: number }; onClose: () => void }) {
  const { db, run } = useBizPilot();
  const active = db.locations.filter((l) => l.active);
  const [from, setFrom] = useState(initial.from ?? active.find((l) => l.isDefault)?.id ?? active[0]?.id ?? '');
  const [to, setTo] = useState(initial.to ?? active.find((l) => l.id !== from)?.id ?? '');
  const [qty, setQty] = useState<Record<string, string>>(initial.productId ? { [initial.productId]: String(initial.qty ?? 1) } : {});
  const [note, setNote] = useState('');
  const products = db.products.filter((p) => p.status !== 'discontinued' && ops.stockAt(db, p, from) > 0);
  const lines = Object.entries(qty).map(([productId, v]) => ({ productId, quantity: Math.floor(Number(v) || 0) })).filter((l) => l.quantity > 0);
  const save = (ship: boolean) => {
    if (run((d, a) => ops.createTransfer(d, { fromLocationId: from, toLocationId: to, lines, note }, a, ship), ship ? 'Transfer sent' : 'Transfer saved as draft')) onClose();
  };
  const opts = active.map((l) => ({ value: l.id, label: l.name }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Move stock between locations</DialogTitle>
          <DialogDescription>Send now takes the stock out of the first location straight away; it arrives when someone presses Receive.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From"><SimpleSelect value={from} onChange={(v) => { setFrom(v); setQty({}); }} options={opts} /></Field>
          <Field label="To"><SimpleSelect value={to} onChange={setTo} options={opts.filter((o) => o.value !== from)} /></Field>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {products.length === 0 && <div className="py-4 text-center text-sm text-slate-500">Nothing in stock at this location.</div>}
          {products.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{p.name} <span className="text-xs text-slate-400">({ops.stockAt(db, p, from)} here, {ops.stockAt(db, p, to)} there)</span></span>
              <Input type="number" min={0} max={ops.stockAt(db, p, from)} className="h-8 w-24" placeholder="0" value={qty[p.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [p.id]: e.target.value }))} />
            </div>
          ))}
        </div>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="outline" disabled={!lines.length || !to} onClick={() => save(false)}>Save draft</Button>
          <Button className={primaryBtn} disabled={!lines.length || !to} onClick={() => save(true)}><Truck className="mr-1 h-4 w-4" /> Send now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReceiveTransferDialog({ transfer, onClose }: { transfer: StockTransfer; onClose: () => void }) {
  const { db, run } = useBizPilot();
  const [got, setGot] = useState<Record<string, string>>(Object.fromEntries(transfer.lines.map((l) => [l.productId, String(l.quantity)])));
  const short = transfer.lines.some((l) => Number(got[l.productId] ?? 0) < l.quantity);
  const save = () => {
    const received = Object.fromEntries(transfer.lines.map((l) => [l.productId, Math.floor(Number(got[l.productId]) || 0)]));
    if (run((d, a) => ops.receiveTransfer(d, transfer.id, received, a), `${transfer.transferNumber} received`)) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Receive {transfer.transferNumber}</DialogTitle>
          <DialogDescription>Count what actually arrived.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {transfer.lines.map((l) => (
            <div key={l.productId} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{db.products.find((p) => p.id === l.productId)?.name ?? 'item'} <span className="text-xs text-slate-400">(sent {l.quantity})</span></span>
              <Input type="number" min={0} max={l.quantity} className="h-8 w-24" value={got[l.productId] ?? ''} onChange={(e) => setGot((g) => ({ ...g, [l.productId]: e.target.value }))} />
            </div>
          ))}
        </div>
        {short && <div className="text-xs text-amber-700">Units not received are written off as missing and the owner is notified.</div>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className={primaryBtn} onClick={save}><Check className="mr-1 h-4 w-4" /> Confirm received</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
