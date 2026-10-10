import { useBizPilot } from '@/lib/store';
import { marginCheck } from '@/lib/metrics';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pill, SectionCard } from './common';

/** Blueprint D4: products selling below cost or under the target margin. */
export function MarginCheck() {
  const { db, requestApproval } = useBizPilot();
  const rows = marginCheck(db);
  const target = db.settings.targetMarginPct || 30;
  const flagged = rows.filter((r) => r.flag !== 'ok');
  if (!rows.length) return null;

  const fix = (r: (typeof rows)[number]) =>
    requestApproval({
      type: 'price_change',
      title: `Price change: ${r.product.name} ${money(r.product.price)} → ${money(r.targetPrice)}`,
      description: `Unit cost ${money(r.product.unitCost)}. Current margin ${r.marginPct}%, target ${target}%. New price = cost ÷ (1 − ${target}%), before platform fees.`,
      payload: { productId: r.product.id, newPrice: r.targetPrice },
      risk: r.product.price > 0 && Math.abs(r.targetPrice - r.product.price) / r.product.price > 0.2 ? 'medium' : 'low',
    });

  return (
    <SectionCard
      title="Margin check"
      description={
        flagged.length
          ? `${flagged.length} product(s) below your ${target}% target margin or below cost. Change the target in Settings → Business.`
          : `Every product meets your ${target}% target margin (before platform fees).`
      }
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Profit / unit</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead>Check</TableHead>
              <TableHead className="text-right">Price for {target}%</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(flagged.length ? flagged : rows).map((r) => (
              <TableRow key={r.product.id}>
                <TableCell className="font-medium">{r.product.name}</TableCell>
                <TableCell className="text-right">{money(r.product.unitCost)}</TableCell>
                <TableCell className="text-right">{money(r.product.price)}</TableCell>
                <TableCell className={`text-right ${r.profitPerUnit < 0 ? 'text-red-600' : ''}`}>{money(r.profitPerUnit)}</TableCell>
                <TableCell className="text-right">{r.flag === 'no_price' ? '—' : `${r.marginPct}%`}</TableCell>
                <TableCell>
                  <Pill tone={r.flag === 'below_cost' ? 'red' : r.flag === 'ok' ? 'green' : 'amber'}>
                    {r.flag === 'below_cost' ? 'Selling below cost' : r.flag === 'no_price' ? 'No price' : r.flag === 'below_target' ? 'Below target' : 'OK'}
                  </Pill>
                </TableCell>
                <TableCell className="text-right">{money(r.targetPrice)}</TableCell>
                <TableCell className="text-right">
                  {r.flag !== 'ok' && r.product.unitCost > 0 && (
                    <Button size="sm" variant="outline" onClick={() => fix(r)}>Request price change</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
