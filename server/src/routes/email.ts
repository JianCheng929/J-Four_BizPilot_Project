import { Router } from 'express';
import * as ops from '../../../src/lib/ops.ts';
import { requireRole, requireUser, ctx } from '../lib/auth.ts';
import { contextFor, handle, HttpError } from '../lib/http.ts';
import { invoiceHtml, invoiceText } from '../lib/documents.ts';
import { readSnapshot, withBusiness } from '../lib/workspace.ts';
import { sendMail } from '../providers/smtp.ts';

export const email = Router();

email.post('/invoice/:id', requireUser, requireRole('staff'), handle(async (req) => {
  const c = ctx(req);
  const db = await readSnapshot(c.business.id);
  const inv = db.invoices.find((i) => i.id === req.params.id || i.invoiceNumber === req.params.id);
  if (!inv) throw new HttpError(404, 'Invoice not found.');
  if (inv.status === 'draft') throw new HttpError(400, 'Issue the invoice before emailing it.');
  const to = String(req.body?.to ?? inv.customerEmail ?? '');
  if (!to) throw new HttpError(400, `${inv.invoiceNumber} has no customer email.`);
  const { pctx } = await contextFor(c.business.id, 'smtp');
  const r = await sendMail(pctx, { to, subject: `Invoice ${inv.invoiceNumber} from ${db.settings.name}`, text: invoiceText(inv, db.settings), html: invoiceHtml(inv, db.settings) });
  await withBusiness(c.business.id, (d) => ops.audit(d, c.email, 'email', 'invoice', inv.invoiceNumber, `Emailed to ${to}`));
  return { sentTo: r.sentTo };
}));
