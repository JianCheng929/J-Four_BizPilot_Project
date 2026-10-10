import { Router } from 'express';
import { requireRole, requireUser, ctx } from '../lib/auth.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { handle } from '../lib/http.ts';
import { backupBusiness, listBackups } from '../lib/backup.ts';

export const backups = Router();

/** Daily backups of this business, newest first, with short-lived download links. */
backups.get('/', requireUser, requireRole('manager'), handle(async (req) => listBackups(ctx(req).business.id)));

/** Back up now (e.g. before a big import). */
backups.post('/', requireUser, requireRole('manager'), rateLimit({ name: 'backup', windowMs: 60 * 60_000, max: 5 }), handle(async (req) => backupBusiness(ctx(req).business.id)));
