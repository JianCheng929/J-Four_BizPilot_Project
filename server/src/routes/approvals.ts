import { Router } from 'express';
import { requireRole, requireUser, ctx } from '../lib/auth.ts';
import { handle } from '../lib/http.ts';
import { executeApproval, rejectApproval } from '../lib/execute.ts';

export const approvals = Router();

approvals.post('/:id/approve', requireUser, requireRole('manager'), handle(async (req) => {
  const c = ctx(req);
  return executeApproval(c.business.id, String(req.params.id), c.email);
}));

approvals.post('/:id/reject', requireUser, requireRole('manager'), handle(async (req) => {
  const c = ctx(req);
  return rejectApproval(c.business.id, String(req.params.id), c.email, String(req.body?.reason ?? ''));
}));
