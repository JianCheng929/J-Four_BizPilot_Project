import { Router } from 'express';
import { requireUser, ctx } from '../lib/auth.ts';
import { handle } from '../lib/http.ts';
import { quoteForOrder, requestBooking, trackOrder } from '../lib/shipping.ts';

export const shipping = Router();

shipping.post('/quote', requireUser, handle(async (req) => quoteForOrder(ctx(req).business.id, String(req.body?.orderId ?? ''))));

shipping.post('/book', requireUser, handle(async (req) => {
  const c = ctx(req);
  const { orderId, serviceId, courier, price } = req.body ?? {};
  return requestBooking(c.business.id, c.email, { orderId: String(orderId), serviceId: String(serviceId), courier: String(courier ?? ''), price: Number(price) });
}));

shipping.post('/track', requireUser, handle(async (req) => {
  const c = ctx(req);
  return trackOrder(c.business.id, String(req.body?.orderId ?? ''), c.email);
}));
