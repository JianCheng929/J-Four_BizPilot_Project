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
    stock: 0, reserved: 0, incoming: 0, reorderLevel: 0, avgDailySales: 0, status: 'active', channelSkus: {},
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
  campaigns: { dailyCap: 0, spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0 },
  agentTasks: { events: [], result: null, workbuddyTaskId: null, workbuddyLink: null },
};

// Numeric columns arrive as numbers from PostgREST, but guard against strings.
const NUMERIC_KEYS = new Set([
  'unitCost', 'price', 'weightKg', 'stock', 'reserved', 'incoming', 'reorderLevel', 'avgDailySales',
  'quantity', 'minOrderQty', 'leadTimeDays', 'reliabilityScore', 'onTimeRate', 'defectRate', 'totalCost',
  'total', 'amount', 'subtotal', 'taxTotal', 'rating', 'budget', 'dailyCap', 'spend', 'clicks',
  'impressions', 'conversions', 'revenue',
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
