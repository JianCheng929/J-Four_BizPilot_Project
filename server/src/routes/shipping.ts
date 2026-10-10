import { Router } from 'express';
import { requireRole, requireUser, ctx } from '../lib/auth.ts';
import { handle } from '../lib/http.ts';
import { quoteForOrder, requestBooking, trackOrder } from '../lib/shipping.ts';

export const shipping = Router();

shipping.post('/quote', requireUser, requireRole('staff'), handle(async (req) => quoteForOrder(ctx(req).business.id, String(req.body?.orderId ?? ''))));

shipping.post('/book', requireUser, requireRole('staff'), handle(async (req) => {
  const c = ctx(req);
  const { orderId, serviceId, courier, price } = req.body ?? {};
  return requestBooking(c.business.id, c.email, { orderId: String(orderId), serviceId: String(serviceId), courier: String(courier ?? ''), price: Number(price) });
}));

shipping.post('/track', requireUser, requireRole('staff'), handle(async (req) => {
  const c = ctx(req);
  return trackOrder(c.business.id, String(req.body?.orderId ?? ''), c.email);
}));
