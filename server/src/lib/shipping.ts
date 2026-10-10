import * as ops from '../../../src/lib/ops.ts';
import { quoteRates, trackShipment } from '../providers/easyparcel.ts';
import { contextFor, HttpError } from './http.ts';
import { readSnapshot, withBusiness } from './workspace.ts';

export async function quoteForOrder(businessId: string, orderId: string) {
  const db = await readSnapshot(businessId);
  const o = db.salesOrders.find((x) => x.id === orderId || x.orderNumber === orderId);
  if (!o) throw new HttpError(404, 'Order not found.');
  if (!o.shippingPostcode) throw new HttpError(400, `${o.orderNumber} has no delivery postcode. Edit the order first.`);
  const weight = o.lines.reduce((a, l) => a + (db.products.find((p) => p.id === l.productId)?.weightKg ?? 0.5) * l.quantity, 0);
  const { pctx } = await contextFor(businessId, 'easyparcel');
  const rates = await quoteRates(pctx, db.settings.shipFromPostcode || db.settings.postcode, o.shippingPostcode, weight);
  return { orderNumber: o.orderNumber, weightKg: Math.round(weight * 100) / 100, rates };
}

export async function requestBooking(businessId: string, actor: string, b: { orderId: string; serviceId: string; courier: string; price: number }) {
  return withBusiness(businessId, (db) => {
    const o = db.salesOrders.find((x) => x.id === b.orderId || x.orderNumber === b.orderId);
    if (!o) throw new HttpError(404, 'Order not found.');
    if (o.shipment?.trackingNo) throw new HttpError(400, `${o.orderNumber} already has tracking ${o.shipment.trackingNo}.`);
    for (const k of ['customerName', 'customerPhone', 'shippingAddress', 'shippingPostcode'] as const) {
      if (!o[k]) throw new HttpError(400, `${o.orderNumber} is missing ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}.`);
    }
    const price = Number(b.price) || 0;
    const req = ops.requestApproval(db, {
      type: 'shipment_booking',
      title: `Book ${b.courier} for ${o.orderNumber} (RM${price.toFixed(2)})`,
      description: `Ship ${o.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')} to ${o.customerName}, ${o.shippingAddress} ${o.shippingPostcode}. Paid from your EasyParcel wallet.`,
      payload: { orderId: o.id, orderNumber: o.orderNumber, serviceId: b.serviceId, courier: b.courier, price },
      amount: price,
    }, actor);
    o.shipment = { ...(o.shipment ?? {}), courier: b.courier, serviceId: b.serviceId, cost: price, status: 'quoted' };
    return { approvalId: req.id };
  });
}

export async function trackOrder(businessId: string, orderId: string, actor: string) {
  const db = await readSnapshot(businessId);
  const o = db.salesOrders.find((x) => x.id === orderId || x.orderNumber === orderId);
  if (!o?.shipment?.orderNo) throw new HttpError(400, 'This order has no booked shipment yet.');
  const { pctx } = await contextFor(businessId, 'easyparcel');
  const t = await trackShipment(pctx, o.shipment.orderNo);
  const s = t.status.toLowerCase();
  const status = /deliver/.test(s) ? 'delivered' : /fail|return/.test(s) ? 'failed' : /transit|pick|out for|hub|dispatch/.test(s) ? 'in_transit' : o.shipment.status;
  await withBusiness(businessId, (d) => {
    const x = d.salesOrders.find((y) => y.id === o.id);
    if (!x?.shipment) return;
    x.shipment = { ...x.shipment, status, lastEvent: t.lastEvent, lastCheckedAt: new Date().toISOString() };
    if (status === 'delivered' && x.status === 'awaiting_fulfilment') {
      try { ops.fulfilSalesOrder(d, x.id, actor); } catch { /* stock issue already flagged */ }
    }
  });
  return { status, lastEvent: t.lastEvent };
}
