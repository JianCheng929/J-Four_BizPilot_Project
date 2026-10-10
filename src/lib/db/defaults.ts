import type { BizPilotDB, BusinessSettings } from './types';
import type { CollectionKey } from './remote';

/** Starting point for a new business workspace. No sample records. */
export const defaultSettings: BusinessSettings = {
  name: '',
  mode: 'hybrid',
  country: 'Malaysia',
  currency: 'RM',
  timezone: 'Asia/Kuala_Lumpur',
  language: 'English',
  lowStockThresholdDays: 7,
  approvalLimitAmount: 500,
  automationLevel: 2,
  autopilot: true,
  autopilotHour: 8,
  openingCash: 0,
  openingCashDate: '',
  brandVoice: '',
  targetAudience: '',
  prohibitedClaims: '',
  brandDifferentiators: '',
  brandStyle: '',
  brandLanguages: 'English, Malay',
  brandCompetitors: '',
  legalName: '',
  tin: '',
  brn: '',
  sstNo: 'NA',
  msicCode: '',
  msicDescription: '',
  email: '',
  phone: '',
  addressLine: '',
  city: '',
  postcode: '',
  stateCode: '14',
  shipFromPostcode: '',
  defaultTaxRate: 0,
  invoicePrefix: 'INV',
  targetMarginPct: 30,
};

export function emptyDB(): BizPilotDB {
  return {
    settings: { ...defaultSettings },
    products: [],
    stockMovements: [],
    suppliers: [],
    purchaseOrders: [],
    salesOrders: [],
    expenses: [],
    invoices: [],
    reviews: [],
    tickets: [],
    contentItems: [],
    campaigns: [],
    returns: [],
    locations: [],
    transfers: [],
    stockCounts: [],
    productionOrders: [],
    quotations: [],
    staffTasks: [],
    consents: [],
    approvals: [],
    auditLog: [],
    notifications: [],
    agentTasks: [],
  };
}

export function newId(): string {
  return crypto.randomUUID();
}

// Defaults applied when a row comes back from the database with nulls.
const RECORD_DEFAULTS: Partial<Record<CollectionKey, Record<string, unknown>>> = {
  products: {
    category: '', description: '', barcode: '', supplierId: null, unitCost: 0, price: 0, weightKg: 0.5,
    stock: 0, reserved: 0, unavailable: 0, incoming: 0, reorderLevel: 0, safetyStock: 0, maxStock: 0, orderMultiple: 1,
    expiryDate: '', avgDailySales: 0, status: 'active', channelSkus: {},
  },
  suppliers: {
    contactPerson: '', email: '', phone: '', categories: [], unitCost: 0, minOrderQty: 0, leadTimeDays: 7,
    paymentTerms: '', reliabilityScore: 0, onTimeRate: 0, defectRate: 0, notes: '',
  },
  purchaseOrders: { lines: [], note: '' },
  salesOrders: {
    source: 'manual', externalId: null, customerName: '', customerEmail: '', customerPhone: '',
    shippingAddress: '', shippingPostcode: '', lines: [], paymentMethod: '', shipment: null, invoiceId: null,
  },
  expenses: { description: '', recurring: false, paid: true, dueDate: null },
  invoices: {
    type: 'invoice', customerEmail: '', customerTin: '', customerBrn: '', customerPhone: '', customerAddress: '',
    lines: [], subtotal: 0, taxTotal: 0, total: 0, orderId: null, einvoice: { status: 'not_submitted' },
  },
  reviews: { externalId: null, productId: null, customerName: '', text: '', sentiment: 'neutral', topic: 'other' },
  tickets: { customerName: '', customerEmail: '', body: '', notes: '' },
  contentItems: { body: '', imageUrl: '', campaignId: null },
  returns: {
    orderId: null, productId: null, customerName: '', notes: '', photoUrl: '', resolution: null, refundAmount: 0,
    refundStatus: 'none', resolvedAt: null,
  },
  locations: { type: 'store', address: '', isDefault: false, active: true },
  transfers: { lines: [], note: '', shippedAt: null, receivedAt: null, createdBy: '' },
  stockCounts: { lines: [], blind: false, note: '', submittedAt: null, decidedAt: null, createdBy: '' },
  quotations: {
    customerEmail: '', customerPhone: '', customerAddress: '', customerTin: '', customerBrn: '', lines: [], subtotal: 0,
    taxTotal: 0, total: 0, paymentDays: 30, note: '', invoiceId: null, createdBy: '',
  },
  productionOrders: {
    locationId: '', materials: [], plannedUnitCost: 0, actualUnitCost: 0, labourCost: 0, overheadCost: 0, goodQty: 0,
    rejectedQty: 0, batchNumber: '', qcNotes: '', dueDate: '', note: '', startedAt: null, completedAt: null, createdBy: '',
  },
  staffTasks: { detail: '', assignee: '', locationId: '', ref: '', dueDate: null, completedAt: null, createdBy: '', doneBy: '' },
  consents: { customerName: '', email: '', phone: '', channel: 'any', source: '', note: '', recordedBy: '' },
  campaigns: { dailyCap: 0, spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0 },
  agentTasks: { events: [], result: null, workbuddyTaskId: null, workbuddyLink: null },
};

// Numeric columns arrive as numbers from PostgREST, but guard against strings.
const NUMERIC_KEYS = new Set([
  'unitCost', 'price', 'weightKg', 'stock', 'reserved', 'incoming', 'reorderLevel', 'avgDailySales',
  'quantity', 'minOrderQty', 'leadTimeDays', 'reliabilityScore', 'onTimeRate', 'defectRate', 'totalCost',
  'total', 'amount', 'subtotal', 'taxTotal', 'rating', 'budget', 'dailyCap', 'spend', 'clicks',
  'impressions', 'conversions', 'revenue', 'unavailable', 'safetyStock', 'maxStock', 'orderMultiple', 'refundAmount',
  'overheadCost', 'labourCost', 'plannedUnitCost', 'actualUnitCost', 'goodQty', 'rejectedQty', 'paymentDays', 'remindersSent',
]);

export function normalizeRecord(collection: CollectionKey, obj: Record<string, unknown>): Record<string, unknown> {
  const defaults = RECORD_DEFAULTS[collection] ?? {};
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(obj)) {
    if (v === null && k in defaults) continue;
    out[k] = NUMERIC_KEYS.has(k) && typeof v === 'string' ? Number(v) : v;
  }
  return out;
}
