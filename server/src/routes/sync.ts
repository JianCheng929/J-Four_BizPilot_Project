import { Router } from 'express';
import { requireUser, ctx } from '../lib/auth.ts';
import { handle } from '../lib/http.ts';
import { syncMarketplace } from '../lib/sync.ts';

export const sync = Router();

sync.post('/:provider', requireUser, handle(async (req) => {
  const c = ctx(req);
  return syncMarketplace(c.business.id, String(req.params.provider), c.email);
}));
