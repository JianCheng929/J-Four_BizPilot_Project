import { Router } from 'express';
import { requireRole, requireUser, ctx } from '../lib/auth.ts';
import { handle } from '../lib/http.ts';
import { cancelEinvoice, checkTin, refreshEinvoice, requestEinvoiceSubmit } from '../lib/einvoice.ts';

export const einvoice = Router();

einvoice.post('/validate-tin', requireUser, requireRole('staff'), handle(async (req) => {
  const { tin, idType, idValue } = req.body ?? {};
  return checkTin(ctx(req).business.id, String(tin ?? ''), String(idType ?? 'BRN'), String(idValue ?? ''));
}));
einvoice.post('/:id/submit', requireUser, requireRole('staff'), handle(async (req) => requestEinvoiceSubmit(ctx(req).business.id, String(req.params.id), ctx(req).email)));
einvoice.post('/:id/refresh', requireUser, requireRole('staff'), handle(async (req) => refreshEinvoice(ctx(req).business.id, String(req.params.id))));
einvoice.post('/:id/cancel', requireUser, requireRole('staff'), handle(async (req) => cancelEinvoice(ctx(req).business.id, String(req.params.id), String(req.body?.reason ?? ''), ctx(req).email)));
