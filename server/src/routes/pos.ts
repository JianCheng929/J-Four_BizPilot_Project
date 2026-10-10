import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import * as ops from '../../../src/lib/ops.ts';
import { requireRole, requireUser, ctx } from '../lib/auth.ts';
import { handle, HttpError } from '../lib/http.ts';
import { supabaseAdmin } from '../lib/supabase.ts';
import { withBusiness } from '../lib/workspace.ts';

/**
 * Retail POS bridge (blueprint B/F retail): a till, barcode app or POS system
 * posts each completed sale here with a BizPilot API token. Stock is deducted
 * immediately with the same logic as the in-app POS.
 */

export const tokens = Router();
export const pos = Router();

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

tokens.get('/', requireUser, requireRole('manager'), handle(async (req) => {
  const { data, error } = await supabaseAdmin().from('api_tokens').select('id,name,token_hint,created_at,last_used_at').eq('business_id', ctx(req).business.id);
  if (error) throw new Error(error.message);
  return data;
}));

tokens.post('/', requireUser, requireRole('manager'), handle(async (req) => {
  const token = `bp_${randomBytes(24).toString('base64url')}`;
  const name = String(req.body?.name ?? 'POS').slice(0, 60) || 'POS';
  const { error } = await supabaseAdmin().from('api_tokens').insert({ business_id: ctx(req).business.id, name, token_hash: hash(token), token_hint: `${token.slice(0, 7)}…${token.slice(-4)}` });
  if (error) throw new Error(error.message);
  return { token, name, note: 'Copy this token now. BizPilot only stores a hash of it.' };
}));

tokens.delete('/:id', requireUser, requireRole('manager'), handle(async (req) => {
  const { error } = await supabaseAdmin().from('api_tokens').delete().eq('id', String(req.params.id)).eq('business_id', ctx(req).business.id);
  if (error) throw new Error(error.message);
  return { ok: true };
}));

async function businessFromToken(req: Request): Promise<string> {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!token.startsWith('bp_')) throw new HttpError(401, 'Send a BizPilot API token as "Authorization: Bearer bp_…".');
  const { data } = await supabaseAdmin().from('api_tokens').select('id,business_id').eq('token_hash', hash(token)).maybeSingle();
  if (!data) throw new HttpError(401, 'Unknown or revoked API token.');
  await supabaseAdmin().from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  return data.business_id as string;
}

/**
 * POST /api/pos/sales
 * { "externalId": "till1-000123", "items": [{ "sku" | "barcode": "...", "quantity": 2, "unitPrice": 12.9 }],
 *   "paymentMethod": "cash", "customerName": "Walk-in", "date": "2026-10-10T08:00:00Z",
 *   "location": "KK shop" }   (optional: shop name or id the sale happened at)
 */
pos.post('/sales', handle(async (req) => {
  const businessId = await businessFromToken(req);
  const b = req.body ?? {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new HttpError(400, 'items is required.');
  return withBusiness(businessId, (db) => {
    if (b.externalId && db.salesOrders.some((o) => o.source === 'pos' && o.externalId === String(b.externalId))) {
      return { duplicate: true };
    }
    const lines = items.map((it: any) => {
      const ref = String(it.sku ?? it.barcode ?? it.productId ?? it.name ?? '');
      const p = ops.requireProduct(db, ref);
      return { productId: p.id, quantity: Number(it.quantity) || 1, unitPrice: it.unitPrice != null ? Number(it.unitPrice) : p.price };
    });
    const ref = b.location ? String(b.location).trim().toLowerCase() : '';
    const loc = ref ? db.locations.find((l) => l.id === b.location || l.name.toLowerCase() === ref) : undefined;
    if (ref && !loc) throw new HttpError(400, `Unknown location "${b.location}".`);
    const so = ops.createSalesOrder(db, {
      locationId: loc?.id ?? null,
      channel: 'retail', source: 'pos', externalId: b.externalId ? String(b.externalId) : null, lines,
      customerName: b.customerName, paymentMethod: b.paymentMethod ?? 'cash', paymentStatus: 'paid', date: b.date, fulfilNow: true,
    }, 'POS');
    return { orderNumber: so.orderNumber, total: so.total };
  });
}));
