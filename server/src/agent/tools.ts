import { z } from 'zod';
import { createSdkMcpServer, tool } from '@tencent-ai/agent-sdk';
import * as ops from '../../../src/lib/ops.ts';
import * as m from '../../../src/lib/metrics.ts';
import { checkCompliance } from '../../../src/lib/compliance.ts';
import type { AgentEvent, ApprovalRequest, BizPilotDB, ContentItem } from '../../../src/lib/db/types.ts';
import { readSnapshot, withBusiness } from '../lib/workspace.ts';
import { executeApproval } from '../lib/execute.ts';
import { quoteForOrder, requestBooking } from '../lib/shipping.ts';
import { checkTin, requestEinvoiceSubmit } from '../lib/einvoice.ts';
import { missingSupplierFields } from '../providers/myinvois.ts';
import { getSkill, listSkills } from './skills.ts';
import { syncMarketplace } from '../lib/sync.ts';
import { PROVIDERS } from '../providers/index.ts';
import { isConfigured, providerContext } from '../lib/integrations.ts';
import { generateImage } from '../lib/media.ts';
import { finishKlingVideo, klingConfigured, startKlingVideo } from '../lib/kling.ts';

/**
 * BizPilot's tools, exposed to the WorkBuddy agent as an in-process MCP server.
 * Every tool runs the same deterministic operations as the web app, against
 * the signed-in business only. Anything risky becomes an approval request.
 */

export const ACTOR = 'WorkBuddy agent';
type Emit = (e: Omit<AgentEvent, 'at'>) => void;

const r2 = (n: number) => Math.round(n * 100) / 100;
const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${msg}` }], isError: true });

const productView = (p: BizPilotDB['products'][number]) => ({
  id: p.id, sku: p.sku, name: p.name, category: p.category, price: p.price, unitCost: p.unitCost,
  onHand: p.stock, reserved: p.reserved, held: p.unavailable || 0, available: m.availableStock(p), incoming: p.incoming,
  reorderLevel: p.reorderLevel, safetyStock: p.safetyStock, maxStock: p.maxStock, orderMultiple: p.orderMultiple,
  expiryDate: p.expiryDate || null, avgDailySales: p.avgDailySales,
  daysLeft: Number.isFinite(m.daysOfStockLeft(p)) ? m.daysOfStockLeft(p) : null, status: p.status, supplierId: p.supplierId,
});

export function buildBizPilotServer(businessId: string, emit: Emit) {
  const level = async () => (await readSnapshot(businessId)).settings.automationLevel;

  /** Wrap a handler: errors become tool errors the agent can read and recover from. */
  const safe = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  /** Writes are blocked in Assistant mode (automation level 1). */
  const write = <A,>(fn: (a: A) => Promise<unknown>) => safe<A>(async (a) => {
    if ((await level()) === 1) {
      throw new Error('Automation level 1 (assistant only): do not change records. Tell the owner exactly what you recommend instead.');
    }
    return fn(a);
  });

  /** After requesting an approval: in level 3, low-risk routine actions run straight away. */
  const AUTO_TYPES = new Set<ApprovalRequest['type']>(['purchase_order', 'review_response', 'stock_adjustment']);
  async function afterApproval(req: ApprovalRequest) {
    emit({ kind: 'artifact', text: `Approval requested: ${req.title}`, data: { approvalId: req.id, type: req.type } });
    if ((await level()) === 3 && req.risk === 'low' && AUTO_TYPES.has(req.type)) {
      const { result } = await executeApproval(businessId, req.id, `${ACTOR} (auto, level 3)`);
      emit({ kind: 'artifact', text: `Auto-executed (low risk): ${result}`, data: { approvalId: req.id } });
      return { approvalId: req.id, status: 'auto_executed', result };
    }
    return { approvalId: req.id, status: 'waiting_for_owner_approval', risk: req.risk };
  }

  const lineSchema = z.object({
    product: z.string().describe('Product id, SKU, barcode or exact name'),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative().optional().describe('Defaults to the product price'),
  });

  const tools = [
    tool('share_plan', 'Show the owner your step-by-step plan before acting. Call this first for any multi-step goal.',
      { steps: z.array(z.string()).min(1) },
      async ({ steps }) => { emit({ kind: 'plan', text: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), data: steps }); return ok('Plan shared.'); }),

    // ------------------------------------------------------------ read
    tool('get_business_overview', 'Snapshot of the business today: settings, sales, stock alerts, approvals, invoices, bills, reviews, connected integrations.', {},
      safe(async () => {
        const db = await readSnapshot(businessId);
        const integrations = await Promise.all(PROVIDERS.map(async (p) => {
          const c = await providerContext(businessId, p);
          return { id: p.id, label: p.label, ready: isConfigured(p, c) && (!p.oauth || Boolean(c.tokens.access_token)) };
        }));
        const rs = m.reviewStats(db.reviews);
        return {
          business: { name: db.settings.name, mode: db.settings.mode, currency: db.settings.currency, automationLevel: db.settings.automationLevel, approvalLimit: db.settings.approvalLimitAmount, brandVoice: db.settings.brandVoice, targetAudience: db.settings.targetAudience, prohibitedClaims: db.settings.prohibitedClaims, differentiators: db.settings.brandDifferentiators, visualStyle: db.settings.brandStyle, languages: db.settings.brandLanguages, competitors: db.settings.brandCompetitors },
          cash: m.cashPosition(db),
          counts: { products: db.products.length, suppliers: db.suppliers.length, orders: db.salesOrders.length, invoices: db.invoices.length },
          today: m.todaySales(db), last7Days: m.salesLastNDays(db, 7), last30Days: m.salesLastNDays(db, 30),
          awaitingFulfilment: m.awaitingFulfilment(db).length,
          lowStock: m.lowStockProducts(db).map((p) => ({ sku: p.sku, name: p.name, available: m.availableStock(p), reorderLevel: p.reorderLevel })),
          pendingApprovals: db.approvals.filter((a) => a.status === 'pending').map((a) => ({ id: a.id, title: a.title, risk: a.risk })),
          overdueInvoices: m.overdueInvoices(db).map((i) => ({ number: i.invoiceNumber, customer: i.customerName, total: i.total })),
          billsDueIn14Days: m.upcomingBills(db, 14).map((e) => ({ description: e.description, amount: e.amount, due: e.dueDate })),
          latePurchaseOrders: m.latePurchaseOrders(db).map((p) => p.poNumber),
          reviews: { total: rs.total, avgRating: r2(rs.avgRating), unanswered: rs.unresolved.length, negative: rs.negative.length },
          openTickets: db.tickets.filter((t) => t.status !== 'resolved').length,
          integrations,
        };
      })),

    tool('list_products', 'List products with stock levels. Optional text filter and low-stock-only flag.',
      { query: z.string().optional(), lowStockOnly: z.boolean().optional() },
      safe(async ({ query, lowStockOnly }) => {
        const db = await readSnapshot(businessId);
        let list = lowStockOnly ? m.lowStockProducts(db) : db.products;
        if (query) { const q = query.toLowerCase(); list = list.filter((p) => `${p.sku} ${p.name} ${p.category} ${p.barcode}`.toLowerCase().includes(q)); }
        return list.slice(0, 100).map(productView);
      })),

    tool('get_reorder_suggestions', 'Products that need replenishing with suggested quantity and supplier, based on real sales velocity and lead times.', {},
      safe(async () => {
        const db = await readSnapshot(businessId);
        return ops.reorderSuggestions(db).map((s) => ({
          product: { id: s.product.id, sku: s.product.sku, name: s.product.name, unitCost: s.product.unitCost },
          supplier: s.supplier ? { id: s.supplier.id, name: s.supplier.name, leadTimeDays: s.supplier.leadTimeDays, minOrderQty: s.supplier.minOrderQty } : null,
          available: s.available, daysLeft: s.daysLeft, stockoutDate: s.stockoutDate, urgency: s.urgency, suggestedQty: s.suggestedQty, reason: s.reason,
        }));
      })),

    tool('get_inventory_health', 'Stock alerts (out of stock, low, expiring within 30 days, expired, no sales, slow-moving, held as damaged/quarantined) and stock valuation at cost and selling price.', {},
      safe(async () => {
        const db = await readSnapshot(businessId);
        const v = m.stockValuation(db);
        return {
          alerts: m.inventoryAlerts(db).map((a) => ({ product: a.product.name, sku: a.product.sku, kind: a.kind, severity: a.severity, detail: a.detail })),
          valuation: { units: v.units, atCost: r2(v.totalCost), atSellingPrice: r2(v.totalRetail), heldAtCost: r2(v.totalHeld) },
        };
      })),

    tool('get_cash_flow', 'Money available now (capital + sales − expenses − placed POs), money expected in (unpaid invoices) and out (unpaid bills, repeating costs, POs waiting) over the next N days, the projected balance and a low-cash warning. Also lists products selling below cost or under the target margin.',
      { days: z.number().int().positive().max(365).default(30) },
      safe(async ({ days }) => {
        const db = await readSnapshot(businessId);
        const f = m.cashFlowForecast(db, days);
        return {
          ...f,
          marginIssues: m.marginCheck(db).filter((x) => x.flag !== 'ok').map((x) => ({ product: x.product.name, price: x.product.price, unitCost: x.product.unitCost, marginPct: x.marginPct, flag: x.flag, priceForTarget: x.targetPrice })),
          targetMarginPct: db.settings.targetMarginPct,
        };
      })),

    tool('list_returns', 'Customer returns with reason, condition, what happened to the goods and refund status, plus return patterns (top reasons, most returned products).', {},
      safe(async () => {
        const db = await readSnapshot(businessId);
        return {
          returns: db.returns.slice(0, 50).map((r) => ({ ...r, product: db.products.find((p) => p.id === r.productId)?.name ?? null })),
          patterns: m.returnStats(db),
        };
      })),

    tool('sales_report', 'Sales for the last N days: totals by channel and source, top products with margin, and daily series.',
      { days: z.number().int().min(1).max(365).default(30) },
      safe(async ({ days }) => {
        const db = await readSnapshot(businessId);
        const since = Date.now() - days * 86_400_000;
        const orders = m.paidOrders(db.salesOrders.filter((o) => new Date(o.date).getTime() >= since));
        const by = (k: 'channel' | 'source') => Object.fromEntries([...new Set(orders.map((o) => o[k]))].map((v) => [v, r2(m.salesTotal(orders.filter((o) => o[k] === v)))]));
        return {
          days, orders: orders.length, revenue: r2(m.salesTotal(orders)), byChannel: by('channel'), bySource: by('source'),
          topProducts: m.productPerformance(db, days).slice(0, 15).map((p) => ({ sku: p.product.sku, name: p.product.name, units: p.units, revenue: r2(p.revenue), grossProfit: r2(p.grossProfit), marginPct: r2(p.marginPct) })),
          daily: m.dailySalesSeries(db, Math.min(days, 60)).map((d) => ({ date: d.date, online: r2(d.online), retail: r2(d.retail) })),
        };
      })),

    tool('profit_and_loss', 'Profit and loss for the last N days (revenue, COGS, gross profit, expenses, net profit).',
      { days: z.number().int().min(1).max(365).default(30) },
      safe(async ({ days }) => {
        const p = m.profitAndLoss(await readSnapshot(businessId), days);
        return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, r2(v)]));
      })),

    tool('list_suppliers', 'Suppliers with cost, MOQ, lead time and performance from purchase history.', {},
      safe(async () => {
        const db = await readSnapshot(businessId);
        return db.suppliers.map((s) => ({ id: s.id, name: s.name, email: s.email, phone: s.phone, categories: s.categories, minOrderQty: s.minOrderQty, leadTimeDays: s.leadTimeDays, paymentTerms: s.paymentTerms, reliabilityScore: s.reliabilityScore, onTimeRate: s.onTimeRate }));
      })),

    tool('list_purchase_orders', 'Purchase orders, optionally filtered by status.',
      { status: z.string().optional() },
      safe(async ({ status }) => {
        const db = await readSnapshot(businessId);
        return db.purchaseOrders.filter((p) => !status || p.status === status).slice(0, 50).map((p) => ({
          id: p.id, poNumber: p.poNumber, supplier: db.suppliers.find((s) => s.id === p.supplierId)?.name, status: p.status, totalCost: p.totalCost, expectedDate: p.expectedDate,
          lines: p.lines.map((l) => ({ product: db.products.find((x) => x.id === l.productId)?.name, quantity: l.quantity, unitCost: l.unitCost, received: l.receivedQty ?? 0 })),
        }));
      })),

    tool('list_orders', 'Sales orders, optionally filtered by status (awaiting_fulfilment, fulfilled, cancelled) and source.',
      { status: z.string().optional(), source: z.string().optional(), limit: z.number().int().max(200).default(30) },
      safe(async ({ status, source, limit }) => {
        const db = await readSnapshot(businessId);
        return db.salesOrders.filter((o) => (!status || o.status === status) && (!source || o.source === source)).slice(0, limit).map((o) => ({
          id: o.id, orderNumber: o.orderNumber, source: o.source, date: o.date, customer: o.customerName, total: o.total, status: o.status, payment: o.paymentStatus,
          postcode: o.shippingPostcode, shipment: o.shipment ? { courier: o.shipment.courier, status: o.shipment.status, trackingNo: o.shipment.trackingNo } : null,
          invoiceId: o.invoiceId, lines: o.lines.map((l) => `${l.quantity}× ${l.name ?? l.sku}${l.productId ? '' : ' (unmatched)'}`),
        }));
      })),

    tool('list_invoices', 'Invoices with status and e-invoice (MyInvois) status.',
      { status: z.string().optional() },
      safe(async ({ status }) => {
        const db = await readSnapshot(businessId);
        return db.invoices.filter((i) => !status || i.status === status).slice(0, 50).map((i) => ({ id: i.id, number: i.invoiceNumber, customer: i.customerName, email: i.customerEmail, total: i.total, status: i.status, due: i.dueDate, einvoice: i.einvoice.status }));
      })),

    tool('list_reviews', 'Customer reviews, filterable by status (new/responded/escalated) and sentiment.',
      { status: z.string().optional(), sentiment: z.string().optional() },
      safe(async ({ status, sentiment }) => {
        const db = await readSnapshot(businessId);
        return db.reviews.filter((r) => (!status || r.status === status) && (!sentiment || r.sentiment === sentiment)).slice(0, 50).map((r) => ({
          id: r.id, source: r.source, rating: r.rating, customer: r.customerName, text: r.text, sentiment: r.sentiment, topic: r.topic, status: r.status, product: db.products.find((p) => p.id === r.productId)?.name ?? null, draftResponse: r.draftResponse ?? null,
        }));
      })),

    tool('list_tickets', 'Support tickets.', { status: z.string().optional() },
      safe(async ({ status }) => (await readSnapshot(businessId)).tickets.filter((t) => !status || t.status === status).slice(0, 50))),

    tool('list_marketing', 'Content calendar items and campaigns with performance (ROAS).', {},
      safe(async () => {
        const db = await readSnapshot(businessId);
        return {
          content: db.contentItems.slice(0, 50).map((c) => ({ id: c.id, title: c.title, platform: c.platform, status: c.status, scheduledDate: c.scheduledDate, error: c.error })),
          campaigns: db.campaigns.map((c) => ({ ...c, roas: c.spend > 0 ? r2(c.revenue / c.spend) : null, ctr: c.impressions > 0 ? r2((c.clicks / c.impressions) * 100) : null })),
        };
      })),

    tool('list_approvals', 'Approval queue.', { status: z.enum(['pending', 'approved', 'rejected']).default('pending') },
      safe(async ({ status }) => (await readSnapshot(businessId)).approvals.filter((a) => a.status === status).slice(0, 50).map((a) => ({ id: a.id, type: a.type, title: a.title, amount: a.amount, risk: a.risk, executionResult: a.executionResult })))),

    // ------------------------------------------------------------ skills and extra reads
    tool('load_skill', 'Load the full instructions of a BizPilot skill (see the skills list in your instructions). Call this before doing a task the skill covers, then follow it.',
      { name: z.string() },
      safe(async ({ name }) => {
        const skill = getSkill(name);
        if (!skill) throw new Error(`No skill called "${name}". Available: ${listSkills().map((k) => k.name).join(', ')}.`);
        emit({ kind: 'status', text: `Using skill: ${skill.name}` });
        return skill.body;
      })),

    tool('get_business_profile', 'The business legal and tax identity (registered name, TIN, SSM no., SST no., MSIC, address, contact), invoice settings and which fields LHDN MyInvois still needs.', {},
      safe(async () => {
        const s = (await readSnapshot(businessId)).settings;
        return {
          tradingName: s.name, legalName: s.legalName, tin: s.tin, ssmBrn: s.brn, sstNo: s.sstNo, msicCode: s.msicCode, msicDescription: s.msicDescription,
          email: s.email, phone: s.phone, address: [s.addressLine, s.postcode, s.city].filter(Boolean).join(', '), stateCode: s.stateCode,
          defaultTaxRatePct: s.defaultTaxRate, invoicePrefix: s.invoicePrefix, shipFromPostcode: s.shipFromPostcode,
          lowStockThresholdDays: s.lowStockThresholdDays, approvalLimit: s.approvalLimitAmount, automationLevel: s.automationLevel,
          missingForEinvoice: missingSupplierFields(s),
        };
      })),

    tool('get_invoice', 'Full detail of one invoice: buyer details, lines, tax, totals, status and MyInvois e-invoice state.',
      { invoice: z.string().describe('Invoice id or number') },
      safe(async ({ invoice }) => {
        const db = await readSnapshot(businessId);
        const inv = db.invoices.find((i) => i.id === invoice || i.invoiceNumber === invoice);
        if (!inv) throw new Error('Invoice not found.');
        return inv;
      })),

    tool('check_buyer_tin', 'Validate a buyer TIN with LHDN MyInvois (needs MyInvois connected). idType: BRN (company SSM no.), NRIC, PASSPORT or ARMY.',
      { tin: z.string(), idType: z.enum(['BRN', 'NRIC', 'PASSPORT', 'ARMY']), idValue: z.string() },
      safe(async ({ tin, idType, idValue }) => checkTin(businessId, tin, idType, idValue))),

    tool('list_expenses', 'Expenses and bills for the last N days (paid and unpaid), with totals by category and the recurring monthly total.',
      { days: z.number().int().min(1).max(366).default(30), unpaidOnly: z.boolean().optional() },
      safe(async ({ days, unpaidOnly }) => {
        const db = await readSnapshot(businessId);
        const since = Date.now() - days * 86_400_000;
        const list = db.expenses.filter((e) => (unpaidOnly ? !e.paid : new Date(e.date).getTime() >= since));
        const byCategory: Record<string, number> = {};
        for (const e of list) byCategory[e.category] = r2((byCategory[e.category] ?? 0) + e.amount);
        const recurring = db.expenses.filter((e) => e.recurring);
        return {
          days, total: r2(list.reduce((t, e) => t + e.amount, 0)), byCategory,
          recurringMonthly: r2(recurring.reduce((t, e) => t + e.amount, 0)),
          recurringItems: recurring.map((e) => ({ category: e.category, description: e.description, amount: e.amount })),
          items: list.slice(0, 100).map((e) => ({ date: e.date, category: e.category, description: e.description, amount: e.amount, paid: e.paid, dueDate: e.dueDate ?? null, recurring: e.recurring })),
        };
      })),

    // ------------------------------------------------------------ write: master data
    tool('create_product', 'Add a new product to the catalogue (stock starts at openingStock).',
      { name: z.string(), sku: z.string().optional(), category: z.string().optional(), description: z.string().max(6000).optional().describe('Listing copy: title, bullets, specs, keywords'), price: z.number().nonnegative(), unitCost: z.number().nonnegative(), reorderLevel: z.number().int().nonnegative().optional(), safetyStock: z.number().int().nonnegative().optional(), maxStock: z.number().int().nonnegative().optional().describe('0 = no limit'), orderMultiple: z.number().int().positive().optional().describe('Supplier pack size'), expiryDate: z.string().optional().describe('YYYY-MM-DD of the earliest batch, empty if none'), openingStock: z.number().int().nonnegative().optional(), supplier: z.string().optional().describe('Supplier id or name'), weightKg: z.number().positive().optional(), barcode: z.string().optional() },
      write(async (a) => withBusiness(businessId, (db) => {
        const supplierId = a.supplier ? ops.findSupplier(db, a.supplier)?.id ?? null : null;
        const p = ops.createProduct(db, { ...a, supplierId }, ACTOR);
        emit({ kind: 'artifact', text: `Product created: ${p.sku} ${p.name}` });
        return productView(p);
      }))),

    tool('update_product', 'Edit product details (name, category, description/listing copy, reorder level, safety stock, max stock, pack size, expiry date, supplier, cost, weight, channel SKUs). Price changes must use request_price_change; stock changes must use record_stock_movement or request_stock_adjustment.',
      { product: z.string(), name: z.string().optional(), category: z.string().optional(), description: z.string().max(6000).optional().describe('Listing copy: title, bullets, specs, keywords'), reorderLevel: z.number().int().nonnegative().optional(), safetyStock: z.number().int().nonnegative().optional(), maxStock: z.number().int().nonnegative().optional().describe('0 = no limit'), orderMultiple: z.number().int().positive().optional().describe('Supplier pack size'), expiryDate: z.string().optional().describe('YYYY-MM-DD of the earliest batch, empty if none'), unitCost: z.number().nonnegative().optional(), weightKg: z.number().positive().optional(), supplier: z.string().optional(), channelSkus: z.record(z.string(), z.string()).optional() },
      write(async ({ product, supplier, ...patch }) => withBusiness(businessId, (db) => {
        const p = ops.requireProduct(db, product);
        const extra = supplier ? { supplierId: ops.findSupplier(db, supplier)?.id ?? null } : {};
        return productView(ops.updateProduct(db, p.id, { ...patch, ...extra }, ACTOR));
      }))),

    tool('create_supplier', 'Add a supplier.',
      { name: z.string(), contactPerson: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), categories: z.array(z.string()).optional(), minOrderQty: z.number().int().nonnegative().optional(), leadTimeDays: z.number().int().positive().optional(), paymentTerms: z.string().optional(), notes: z.string().optional() },
      write(async (a) => withBusiness(businessId, (db) => {
        const s = ops.createSupplier(db, a, ACTOR);
        emit({ kind: 'artifact', text: `Supplier created: ${s.name}` });
        return { id: s.id, name: s.name };
      }))),

    // ------------------------------------------------------------ write: purchasing & stock
    tool('hold_stock', 'Mark units on hand as not sellable (damaged, expired or quarantined). Sets the total held quantity for the product; 0 releases it. Held stock is excluded from available-to-sell.',
      { product: z.string(), heldQuantity: z.number().int().nonnegative(), reason: z.string() },
      write(async ({ product, heldQuantity, reason }) => withBusiness(businessId, (db) => productView(ops.setHeldStock(db, ops.requireProduct(db, product).id, heldQuantity, reason, ACTOR))))),

    tool('record_return', 'Record a customer return (reason, condition). Then use resolve_return to decide what happens to the goods and any refund.',
      {
        product: z.string(),
        quantity: z.number().int().positive(),
        reason: z.enum(['damaged', 'defective', 'wrong_item', 'not_as_described', 'changed_mind', 'expired', 'other']),
        condition: z.enum(['unopened', 'opened', 'damaged', 'defective']),
        order: z.string().optional().describe('Order id or order number'),
        customerName: z.string().optional(),
        notes: z.string().optional(),
      },
      write(async (a) => withBusiness(businessId, (db) => {
        const r = ops.createReturn(db, { productId: ops.requireProduct(db, a.product).id, orderId: a.order ?? null, quantity: a.quantity, reason: a.reason, condition: a.condition, customerName: a.customerName, notes: a.notes }, ACTOR);
        emit({ kind: 'artifact', text: `Return recorded: ${r.returnNumber}` });
        return r;
      }))),

    tool('resolve_return', 'Close a return: restock (back to sellable stock), quarantine (held), dispose or supplier_return. A refund above 0 goes to the owner for approval.',
      { returnId: z.string().describe('Return id or number, e.g. RET-00001'), resolution: z.enum(['restock', 'quarantine', 'dispose', 'supplier_return']), refundAmount: z.number().nonnegative().default(0) },
      write(async ({ returnId, resolution, refundAmount }) => {
        const out = await withBusiness(businessId, (db) => ops.resolveReturn(db, returnId, resolution, refundAmount, ACTOR));
        return out.approval ? { returnNumber: out.ret.returnNumber, ...(await afterApproval(out.approval)) } : { returnNumber: out.ret.returnNumber, status: 'resolved' };
      })),

    tool('draft_purchase_order', 'Create a draft purchase order and send it to the owner for approval. Unit cost defaults to the product cost. Fails if the business does not have the cash: then order less (fit get_business_overview cash.balance) or tell the owner.',
      { supplier: z.string(), lines: z.array(z.object({ product: z.string(), quantity: z.number().int().positive(), unitCost: z.number().nonnegative().optional() })).min(1), note: z.string().optional(), expectedDate: z.string().optional() },
      write(async ({ supplier, lines, note, expectedDate }) => {
        const req = await withBusiness(businessId, (db) => {
          const s = ops.findSupplier(db, supplier);
          if (!s) throw new ops.OpError(`No supplier matches "${supplier}". Use list_suppliers or create_supplier.`);
          const poLines = lines.map((l) => { const p = ops.requireProduct(db, l.product); return { productId: p.id, quantity: l.quantity, unitCost: l.unitCost ?? p.unitCost }; });
          // Check the money first, so the owner is never asked to approve an order they can't pay for.
          ops.assertCashFor(db, poLines.reduce((t, l) => t + l.quantity * l.unitCost, 0), 'this purchase order');
          const po = ops.createPurchaseOrder(db, { supplierId: s.id, lines: poLines, note, expectedDate }, ACTOR);
          emit({ kind: 'artifact', text: `Draft ${po.poNumber} for ${s.name}: RM${po.totalCost.toFixed(2)}` });
          return ops.requestApproval(db, {
            type: 'purchase_order', title: `${po.poNumber} to ${s.name} (RM${po.totalCost.toFixed(2)})`,
            description: poLines.map((l) => `${l.quantity}× ${db.products.find((p) => p.id === l.productId)?.name} @ RM${l.unitCost}`).join('; ') + (note ? ` — ${note}` : ''),
            payload: { purchaseOrderId: po.id }, amount: po.totalCost,
          }, ACTOR);
        });
        return afterApproval(req);
      })),

    tool('receive_purchase_order', 'Record goods received for an ordered PO. Only use when the owner confirms goods physically arrived.',
      { purchaseOrder: z.string().describe('PO id or number'), quantities: z.record(z.string(), z.number().int().nonnegative()).optional().describe('productId → received qty; omit to receive everything') },
      write(async ({ purchaseOrder, quantities }) => withBusiness(businessId, (db) => {
        const po = db.purchaseOrders.find((p) => p.id === purchaseOrder || p.poNumber === purchaseOrder);
        if (!po) throw new ops.OpError('Purchase order not found.');
        const r = ops.receivePurchaseOrder(db, po.id, quantities ?? 'all', ACTOR);
        return { poNumber: r.poNumber, status: r.status };
      }))),

    tool('record_stock_movement', 'Record stock in/out with a reason (e.g. goods received without PO, damaged stock written off).',
      { product: z.string(), type: z.enum(['in', 'out']), quantity: z.number().int().positive(), reason: z.string() },
      write(async ({ product, type, quantity, reason }) => withBusiness(businessId, (db) => {
        const p = ops.requireProduct(db, product);
        ops.recordStockMovement(db, p.id, type, quantity, reason, 'AGENT', ACTOR);
        return productView(p);
      }))),

    tool('request_stock_adjustment', 'After a stock count, request approval to correct on-hand stock to the counted quantity.',
      { product: z.string(), countedQty: z.number().int().nonnegative(), reason: z.string() },
      write(async ({ product, countedQty, reason }) => {
        const req = await withBusiness(businessId, (db) => {
          const p = ops.requireProduct(db, product);
          const diff = countedQty - p.stock;
          if (diff === 0) throw new ops.OpError(`${p.name} already shows ${p.stock} on hand.`);
          return ops.requestApproval(db, { type: 'stock_adjustment', title: `Adjust ${p.name} by ${diff > 0 ? '+' : ''}${diff}`, description: `System ${p.stock}, counted ${countedQty}. ${reason}`, payload: { productId: p.id, quantity: diff, reason }, amount: Math.abs(diff) * p.unitCost }, ACTOR);
        });
        return afterApproval(req);
      })),

    tool('request_price_change', 'Request approval to change a product selling price. Include the reasoning (margin, competitor price, demand).',
      { product: z.string(), newPrice: z.number().positive(), reason: z.string() },
      write(async ({ product, newPrice, reason }) => {
        const req = await withBusiness(businessId, (db) => {
          const p = ops.requireProduct(db, product);
          const margin = newPrice > 0 ? ((newPrice - p.unitCost) / newPrice) * 100 : 0;
          if (newPrice < p.unitCost) throw new ops.OpError(`RM${newPrice} is below unit cost RM${p.unitCost}; that sells at a loss.`);
          return ops.requestApproval(db, { type: 'price_change', title: `${p.name}: RM${p.price} → RM${newPrice}`, description: `${reason} (new margin ${margin.toFixed(1)}%)`, payload: { productId: p.id, newPrice }, risk: Math.abs(newPrice - p.price) / Math.max(p.price, 0.01) > 0.15 ? 'medium' : 'low' }, ACTOR);
        });
        return afterApproval(req);
      })),

    // ------------------------------------------------------------ write: sales & finance
    tool('record_sale', 'Record a sale (retail walk-in or manual online order). Stock is reserved, or deducted immediately if fulfilNow.',
      { channel: z.enum(['online', 'retail']), lines: z.array(lineSchema).min(1), customerName: z.string().optional(), customerEmail: z.string().optional(), customerPhone: z.string().optional(), shippingAddress: z.string().optional(), shippingPostcode: z.string().optional(), paymentMethod: z.string().optional(), paymentStatus: z.enum(['paid', 'pending']).default('paid'), fulfilNow: z.boolean().optional() },
      write(async ({ lines, ...a }) => withBusiness(businessId, (db) => {
        const so = ops.createSalesOrder(db, { ...a, lines: lines.map((l) => { const p = ops.requireProduct(db, l.product); return { productId: p.id, quantity: l.quantity, unitPrice: l.unitPrice ?? p.price }; }) }, ACTOR);
        emit({ kind: 'artifact', text: `Sale ${so.orderNumber}: RM${so.total.toFixed(2)}` });
        return { id: so.id, orderNumber: so.orderNumber, total: so.total, status: so.status };
      }))),

    tool('fulfil_order', 'Mark an order as handed over/shipped and deduct stock.',
      { order: z.string().describe('Order id or number') },
      write(async ({ order }) => withBusiness(businessId, (db) => {
        const o = db.salesOrders.find((x) => x.id === order || x.orderNumber === order);
        if (!o) throw new ops.OpError('Order not found.');
        return { orderNumber: ops.fulfilSalesOrder(db, o.id, ACTOR).orderNumber, status: 'fulfilled' };
      }))),

    tool('create_invoice', 'Create a draft invoice, either from an existing order or from custom lines. Then use request_invoice_issue / request_einvoice_submit.',
      { order: z.string().optional(), customerName: z.string().optional(), customerEmail: z.string().optional(), customerTin: z.string().optional(), customerBrn: z.string().optional(), customerAddress: z.string().optional(), dueDays: z.number().int().nonnegative().optional(),
        lines: z.array(z.object({ description: z.string(), quantity: z.number().positive(), unitPrice: z.number().nonnegative(), taxRate: z.number().min(0).max(100).optional() })).optional() },
      write(async ({ order, lines, ...buyer }) => withBusiness(businessId, (db) => {
        let inv;
        if (order) {
          const o = db.salesOrders.find((x) => x.id === order || x.orderNumber === order);
          if (!o) throw new ops.OpError('Order not found.');
          inv = ops.createInvoiceFromOrder(db, o.id, buyer, ACTOR);
        } else {
          if (!lines?.length || !buyer.customerName) throw new ops.OpError('Give an order, or customerName and lines.');
          inv = ops.createInvoice(db, { ...buyer, customerName: buyer.customerName, lines: lines.map((l) => ({ ...l, taxRate: l.taxRate ?? db.settings.defaultTaxRate })) }, ACTOR);
        }
        emit({ kind: 'artifact', text: `Draft invoice ${inv.invoiceNumber}: RM${inv.total.toFixed(2)}` });
        return { id: inv.id, invoiceNumber: inv.invoiceNumber, total: inv.total };
      }))),

    tool('request_invoice_issue', 'Ask the owner to approve issuing a draft invoice (it is emailed to the customer if email is connected).',
      { invoice: z.string() },
      write(async ({ invoice }) => {
        const req = await withBusiness(businessId, (db) => {
          const inv = db.invoices.find((i) => i.id === invoice || i.invoiceNumber === invoice);
          if (!inv) throw new ops.OpError('Invoice not found.');
          return ops.requestApproval(db, { type: 'invoice_issue', title: `Issue ${inv.invoiceNumber} to ${inv.customerName} (RM${inv.total.toFixed(2)})`, description: inv.lines.map((l) => `${l.quantity}× ${l.description}`).join('; '), payload: { invoiceId: inv.id }, amount: inv.total }, ACTOR);
        });
        return afterApproval(req);
      })),

    tool('request_einvoice_submit', 'Ask the owner to approve submitting an invoice to LHDN MyInvois.',
      { invoice: z.string() },
      write(async ({ invoice }) => {
        const { approvalId } = await requestEinvoiceSubmit(businessId, invoice, ACTOR);
        emit({ kind: 'artifact', text: 'Approval requested: submit e-invoice to MyInvois', data: { approvalId } });
        return { approvalId, status: 'waiting_for_owner_approval' };
      })),

    tool('add_expense', 'Record a business expense or an unpaid bill (paid=false with dueDate).',
      { category: z.string(), description: z.string(), amount: z.number().positive(), date: z.string().optional(), paid: z.boolean().default(true), dueDate: z.string().optional(), recurring: z.boolean().default(false) },
      write(async (a) => withBusiness(businessId, (db) => {
        const e = ops.addExpense(db, { ...a, date: a.date ?? new Date().toISOString(), dueDate: a.dueDate ?? null }, ACTOR);
        return { id: e.id, amount: e.amount };
      }))),

    // ------------------------------------------------------------ logistics & marketplaces
    tool('quote_shipping', 'Get live courier rates from EasyParcel for an order.',
      { order: z.string() },
      safe(async ({ order }) => quoteForOrder(businessId, order))),

    tool('request_shipment_booking', 'Ask the owner to approve booking a courier (from quote_shipping) for an order.',
      { order: z.string(), serviceId: z.string(), courier: z.string(), price: z.number().nonnegative() },
      write(async ({ order, ...b }) => {
        const { approvalId } = await requestBooking(businessId, ACTOR, { orderId: order, ...b });
        emit({ kind: 'artifact', text: `Approval requested: book ${b.courier} RM${b.price.toFixed(2)}`, data: { approvalId } });
        return { approvalId, status: 'waiting_for_owner_approval' };
      })),

    tool('sync_marketplace', 'Import the latest orders (and reviews where supported) from Shopee, Lazada or TikTok Shop.',
      { provider: z.enum(['shopee', 'lazada', 'tiktok_shop']) },
      write(async ({ provider }) => syncMarketplace(businessId, provider, ACTOR))),

    // ------------------------------------------------------------ customers & marketing
    tool('draft_review_reply', 'Save a reply to a review and send it for owner approval. Follow the brand voice; never admit legal liability or promise refunds without approval.',
      { review: z.string().describe('Review id'), response: z.string() },
      write(async ({ review, response }) => {
        const req = await withBusiness(businessId, (db) => {
          const r = db.reviews.find((x) => x.id === review);
          if (!r) throw new ops.OpError('Review not found.');
          r.draftResponse = response;
          return ops.requestApproval(db, { type: 'review_response', title: `Reply to ${r.rating}★ ${r.source} review from ${r.customerName}`, description: response, payload: { reviewId: r.id, response }, risk: r.rating <= 2 ? 'medium' : 'low' }, ACTOR);
        });
        return afterApproval(req);
      })),

    tool('escalate_review', 'Flag a review for the owner (e.g. safety, legal or refund issue).',
      { review: z.string(), reason: z.string() },
      write(async ({ review, reason }) => withBusiness(businessId, (db) => {
        const r = db.reviews.find((x) => x.id === review);
        if (!r) throw new ops.OpError('Review not found.');
        r.status = 'escalated';
        ops.notify(db, `Review escalated (${r.rating}★)`, reason, 'critical');
        ops.audit(db, ACTOR, 'escalate', 'review', r.id, reason);
        return { ok: true };
      }))),

    tool('create_ticket', 'Open a support ticket.',
      { subject: z.string(), customerName: z.string().optional(), customerEmail: z.string().optional(), body: z.string().optional(), priority: z.enum(['low', 'medium', 'high']).default('medium') },
      write(async (a) => withBusiness(businessId, (db) => ({ id: ops.addTicket(db, a, ACTOR).id })))),

    tool('update_ticket', 'Update a support ticket status or notes.',
      { ticket: z.string(), status: z.enum(['open', 'in_progress', 'resolved']).optional(), notes: z.string().optional() },
      write(async ({ ticket, ...patch }) => withBusiness(businessId, (db) => ({ status: ops.updateTicket(db, ticket, patch, ACTOR).status })))),

    tool('request_customer_email', 'Ask the owner to approve sending an email to a customer or supplier (sent from the business mailbox).',
      { to: z.string(), subject: z.string(), body: z.string() },
      write(async (a) => {
        const req = await withBusiness(businessId, (db) => ops.requestApproval(db, { type: 'customer_message', title: `Email ${a.to}: ${a.subject}`, description: a.body, payload: a }, ACTOR));
        return afterApproval(req);
      })),

    tool('draft_content', 'Create a marketing content draft (post, carousel, video script, ad). Respect brand voice and prohibited claims. Optionally send it for publishing approval.',
      { title: z.string(), platform: z.enum(['Facebook', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn']), type: z.enum(['post', 'carousel', 'video_script', 'ad']), body: z.string(), imageUrl: z.string().optional(), scheduledDate: z.string().describe('ISO date-time'), requestPublish: z.boolean().default(false) },
      write(async ({ requestPublish, ...c }) => {
        const out = await withBusiness(businessId, (db) => {
          const issues = checkCompliance(`${c.title}\n${c.body}`, db);
          const blocks = issues.filter((i) => i.level === 'block');
          if (blocks.length) throw new ops.OpError(`Compliance check failed, rewrite the draft: ${blocks.map((i) => `${i.rule} ("${i.match}")`).join('; ')}.`);
          const item: ContentItem = ops.addContentItem(db, { ...c, imageUrl: c.imageUrl ?? '', campaignId: null }, ACTOR);
          emit({ kind: 'artifact', text: `Content draft: ${item.platform} ${item.title}` });
          if (!requestPublish) return { contentId: item.id, req: null };
          item.status = 'in_review';
          return { contentId: item.id, req: ops.requestApproval(db, { type: 'marketing_publish', title: `Publish "${item.title}" on ${item.platform}`, description: item.body.slice(0, 400), payload: { contentId: item.id } }, ACTOR) };
        });
        const warnings = checkCompliance(`${c.title}\n${c.body}`, await readSnapshot(businessId)).map((i) => `${i.rule}: "${i.match}"`);
        return out.req ? { contentId: out.contentId, complianceWarnings: warnings, ...(await afterApproval(out.req)) } : { contentId: out.contentId, status: 'draft', complianceWarnings: warnings };
      })),

    tool('check_content_compliance', 'Check marketing text against the owner\'s prohibited claims and Malaysian advertising rules (guarantees, medical/safety claims, superlatives, pressure tactics, prices not matching products). Run before drafting final copy.',
      { text: z.string() },
      safe(async ({ text }) => {
        const issues = checkCompliance(text, await readSnapshot(businessId));
        return issues.length ? { passed: !issues.some((i) => i.level === 'block'), issues } : { passed: true, issues: [] };
      })),

    tool('generate_image', 'Generate a real AI image (product shot, poster, social post visual, thumbnail) from a detailed English prompt. Returns a public image URL. Optionally attach it to a content draft. Put the image in your reply as ![short title](url) so the owner sees it.',
      {
        prompt: z.string().describe('Detailed visual description: subject, setting, style, lighting, colours, camera angle. Describe the product exactly; never add text, logos or prices to the image.'),
        aspect: z.enum(['1:1', '4:5', '9:16', '16:9']).default('1:1').describe('1:1 or 4:5 for feed posts, 9:16 for TikTok/Reels/Stories, 16:9 for YouTube'),
        contentId: z.string().optional().describe('Content draft to attach the image to'),
      },
      safe(async ({ prompt, aspect, contentId }) => {
        emit({ kind: 'status', text: 'Generating image…' });
        const img = await generateImage(businessId, prompt, aspect);
        if (contentId) {
          await withBusiness(businessId, (db) => {
            const c = db.contentItems.find((x) => x.id === contentId);
            if (!c) throw new ops.OpError('Content draft not found.');
            c.imageUrl = img.url;
            ops.audit(db, ACTOR, 'update', 'content', c.id, `AI image attached to ${c.title}`);
          });
        }
        emit({ kind: 'artifact', text: `Image generated${contentId ? ' and attached to the draft' : ''}`, data: { media: 'image', url: img.url, contentId: contentId ?? null } });
        return { url: img.url, markdown: `![Generated image](${img.url})`, attachedTo: contentId ?? null };
      })),

    tool('make_video', 'Make a real short promo video (TikTok, Reels, Shorts). With Kling AI set up it generates a real motion video; otherwise it generates one AI image per scene and the owner\'s app renders them into an animated video with captions. Either way the video is saved on the content draft. Use 3 to 6 scenes. Creates a video draft if contentId is not given.',
      {
        title: z.string(),
        platform: z.enum(['TikTok', 'Instagram', 'YouTube', 'Facebook', 'LinkedIn']).default('TikTok'),
        aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
        scenes: z.array(z.object({
          caption: z.string().max(90).describe('Short on-screen text for this scene (what viewers read)'),
          imagePrompt: z.string().describe('Detailed visual description for this scene, no text in the image'),
          seconds: z.number().min(1.5).max(6).default(3),
        })).min(2).max(6),
        contentId: z.string().optional().describe('Existing video draft to attach the video to'),
        scheduledDate: z.string().optional().describe('ISO date-time, for a new draft'),
      },
      write(async ({ title, platform, aspect, scenes, contentId, scheduledDate }) => {
        const ensureDraft = (firstImage: string) => withBusiness(businessId, (db) => {
          let c = contentId ? db.contentItems.find((x) => x.id === contentId) : undefined;
          if (contentId && !c) throw new ops.OpError('Content draft not found.');
          if (!c) {
            const body = scenes.map((r, i) => `Scene ${i + 1} (${r.seconds ?? 3}s): ${r.caption}`).join('\n');
            c = ops.addContentItem(db, { title, platform, type: 'video_script', body, imageUrl: firstImage, scheduledDate: scheduledDate ?? new Date(Date.now() + 86_400_000).toISOString(), campaignId: null }, ACTOR);
          }
          return c.id;
        });
        if (klingConfigured()) {
          // Real motion video from Kling AI; finishes in the background.
          try {
            const total = scenes.reduce((n, sc) => n + (sc.seconds ?? 3), 0);
            const shape = aspect === '9:16' ? 'Vertical' : aspect === '1:1' ? 'Square' : 'Widescreen';
            const prompt = `${shape} promotional video for social media. ${scenes.map((sc, i) => `Shot ${i + 1}: ${sc.imagePrompt}`).join(' ')} Smooth camera movement, bright commercial lighting, no on-screen text.`;
            const taskId = await startKlingVideo(prompt, aspect, total > 7 ? 10 : 5);
            const id = await ensureDraft('');
            void finishKlingVideo(businessId, taskId, id, title).catch((e) => console.error('[kling]', e));
            emit({ kind: 'artifact', text: `Kling AI is making the video: ${title}`, data: { media: 'video', engine: 'kling', contentId: id, title, aspect, scenes: [] } });
            return { contentId: id, status: 'Kling AI is generating the video (usually 2 to 6 minutes). It is saved on the draft automatically and the owner gets a notification. Tell the owner it will appear below this message and in Marketing Studio → Post & video drafts.' };
          } catch (e) {
            emit({ kind: 'status', text: `${(e as Error).message} Making a slideshow video instead.` });
          }
        }
        const rendered: { caption: string; imageUrl: string; seconds: number }[] = [];
        for (const [i, sc] of scenes.entries()) {
          emit({ kind: 'status', text: `Generating scene ${i + 1} of ${scenes.length}…` });
          const img = await generateImage(businessId, sc.imagePrompt, aspect === '16:9' ? '16:9' : aspect === '1:1' ? '1:1' : '9:16');
          rendered.push({ caption: sc.caption, imageUrl: img.url, seconds: sc.seconds ?? 3 });
        }
        const id = await ensureDraft(rendered[0].imageUrl);
        emit({ kind: 'artifact', text: `Video ready to render: ${title}`, data: { media: 'video', contentId: id, title, aspect, scenes: rendered } });
        return { contentId: id, scenes: rendered.length, status: 'The video is rendering in the owner\'s Command Centre and will be saved on the draft automatically. Tell the owner it appears below this message with a download button.' };
      })),

    tool('create_campaign', 'Create a draft ad campaign plan with budget and daily cap.',
      { name: z.string(), objective: z.enum(['awareness', 'traffic', 'leads', 'conversions', 'sales']), platform: z.string(), budget: z.number().nonnegative(), dailyCap: z.number().nonnegative().optional(), startDate: z.string().optional(), endDate: z.string().optional() },
      write(async (a) => withBusiness(businessId, (db) => ({ id: ops.addCampaign(db, a, ACTOR).id })))),

    tool('notify_owner', 'Send the owner an in-app notification (e.g. a daily briefing or an urgent risk).',
      { title: z.string(), body: z.string(), severity: z.enum(['info', 'warning', 'critical']).default('info') },
      safe(async ({ title, body, severity }) => withBusiness(businessId, (db) => { ops.notify(db, title, body, severity); return 'Notified.'; }))),
  ];

  return { server: createSdkMcpServer({ name: 'bizpilot', version: '1.0.0', tools }), toolNames: tools.map((t) => `mcp__bizpilot__${t.name}`) };
}
