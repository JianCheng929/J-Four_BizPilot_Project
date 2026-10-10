/**
 * Contract every integration provider implements. Providers talk to the real
 * external API; nothing here returns canned data.
 */

export interface ProviderField {
  key: string;
  label: string;
  env: string; // optional server/.env fallback (single-business setups)
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderContext {
  businessId: string;
  creds: Record<string, string>;
  tokens: Record<string, any>;
  /** Persist refreshed OAuth tokens */
  saveTokens: (tokens: Record<string, any>) => Promise<void>;
  /** Public base URL of this server, used for OAuth redirects */
  serverUrl: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
  account?: Record<string, unknown>;
}

export interface ExternalOrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface ExternalOrder {
  externalId: string;
  orderNumber: string;
  date: string; // ISO
  customerName: string;
  customerPhone?: string;
  shippingAddress?: string;
  shippingPostcode?: string;
  items: ExternalOrderItem[];
  total: number;
  paymentStatus: 'paid' | 'pending' | 'refunded';
  cancelled: boolean;
  shipped: boolean;
  paymentMethod?: string;
}

export interface ExternalReview {
  externalId: string;
  customerName: string;
  rating: number;
  text: string;
  date: string;
  sku?: string;
}

export interface Provider {
  id: string;
  label: string;
  category: string;
  description: string;
  docs: string;
  fields: ProviderField[];
  /** OAuth providers send the user to the platform to authorise BizPilot */
  oauth?: {
    authorizeUrl: (ctx: ProviderContext, redirectUri: string, state: string) => string;
    /** Exchange the callback query for tokens; returns tokens to store + account info */
    exchange: (ctx: ProviderContext, query: Record<string, string>, redirectUri: string) => Promise<{ tokens: Record<string, any>; account?: Record<string, unknown> }>;
  };
  test: (ctx: ProviderContext) => Promise<TestResult>;
  /** Marketplaces: orders created/updated since `since` */
  fetchOrders?: (ctx: ProviderContext, since: Date) => Promise<ExternalOrder[]>;
  /** Marketplaces: buyer reviews since `since` */
  fetchReviews?: (ctx: ProviderContext, since: Date) => Promise<ExternalReview[]>;
}

export class ProviderError extends Error {}
