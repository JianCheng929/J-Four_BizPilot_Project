import { useState } from 'react';
import { Calculator } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { priceOptions, suggestedPrice } from '@/lib/metrics';
import { money } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field, NONE, SectionCard, SimpleSelect, num, primaryBtn } from './common';

/**
 * Price so that, after platform + payment fees and any shipping subsidy,
 * the target margin of the selling price is left:
 *   price × (1 − margin − platformFee − paymentFee) = unitCost + shippingSubsidy
 */
export function recommendedPrice(unitCost: number, marginPct: number, platformPct: number, paymentPct: number, shipping: number) {
  const k = 1 - (marginPct + platformPct + paymentPct) / 100;
  if (k <= 0) return NaN;
  return (unitCost + shipping) / k;
}

export function PricingCalculator() {
  const { db, requestApproval } = useBizPilot();
  const [productId, setProductId] = useState(NONE);
  const [f, setF] = useState({ unitCost: '', margin: String(db.settings.targetMarginPct || 30), platform: '0', payment: '0', shipping: '0' });
  const product = db.products.find((p) => p.id === productId);

  const pickProduct = (id: string) => {
    setProductId(id);
    const p = db.products.find((x) => x.id === id);
    if (p) setF((x) => ({ ...x, unitCost: String(p.unitCost) }));
  };

  const cost = num(f.unitCost);
  const margin = num(f.margin);
  const platform = num(f.platform) || 0;
  const payment = num(f.payment) || 0;
  const shipping = num(f.shipping) || 0;
  const valid = cost >= 0 && margin >= 0 && margin < 100;
  const price = valid ? recommendedPrice(cost, margin, platform, payment, shipping) : NaN;
  const ok = Number.isFinite(price) && price > 0;
  const rounded = ok ? Math.ceil(price * 10) / 10 : NaN; // round up to 10 sen
  const fees = ok ? rounded * ((platform + payment) / 100) : 0;
  const profit = ok ? rounded - fees - cost - shipping : 0;
  const noFee = valid ? suggestedPrice(cost, margin) : NaN;

  const apply = () => {
    if (!product || !ok) return;
    requestApproval({
      type: 'price_change',
      title: `Price change: ${product.name} ${money(product.price)} → ${money(rounded)}`,
      description: `Unit cost ${money(cost)}, target margin ${margin}%, platform fee ${platform}%, payment fee ${payment}%, shipping subsidy ${money(shipping)}. Net profit per unit ≈ ${money(profit)}.`,
      payload: { productId: product.id, newPrice: rounded },
      risk: Math.abs(rounded - product.price) / (product.price || 1) > 0.2 ? 'medium' : 'low',
    });
  };

  return (
    <SectionCard
      title="Pricing calculator"
      description="Recommended price = (unit cost + shipping subsidy) ÷ (1 − target margin − platform fee − payment fee)."
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Product (optional)" className="col-span-2">
            <SimpleSelect
              value={productId}
              onChange={pickProduct}
              options={[{ value: NONE, label: 'No product — just calculate' }, ...db.products.map((p) => ({ value: p.id, label: `${p.name} (now ${money(p.price)})` }))]}
            />
          </Field>
          <Field label="Unit cost (RM)">
            <Input type="number" min="0" step="0.01" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} />
          </Field>
          <Field label="Target margin (%)">
            <Input type="number" min="0" max="99" value={f.margin} onChange={(e) => setF({ ...f, margin: e.target.value })} />
          </Field>
          <Field label="Platform fee (%)" hint="e.g. marketplace commission + service fee">
            <Input type="number" min="0" step="0.1" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} />
          </Field>
          <Field label="Payment fee (%)" hint="e.g. card / e-wallet MDR">
            <Input type="number" min="0" step="0.1" value={f.payment} onChange={(e) => setF({ ...f, payment: e.target.value })} />
          </Field>
          <Field label="Shipping subsidy per unit (RM)">
            <Input type="number" min="0" step="0.01" value={f.shipping} onChange={(e) => setF({ ...f, shipping: e.target.value })} />
          </Field>
        </div>

        <div className="rounded-lg bg-slate-50 p-4">
          {!f.unitCost ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-sm text-slate-500">
              <Calculator className="mb-2 h-6 w-6 text-slate-400" />
              Enter a unit cost (or pick a product) to calculate a price.
            </div>
          ) : !ok ? (
            <div className="text-sm text-red-600">Margin + fees must add up to less than 100%.</div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="text-xs text-slate-500">Recommended selling price (before tax)</div>
              <div className="text-3xl font-semibold text-teal-800">{money(rounded)}</div>
              <div className="space-y-1 border-t pt-2">
                <Row label="Fees" value={`− ${money(fees)}`} />
                <Row label="Unit cost" value={`− ${money(cost)}`} />
                <Row label="Shipping subsidy" value={`− ${money(shipping)}`} />
                <Row label="Profit per unit" value={money(profit)} bold />
                <Row label="Margin on price" value={`${((profit / rounded) * 100).toFixed(1)}%`} />
                {Number.isFinite(noFee) && <Row label="Price without fees/subsidy" value={money(noFee)} />}
              </div>
              {cost > 0 && margin > 0 && (
                <div className="border-t pt-2">
                  <div className="mb-1 text-xs text-slate-500">Launch price options (before fees)</div>
                  <div className="grid grid-cols-3 gap-2">
                    {priceOptions(cost, margin).map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        className="rounded-md border bg-white p-2 text-left hover:border-teal-400"
                        title={`Use a ${o.margin}% margin`}
                        onClick={() => setF({ ...f, margin: String(o.margin) })}
                      >
                        <div className="text-[11px] text-slate-500">{o.label} · {o.margin}%</div>
                        <div className="font-semibold">{money(o.price)}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {product && (
                <div className="border-t pt-2">
                  <div className="text-xs text-slate-500">
                    Current price {money(product.price)} ({product.price > 0 ? (((product.price - product.unitCost) / product.price) * 100).toFixed(1) : '0'}% gross margin before fees)
                  </div>
                  <Button size="sm" className={`mt-2 ${primaryBtn}`} onClick={apply} disabled={Math.abs(rounded - product.price) < 0.005}>
                    Apply {money(rounded)} to {product.name}
                  </Button>
                  <div className="mt-1 text-[11px] text-slate-400">Price changes go to Approvals before they take effect.</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? 'font-semibold' : ''}`}>
      <span className="text-slate-600">{label}</span>
      <span>{value}</span>
    </div>
  );
}
