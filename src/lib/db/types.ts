// BizPilot core data entities (aligned with Project Blueprint §16).
// Shared by the web app (src/) and the server (server/src) so both compute
// with exactly the same shapes and business logic.

export type BusinessMode = 'online' | 'retail' | 'hybrid';

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
  incoming: number; // ordered from suppliers, not yet received
  reorderLevel: number;
  avgDailySales: number; // units/day, recalculated from real sales history
  status: 'active' | 'discontinued' | 'seasonal' | 'draft';
  // SKU / item ids on external channels, used to match imported orders
  channelSkus: Record<string, string>;
}

export interface StockMovement {
  id: string;
  productId: string;
  type: 'in' | 'out' | 'adjustment';
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
}

export interface SalesOrderLine {
  productId: string | null; // null when an imported item could not be matched
  sku?: string;
  name?: string;
  quantity: number;
  unitPrice: number;
}

export type SalesSource = 'manual' | 'pos' | 'shopee' | 'lazada' | 'tiktok_shop';

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
  | 'customer_message';

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  title: string;
  description: string; // human-readable preview of the change
  payload: Record<string, unknown>; // machine payload used on approval
  amount?: number | null; // financial exposure if any
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected';
  executionStatus?: 'not_started' | 'succeeded' | 'failed' | null;
  executionResult?: string | null;
  requestedBy: string;
  createdAt: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
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
  approvals: ApprovalRequest[];
  auditLog: AuditLogEntry[];
  notifications: AppNotification[];
  agentTasks: AgentTask[];
}
