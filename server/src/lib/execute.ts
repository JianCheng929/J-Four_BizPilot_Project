import * as ops from '../../../src/lib/ops.ts';
import type { ApprovalRequest, BizPilotDB } from '../../../src/lib/db/types.ts';
import { getProvider } from '../providers/index.ts';
import { bookShipment } from '../providers/easyparcel.ts';
import { publishContent } from '../providers/meta.ts';
import { submitInvoice, refreshInvoice } from '../providers/myinvois.ts';
import { sendMail } from '../providers/smtp.ts';
import { isConfigured, providerContext } from './integrations.ts';
import { HttpError } from './http.ts';
import { readSnapshot, withBusiness } from './workspace.ts';
import { invoiceHtml, invoiceText, purchaseOrderText, quotationHtml, quotationText } from './documents.ts';

async function ctxOf(businessId: string, id: string) {
  const p = getProvider(id)!;
  const c = await providerContext(businessId, p);
  return { ctx: c, ready: isConfigured(p, c) };
}

/** The external side of an approval (publish, submit, book, send). Runs before the database change. */
async function externalEffect(businessId: string, db: BizPilotDB, req: ApprovalRequest): Promise<Record<string, unknown>> {
  const p = req.payload as Record<string, any>;
  switch (req.type) {
    case 'marketing_publish': {
      const item = db.contentItems.find((c) => c.id === p.contentId);
      if (!item) throw new HttpError(400, 'Content item no longer exists.');
      const due = new Date(item.scheduledDate).getTime() <= Date.now() + 5 * 60_000;
      if (!due || !['Facebook', 'Instagram'].includes(item.platform)) return {}; // scheduler publishes later / manual platform
      const { ctx, ready } = await ctxOf(businessId, 'meta');
      if (!ready) return {};
      const r = await publishContent(ctx, item);
      return { postId: r.postId };
    }
    case 'einvoice_submit': {
      const inv = db.invoices.find((i) => i.id === p.invoiceId);
      if (!inv) throw new HttpError(400, 'Invoice no longer exists.');
      const { ctx } = await ctxOf(businessId, 'myinvois');
      const einvoice: Record<string, unknown> = await submitInvoice(ctx, inv, db.settings);
      // LHDN usually validates within seconds; take one quick look.
      await new Promise((r) => setTimeout(r, 4000));
      try {
        Object.assign(einvoice, await refreshInvoice(ctx, String(einvoice.submissionUid), String(einvoice.uuid)));
      } catch { /* the Refresh button will pick it up */ }
      return { einvoice };
    }
    case 'shipment_booking': {
      const o = db.salesOrders.find((x) => x.id === p.orderId);
      if (!o) throw new HttpError(400, 'Order no longer exists.');
      const s = db.settings;
      const weight = o.lines.reduce((a, l) => a + (db.products.find((x) => x.id === l.productId)?.weightKg ?? 0.5) * l.quantity, 0);
      const { ctx } = await ctxOf(businessId, 'easyparcel');
      const b = await bookShipment(ctx, {
        serviceId: String(p.serviceId),
        weightKg: weight,
        content: o.lines.map((l) => l.name).filter(Boolean).join(', '),
        value: o.total,
        sender: { name: s.legalName || s.name, phone: s.phone, email: s.email, address: s.addressLine, city: s.city, postcode: s.shipFromPostcode || s.postcode },
        receiver: { name: o.customerName, phone: o.customerPhone, email: o.customerEmail, address: o.shippingAddress, postcode: o.shippingPostcode },
      });
      return {
        shipment: {
          courier: String(p.courier ?? ''), serviceId: String(p.serviceId), orderNo: b.orderNo, trackingNo: b.trackingNo,
          labelUrl: b.labelUrl, cost: b.cost || Number(p.price ?? 0), status: 'paid', bookedAt: new Date().toISOString(),
        },
      };
    }
    case 'invoice_issue': {
      const inv = db.invoices.find((i) => i.id === p.invoiceId);
      if (!inv?.customerEmail) return {};
      const { ctx, ready } = await ctxOf(businessId, 'smtp');
      if (!ready) return {};
      const issued = { ...inv, status: 'issued' as const };
      const r = await sendMail(ctx, { to: inv.customerEmail, subject: `Invoice ${inv.invoiceNumber} from ${db.settings.name}`, text: invoiceText(issued, db.settings), html: invoiceHtml(issued, db.settings) });
      return { sentTo: r.sentTo };
    }
    case 'customer_message': {
      const { ctx } = await ctxOf(businessId, 'smtp');
      const r = await sendMail(ctx, { to: String(p.to ?? ''), subject: String(p.subject ?? `Message from ${db.settings.name}`), text: String(p.body ?? '') });
      return { sentTo: r.sentTo };
    }
    case 'payment_reminder': {
      if (!p.to) return {};
      const { ctx, ready } = await ctxOf(businessId, 'smtp');
      if (!ready) return {};
      const r = await sendMail(ctx, { to: String(p.to), subject: String(p.subject ?? ''), text: String(p.body ?? '') });
      return { sentTo: r.sentTo };
    }
    case 'quotation_send': {
      const q = db.quotations.find((x) => x.id === p.quotationId);
      if (!q) throw new HttpError(400, 'Quotation no longer exists.');
      if (!q.customerEmail) return {};
      const { ctx, ready } = await ctxOf(businessId, 'smtp');
      if (!ready) return {};
      const r = await sendMail(ctx, { to: q.customerEmail, subject: `Quotation ${q.quoteNumber} from ${db.settings.name}`, text: quotationText(q, db.settings), html: quotationHtml(q, db.settings) });
      return { sentTo: r.sentTo };
    }
    case 'review_response': {
      // Ticket-style reviews that came in by email can be answered by email.
      if (!p.email) return {};
      const { ctx, ready } = await ctxOf(businessId, 'smtp');
      if (!ready) return {};
      const r = await sendMail(ctx, { to: String(p.email), subject: `Re: your review of ${db.settings.name}`, text: String(p.response ?? '') });
      return { sentTo: r.sentTo };
    }
    default:
      return {};
  }
}

const RUNNING = 'Running since ';
const STALE_MS = 10 * 60_000;

/**
 * Durably mark an approval as running before its external effect (book, submit, send),
 * in a version-checked save. Two clicks, two tabs or two servers can't both claim it,
 * so the same courier booking or e-invoice is never sent twice.
 */
async function claimApproval(businessId: string, approvalId: string): Promise<void> {
  await withBusiness(businessId, (db) => {
    const r = db.approvals.find((a) => a.id === approvalId);
    if (!r) throw new HttpError(404, 'Approval not found.');
    if (r.status !== 'pending') throw new HttpError(400, `This request was already ${r.status}.`);
    if (r.executionStatus === 'running') {
      const since = Date.parse(String(r.executionResult ?? '').replace(RUNNING, ''));
      if (!Number.isFinite(since) || Date.now() - since < STALE_MS) {
        throw new HttpError(409, 'This approval is already being executed.');
      }
    }
    r.executionStatus = 'running';
    r.executionResult = `${RUNNING}${new Date().toISOString()}`;
  });
}

export async function executeApproval(businessId: string, approvalId: string, actor: string): Promise<{ result: string }> {
  await claimApproval(businessId, approvalId);
  {
    const snap = await readSnapshot(businessId);
    const req = snap.approvals.find((a) => a.id === approvalId)!;

    let external: Record<string, unknown>;
    try {
      external = await externalEffect(businessId, snap, req);
    } catch (e) {
      const msg = (e as Error).message;
      await withBusiness(businessId, (db) => {
        const r = db.approvals.find((a) => a.id === approvalId);
        if (r) { r.executionStatus = 'failed'; r.executionResult = msg; }
        ops.audit(db, actor, 'execute_failed', 'approval', approvalId, `${req.title}: ${msg}`);
      });
      throw new HttpError(400, `Not executed: ${msg}`);
    }

    const record = (db: BizPilotDB) => {
      const r = db.approvals.find((a) => a.id === approvalId)!;
      const result = ops.applyApprovedAction(db, r, actor, external);
      r.status = 'approved';
      r.decidedAt = new Date().toISOString();
      r.decidedBy = actor;
      r.executionStatus = 'succeeded';
      r.executionResult = result;
      ops.audit(db, actor, 'approve', 'approval', r.id, `${r.title} → ${result}`);
      if (r.type === 'shipment_booking' && external.shipment) {
        const cost = Number((external.shipment as any).cost ?? 0);
        if (cost > 0) ops.addExpense(db, { category: 'Shipping', description: `Courier for ${String((r.payload as any).orderNumber ?? '')}`.trim(), amount: cost, date: new Date().toISOString(), recurring: false, paid: true, dueDate: null }, actor);
      }
      const po = r.type === 'purchase_order' ? db.purchaseOrders.find((x) => x.poNumber === result.split(' ')[0]) : undefined;
      return { result, po: po ? { po, text: purchaseOrderText(po, db), supplier: db.suppliers.find((s) => s.id === po.supplierId) } : null };
    };
    let out: ReturnType<typeof record>;
    try {
      out = await withBusiness(businessId, record);
    } catch (e) {
      const done = Object.keys(external).length ? ` The external step already happened (${JSON.stringify(external).slice(0, 200)}); check it before retrying.` : '';
      const msg = `${(e as Error).message}${done}`;
      await withBusiness(businessId, (db) => {
        const r = db.approvals.find((a) => a.id === approvalId);
        if (r) { r.executionStatus = 'failed'; r.executionResult = msg; }
        ops.audit(db, actor, 'execute_failed', 'approval', approvalId, `${req.title}: ${msg}`);
      });
      throw new HttpError(400, `Not executed: ${msg}`);
    }

    // After a PO is placed, send it to the supplier if email is set up.
    if (out.po?.supplier?.email) {
      try {
        const { ctx, ready } = await ctxOf(businessId, 'smtp');
        if (ready) {
          await sendMail(ctx, { to: out.po.supplier.email, subject: `Purchase order ${out.po.po.poNumber}`, text: out.po.text });
          await withBusiness(businessId, (db) => {
            const po = db.purchaseOrders.find((x) => x.id === out.po!.po.id);
            if (po) po.sentAt = new Date().toISOString();
            const r = db.approvals.find((a) => a.id === approvalId);
            if (r) r.executionResult = `${r.executionResult} Emailed to ${out.po!.supplier!.email}.`;
          });
          return { result: `${out.result} Emailed to ${out.po.supplier.email}.` };
        }
      } catch (e) {
        return { result: `${out.result} (Email to supplier failed: ${(e as Error).message})` };
      }
    }
    return { result: out.result };
  }
}

export async function rejectApproval(businessId: string, approvalId: string, actor: string, reason = '') {
  return withBusiness(businessId, (db) => {
    const r = db.approvals.find((a) => a.id === approvalId);
    if (!r) throw new HttpError(404, 'Approval not found.');
    if (r.status !== 'pending') throw new HttpError(400, `This request was already ${r.status}.`);
    r.status = 'rejected';
    r.decidedAt = new Date().toISOString();
    r.decidedBy = actor;
    r.executionResult = reason || null;
    const poId = (r.payload as any).purchaseOrderId;
    if (r.type === 'purchase_order' && poId) {
      const po = db.purchaseOrders.find((p) => p.id === poId);
      if (po && po.status === 'pending_approval') po.status = 'draft';
    }
    if (r.type === 'marketing_publish') {
      const c = db.contentItems.find((x) => x.id === (r.payload as any).contentId);
      if (c && c.status === 'in_review') c.status = 'draft';
    }
    if (r.type === 'stock_count') {
      const c = db.stockCounts.find((x) => x.id === (r.payload as any).countId);
      if (c && c.status === 'submitted') { c.status = 'rejected'; c.decidedAt = new Date().toISOString(); }
    }
    if (r.type === 'production_order') {
      const o = db.productionOrders.find((x) => x.id === (r.payload as any).productionOrderId);
      if (o && o.status === 'pending_approval') o.status = 'cancelled';
    }
    if (r.type === 'refund') {
      const ret = db.returns.find((x) => x.id === (r.payload as any).returnId);
      if (ret && ret.refundStatus === 'pending_approval') ret.refundStatus = 'none';
    }
    ops.audit(db, actor, 'reject', 'approval', r.id, `${r.title}${reason ? `: ${reason}` : ''}`);
    return { ok: true };
  });
}

/** Publish approved posts whose scheduled time has arrived. */
export async function publishDueContent() {
  const { supabaseAdmin } = await import('./supabase.ts');
  const { data } = await supabaseAdmin()
    .from('content_items')
    .select('id,business_id')
    .eq('status', 'scheduled')
    .lte('scheduled_date', new Date().toISOString())
    .in('platform', ['Facebook', 'Instagram'])
    .limit(20);
  for (const row of (data ?? []) as { id: string; business_id: string }[]) {
    try {
      const { ctx, ready } = await ctxOf(row.business_id, 'meta');
      if (!ready) continue;
      const snap = await readSnapshot(row.business_id);
      const item = snap.contentItems.find((c) => c.id === row.id);
      if (!item) continue;
      let postId: string | null = null, error: string | null = null;
      try { postId = (await publishContent(ctx, item)).postId; } catch (e) { error = (e as Error).message; }
      await withBusiness(row.business_id, (db) => {
        const c = db.contentItems.find((x) => x.id === row.id);
        if (!c) return;
        if (postId) { c.status = 'published'; c.externalPostId = postId; c.publishedAt = new Date().toISOString(); c.error = null; }
        else { c.status = 'failed'; c.error = error; ops.notify(db, `Post failed: ${c.title}`, error ?? '', 'warning'); }
        ops.audit(db, 'scheduler', postId ? 'publish' : 'publish_failed', 'content', c.id, postId ? `Published ${c.platform} ${postId}` : String(error));
      });
    } catch (e) {
      console.error('Scheduled publish failed', e);
    }
  }
}
