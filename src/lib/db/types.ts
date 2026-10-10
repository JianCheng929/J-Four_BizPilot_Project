// BizPilot core data entities (aligned with Project Blueprint §16).
// Shared by the web app (src/) and the server (server/src) so both compute
// with exactly the same shapes and business logic.

export type BusinessMode = 'online' | 'retail' | 'hybrid';

/** Blueprint §17 role-based access: owner > manager (approvals, settings) > staff (day-to-day records) > viewer (read only). */
export type TeamRole = 'owner' | 'manager' | 'staff' | 'viewer';

export interface TeamMember {
  id: string;
  businessId: string;
  userId: string | null;
  email: string;
  role: Exclude<TeamRole, 'owner'>;
  invitedBy: string;
  invitedAt: string;
  acceptedAt: string | null;
}

export interface BusinessSettings {
  name: string;
  mode: BusinessMode;
  country: string;
  currency: string; // e.g. 'RM'
  timezone: string;
  language: string;
  lowStockThresholdDays: number; // alert if projected days of stock below this
  approvalLimitAmount: number; // RM above which actions always need approval
  automationLevel: 1 | 2 | 3; // blueprint §12
  autopilot: boolean; // WorkBuddy runs the daily operations by itself
  autopilotHour: number; // hour of day (business timezone) for the daily run
  openingCash: number; // owner's starting capital (modal), RM
  openingCashDate: string; // ISO time the owner last set openingCash; '' = never set
  brandVoice: string;
  targetAudience: string;
  prohibitedClaims: string;
  brandDifferentiators: string; // product benefits and what makes the brand different
  brandStyle: string; // colours, fonts, visual style
  brandLanguages: string; // e.g. 'English, Malay'
  brandCompetitors: string; // competitor names or links, one per line
  // Legal / tax identity (needed for LHDN MyInvois e-invoices)
  legalName: string;
  tin: string; // Tax Identification Number
  brn: string; // SSM business registration number
  sstNo: string; // SST registration, 'NA' if not registered
  msicCode: string; // 5-digit MSIC code
  msicDescription: string;
  email: string;
  phone: string; // e.g. +60123456789
  addressLine: string;
  city: string;
  postcode: string;
  stateCode: string; // MyInvois state code, e.g. '14' = W.P. Kuala Lumpur
  // Fulfilment origin (for courier quotes)
  shipFromPostcode: string;
  defaultTaxRate: number; // % SST applied on invoices, 0 if not registered
  invoicePrefix: string;
  targetMarginPct: number; // gross margin the owner aims for, used for margin alerts
  /** Couriers, delivery fees, areas and lead times (e.g. copied from the owner's own website) */
  deliveryInfo?: string;
  dismissedSignals?: Record<string, string>; // "BizPilot noticed" items the owner cleared: key -> ISO time (hidden 30 days)
  budgets?: Record<string, number>; // monthly spending budget per expense category, RM
  privacyNotice?: string; // PDPA privacy notice shown to customers
  dataRetentionMonths?: number; // keep customer personal data this long after their last order
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  description: string;
  barcode: string;
  supplierId: string | null;
  unitCost: number; // purchase / production cost
  price: number; // selling price before tax
  weightKg: number; // for courier quotes
  stock: number; // on hand
  reserved: number; // reserved for unfulfilled orders
  unavailable: number; // on hand but not sellable: damaged, expired or quarantined
  incoming: number; // ordered from suppliers, not yet received
  reorderLevel: number;
  safetyStock: number; // buffer kept for demand swings during the lead time
  maxStock: number; // shelf ceiling for reorders, 0 = no limit
  orderMultiple: number; // supplier pack size, e.g. 12 = order in boxes of 12
  expiryDate: string; // earliest expiry of stock on hand (YYYY-MM-DD), '' = none
  avgDailySales: number; // units/day, recalculated from real sales history
  status: 'active' | 'discontinued' | 'seasonal' | 'draft';
  // SKU / item ids on external channels, used to match imported orders
  channelSkus: Record<string, string>;
  /**
   * Units on hand per location id (blueprint B5). Only used once the business has locations.
   * Units not listed here count as being at the default location; "__transit__" holds units
   * on a transfer between locations. The values always add up to `stock`.
   */
  locationStock?: Record<string, number>;
  /** Batch / lot tracking (blueprint B1, A5): when on, stock is held in batches with their own expiry dates. */
  trackBatches?: boolean;
  batches?: StockBatch[];
  /** Variant of another product (blueprint B1), e.g. size M / colour red of a T-shirt. */
  parentId?: string | null;
  variantOptions?: Record<string, string> | null;
  /** Bill of materials (blueprint A2): components used to make one unit. Empty or missing = bought in, not made. */
  bom?: BomLine[];
  /** Labour and overhead per unit made, added to material cost for the production cost. */
  labourCost?: number;
  overheadCost?: number;
  bins?: Record<string, string>; // shelf/bin code per location id ('' = default location), e.g. A-01-03
}

export interface StockBatch {
  batch: string; // lot / batch number
  expiry: string; // YYYY-MM-DD, '' = no expiry
  qty: number;
  receivedAt: string; // ISO
}

export interface BomLine {
  productId: string; // component / raw material (itself a product, so it has stock, cost and a supplier)
  quantity: number; // per finished unit, may be fractional (e.g. 0.25 kg)
}

export interface ProductionMaterial {
  productId: string;
  required: number; // for the whole order
  consumed: number; // taken from stock when production started
  unitCost: number; // cost when consumed
}

export interface ProductionOrder {
  id: string;
  orderNumber: string;
  productId: string;
  quantity: number;
  locationId: string; // where materials are taken from and finished goods go ('' = default)
  status: 'pending_approval' | 'approved' | 'in_progress' | 'completed' | 'cancelled';
  materials: ProductionMaterial[];
  plannedUnitCost: number; // materials + labour + overhead per unit when planned
  actualUnitCost: number; // per good unit, set on completion
  labourCost: number; // total for the order
  overheadCost: number; // total for the order
  goodQty: number;
  rejectedQty: number;
  batchNumber: string;
  qcNotes: string;
  dueDate: string; // YYYY-MM-DD, '' = none
  note: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdBy: string;
}

/** A shop, branch, warehouse or online fulfilment point (blueprint §3, A5, B5). */
export interface Location {
  id: string;
  name: string;
  type: 'store' | 'warehouse' | 'online';
  address: string;
  isDefault: boolean;
  active: boolean;
  createdAt: string;
}

export interface TransferLine {
  productId: string;
  quantity: number;
  receivedQty?: number;
}

/** Stock moved between locations: draft → in_transit → received (or cancelled). */
export interface StockTransfer {
  id: string;
  transferNumber: string;
  fromLocationId: string;
  toLocationId: string;
  lines: TransferLine[];
  status: 'draft' | 'in_transit' | 'received' | 'cancelled';
  note: string;
  createdAt: string;
  shippedAt?: string | null;
  receivedAt?: string | null;
  createdBy: string;
}

export interface StockCountLine {
  productId: string;
  expected: number; // system quantity at the location when the count started
  counted: number | null; // null = not counted yet
}

/** Blueprint B4: a stock count at one location, with blind counting and approval of differences. */
export interface StockCount {
  id: string;
  countNumber: string;
  locationId: string;
  blind: boolean;
  status: 'open' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  lines: StockCountLine[];
  note: string;
  createdAt: string;
  submittedAt?: string | null;
  decidedAt?: string | null;
  createdBy: string;
}

export interface StockMovement {
  id: string;
  productId: string;
  type: 'in' | 'out' | 'adjustment' | 'transfer';
  locationId?: string | null; // where the units came in / went out (from-location for transfers)
  toLocationId?: string | null; // transfers only
  batch?: string | null; // batch(es) the units came from or went to, e.g. "L001×3, L002×2"
  quantity: number; // signed for adjustments
  reason: string;
  reference: string; // e.g. order/PO number
  date: string; // ISO
  actor: string;
}

export interface Supplier {
  id: string;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  categories: string[];
  unitCost: number; // indicative
  minOrderQty: number;
  leadTimeDays: number;
  paymentTerms: string;
  reliabilityScore: number; // 0-100, recalculated from PO history
  onTimeRate: number; // 0-1, recalculated from PO history
  defectRate: number; // 0-1
  notes: string;
}

export interface PurchaseOrderLine {
  productId: string;
  quantity: number;
  unitCost: number;
  receivedQty?: number;
}

export type POStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'ordered'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  lines: PurchaseOrderLine[];
  status: POStatus;
  totalCost: number;
  expectedDate: string;
  createdAt: string;
  receivedAt?: string | null;
  sentAt?: string | null;
  note?: string;
  locationId?: string | null; // deliver to; default location if empty
}

export interface SalesOrderLine {
  productId: string | null; // null when an imported item could not be matched
  sku?: string;
  name?: string;
  quantity: number;
  unitPrice: number;
}

export type SalesSource = 'manual' | 'pos' | 'shopee' | 'lazada' | 'tiktok_shop' | 'website';

export interface Shipment {
  courier: string;
  serviceId?: string;
  trackingNo?: string;
  orderNo?: string; // courier-side booking reference
  status: 'quoted' | 'booked' | 'paid' | 'in_transit' | 'delivered' | 'failed';
  cost?: number;
  labelUrl?: string;
  bookedAt?: string;
  lastCheckedAt?: string;
  lastEvent?: string;
}

export interface SalesOrder {
  id: string;
  orderNumber: string;
  channel: 'online' | 'retail';
  source: SalesSource;
  externalId: string | null; // order id on the marketplace
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  shippingPostcode: string;
  lines: SalesOrderLine[];
  total: number;
  status: 'awaiting_fulfilment' | 'fulfilled' | 'cancelled';
  paymentStatus: 'paid' | 'pending' | 'refunded';
  paymentMethod: string;
  date: string; // ISO
  shipment: Shipment | null;
  invoiceId: string | null;
  locationId?: string | null; // shop or warehouse the goods leave from; default location if empty
  pickStatus?: 'picking' | 'picked' | 'packed' | null; // warehouse progress before handover
  pickedAt?: string | null;
  packedAt?: string | null;
  packedBy?: string;
}

export interface Expense {
  id: string;
  category: string;
  description: string;
  amount: number;
  date: string;
  recurring: boolean;
  dueDate?: string | null; // for unpaid bills
  paid: boolean;
  receiptUrl?: string; // storage path of the receipt photo/PDF (private bucket "receipts")
  locationId?: string | null; // branch the cost belongs to (for branch comparison)
}

/** Work for a person (blueprint §5 A3 warehouse tasks): pick, pack, put away, count, receive. */
export interface StaffTask {
  id: string;
  taskNumber: string;
  title: string;
  detail: string;
  kind: 'pick' | 'pack' | 'put_away' | 'count' | 'receive' | 'deliver' | 'other';
  assignee: string; // team member email, '' = anyone
  locationId: string;
  ref: string; // related document numbers, e.g. "SO-00012, SO-00013"
  dueDate: string | null;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  createdAt: string;
  completedAt: string | null;
  createdBy: string;
  doneBy: string;
}

/** PDPA 2010: a customer's consent to be contacted (blueprint §17). */
export interface Consent {
  id: string;
  customerKey: string; // lowercased email, else phone digits
  customerName: string;
  email: string;
  phone: string;
  purpose: 'marketing' | 'service';
  channel: 'email' | 'whatsapp' | 'sms' | 'any';
  status: 'granted' | 'withdrawn';
  source: string; // how it was collected: counter, website form, WhatsApp, verbal…
  note: string;
  at: string;
  recordedBy: string;
}

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled';

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate?: number; // %
  classificationCode?: string; // MyInvois classification, default '022' (Others)
  productId?: string | null;
}

export interface EInvoiceState {
  status: 'not_submitted' | 'submitted' | 'valid' | 'invalid' | 'cancelled' | 'error';
  submissionUid?: string;
  uuid?: string;
  longId?: string;
  validationUrl?: string;
  submittedAt?: string;
  validatedAt?: string;
  error?: string;
  environment?: 'sandbox' | 'prod';
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  type: 'invoice' | 'credit_note' | 'consolidated';
  customerName: string;
  customerEmail: string;
  customerTin: string; // 'EI00000000010' for general public / consolidated
  customerBrn: string;
  customerPhone: string;
  customerAddress: string;
  lines: InvoiceLine[];
  subtotal: number;
  taxTotal: number;
  total: number;
  status: InvoiceStatus;
  issuedDate: string;
  dueDate: string;
  paidDate?: string | null;
  orderId: string | null;
  einvoice: EInvoiceState;
  /** Payment reminders sent (blueprint D5). Only set once a reminder has gone out. */
  remindersSent?: number;
  lastReminderAt?: string | null;
  /** Repeat this invoice (blueprint D5 recurring invoices). Only on the original. */
  recurrence?: InvoiceRecurrence | null;
  /** Copies made by a recurring invoice point back to the original. */
  recurringFrom?: string | null;
  /** Invoice created from an accepted quotation. */
  quotationId?: string | null;
}

export interface InvoiceRecurrence {
  every: 'week' | 'month' | 'quarter' | 'year';
  nextDate: string; // YYYY-MM-DD the next copy is due
  active: boolean;
}

export interface Quotation {
  id: string;
  quoteNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  customerTin: string;
  customerBrn: string;
  lines: InvoiceLine[];
  subtotal: number;
  taxTotal: number;
  total: number;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';
  issuedDate: string;
  validUntil: string; // ISO
  paymentDays: number; // payment terms carried to the invoice
  note: string;
  invoiceId: string | null;
  createdBy: string;
}

export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface Review {
  id: string;
  source: string; // Shopee, Lazada, Google, TikTok Shop, manual...
  externalId: string | null;
  productId: string | null;
  customerName: string;
  rating: number; // 1-5
  text: string;
  sentiment: Sentiment;
  topic: string; // quality, price, delivery, packaging, service, value, other
  status: 'new' | 'responded' | 'escalated';
  date: string;
  draftResponse?: string;
  postedResponse?: string;
}

export interface SupportTicket {
  id: string;
  subject: string;
  customerName: string;
  customerEmail: string;
  body: string;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'in_progress' | 'resolved';
  createdAt: string;
  resolvedAt?: string | null;
  notes: string;
}

export type ContentStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'failed';

export interface ContentItem {
  id: string;
  title: string;
  platform: 'Facebook' | 'Instagram' | 'TikTok' | 'YouTube' | 'LinkedIn';
  type: 'post' | 'carousel' | 'video_script' | 'ad';
  body: string;
  imageUrl: string;
  status: ContentStatus;
  scheduledDate: string;
  campaignId?: string | null;
  externalPostId?: string | null;
  publishedAt?: string | null;
  error?: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  objective: 'awareness' | 'traffic' | 'leads' | 'conversions' | 'sales';
  platform: string;
  budget: number;
  dailyCap: number;
  spend: number;
  clicks: number;
  impressions: number;
  conversions: number;
  revenue: number;
  status: 'draft' | 'active' | 'paused' | 'ended';
  startDate?: string | null;
  endDate?: string | null;
  externalId?: string | null;
}

export type ApprovalType =
  | 'purchase_order'
  | 'price_change'
  | 'marketing_publish'
  | 'review_response'
  | 'invoice_issue'
  | 'einvoice_submit'
  | 'shipment_booking'
  | 'stock_adjustment'
  | 'customer_message'
  | 'refund'
  | 'stock_count'
  | 'production_order'
  | 'payment_reminder'
  | 'quotation_send'
  | 'campaign_launch'
  | 'data_erasure';

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  title: string;
  description: string; // human-readable preview of the change
  payload: Record<string, unknown>; // machine payload used on approval
  amount?: number | null; // financial exposure if any
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected';
  executionStatus?: 'not_started' | 'running' | 'succeeded' | 'failed' | null;
  executionResult?: string | null;
  requestedBy: string;
  createdAt: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
}

export type ReturnReason = 'damaged' | 'defective' | 'wrong_item' | 'not_as_described' | 'changed_mind' | 'expired' | 'other';
export type ReturnCondition = 'unopened' | 'opened' | 'damaged' | 'defective';
export type ReturnResolution = 'restock' | 'quarantine' | 'dispose' | 'supplier_return';

/** Blueprint A6: a customer return and what happened to the goods and the money. */
export interface ReturnCase {
  id: string;
  returnNumber: string;
  orderId: string | null;
  productId: string | null;
  customerName: string;
  quantity: number;
  reason: ReturnReason;
  condition: ReturnCondition;
  notes: string;
  photoUrl: string;
  status: 'open' | 'resolved' | 'rejected';
  resolution: ReturnResolution | null; // what happened to the goods
  refundAmount: number; // 0 = no refund
  refundStatus: 'none' | 'pending_approval' | 'refunded';
  createdAt: string;
  resolvedAt?: string | null;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
  at: string;
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  at: string;
  read: boolean;
}

/** One step the WorkBuddy agent reported while working on a task. */
export interface AgentEvent {
  at: string;
  kind: 'status' | 'message' | 'thought' | 'plan' | 'tool_call' | 'tool_result' | 'error' | 'artifact';
  text: string;
  data?: unknown;
}

export interface AgentTask {
  id: string;
  /** Chat this message belongs to (the id of the chat's first message). */
  conversationId?: string | null;
  prompt: string;
  mode: 'cloud' | 'local';
  status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'failed' | 'cancelled';
  workbuddyTaskId: string | null;
  workbuddyLink: string | null;
  events: AgentEvent[];
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BizPilotDB {
  settings: BusinessSettings;
  products: Product[];
  stockMovements: StockMovement[];
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  salesOrders: SalesOrder[];
  expenses: Expense[];
  invoices: Invoice[];
  reviews: Review[];
  tickets: SupportTicket[];
  contentItems: ContentItem[];
  campaigns: Campaign[];
  returns: ReturnCase[];
  locations: Location[];
  transfers: StockTransfer[];
  stockCounts: StockCount[];
  productionOrders: ProductionOrder[];
  quotations: Quotation[];
  staffTasks: StaffTask[];
  consents: Consent[];
  approvals: ApprovalRequest[];
  auditLog: AuditLogEntry[];
  notifications: AppNotification[];
  agentTasks: AgentTask[];
}
