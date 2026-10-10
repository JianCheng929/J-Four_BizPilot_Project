import * as ops from '@/lib/ops';
import type { BizPilotDB, PurchaseOrder } from '@/lib/db/types';
import { money } from '@/lib/format';

/**
 * Small compositions of ops.* used by several screens. Each runs inside a
 * single store.run() so the record and its approval are saved together.
 */

/** Create a draft PO and put it in the approval queue (status → pending_approval). */
export function draftPOForApproval(d: BizPilotDB, input: ops.POInput, actor: string): PurchaseOrder {
  const po = ops.createPurchaseOrder(d, input, actor, 'draft');
  const supplier = d.suppliers.find((s) => s.id === po.supplierId);
  const lines = po.lines
    .map((l) => {
      const p = d.products.find((x) => x.id === l.productId);
      return `${l.quantity} × ${p?.name ?? 'item'} @ ${money(l.unitCost)}`;
    })
    .join('; ');
  ops.requestApproval(
    d,
    {
      type: 'purchase_order',
      title: `${po.poNumber} to ${supplier?.name ?? 'supplier'} (${money(po.totalCost)})`,
      description: `${lines}. Expected by ${new Date(po.expectedDate).toLocaleDateString('en-MY')}.${po.note ? ` Note: ${po.note}` : ''}`,
      payload: { purchaseOrderId: po.id },
      amount: po.totalCost,
    },
    actor,
  );
  return po;
}

/** Submit an existing draft PO for approval. */
export function submitExistingPO(d: BizPilotDB, poId: string, actor: string) {
  const po = d.purchaseOrders.find((p) => p.id === poId);
  if (!po) throw new ops.OpError('Purchase order not found.');
  if (po.status !== 'draft') throw new ops.OpError(`${po.poNumber} is ${po.status}.`);
  const supplier = d.suppliers.find((s) => s.id === po.supplierId);
  ops.requestApproval(
    d,
    {
      type: 'purchase_order',
      title: `${po.poNumber} to ${supplier?.name ?? 'supplier'} (${money(po.totalCost)})`,
      description: `${po.lines.length} line(s), total ${money(po.totalCost)}.`,
      payload: { purchaseOrderId: po.id },
      amount: po.totalCost,
    },
    actor,
  );
}


/** True when an approval of this type is already waiting for the given record. */
export function hasPendingApproval(d: BizPilotDB, type: string, key: string, id: string): boolean {
  return d.approvals.some((a) => a.status === 'pending' && a.type === type && a.payload?.[key] === id);
}
