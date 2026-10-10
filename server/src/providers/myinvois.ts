import { createHash } from 'node:crypto';
import type { BusinessSettings, Invoice } from '../../../src/lib/db/types.ts';
import type { Provider, ProviderContext } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * LHDN MyInvois (Malaysia e-invoicing) — https://sdk.myinvois.hasil.gov.my
 * Builds a UBL 2.1 JSON document (version 1.0, no digital signature needed),
 * submits it, polls validation, validates buyer TINs and cancels documents.
 */

const HOSTS = {
  sandbox: { api: 'https://preprod-api.myinvois.hasil.gov.my', portal: 'https://preprod.myinvois.hasil.gov.my' },
  prod: { api: 'https://api.myinvois.hasil.gov.my', portal: 'https://myinvois.hasil.gov.my' },
};

export const GENERAL_PUBLIC_TIN = 'EI00000000010';

export function envOf(ctx: ProviderContext): 'sandbox' | 'prod' {
  return (ctx.creds.ENV || process.env.MYINVOIS_ENV) === 'prod' ? 'prod' : 'sandbox';
}

async function accessToken(ctx: ProviderContext): Promise<string> {
  const env = envOf(ctx);
  const t = ctx.tokens;
  if (t.access_token && t.env === env && Number(t.expires_at) > Date.now() + 60_000) return t.access_token;
  if (!ctx.creds.CLIENT_ID || !ctx.creds.CLIENT_SECRET) {
    throw new ProviderError('MyInvois is not connected. Add your Client ID and Client Secret in Settings → Integrations.');
  }
  const res = await fetch(`${HOSTS[env].api}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...onBehalf(ctx) },
    body: new URLSearchParams({
      client_id: ctx.creds.CLIENT_ID,
      client_secret: ctx.creds.CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'InvoicingAPI',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data.access_token) {
    throw new ProviderError(`MyInvois login failed (${res.status}): ${data.error_description || data.error || 'check Client ID/Secret and environment'}`);
  }
  await ctx.saveTokens({ access_token: data.access_token, env, expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

function onBehalf(ctx: ProviderContext): Record<string, string> {
  return ctx.creds.ON_BEHALF_OF_TIN ? { onbehalfof: ctx.creds.ON_BEHALF_OF_TIN } : {};
}

async function apiCall(ctx: ProviderContext, method: string, path: string, body?: unknown) {
  const token = await accessToken(ctx);
  const res = await fetch(`${HOSTS[envOf(ctx)].api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...onBehalf(ctx),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

function errText(data: any): string {
  const e = data?.error ?? data;
  const details = Array.isArray(e?.details) ? e.details.map((d: any) => d.message ?? d.code).filter(Boolean).join('; ') : '';
  return [e?.message ?? e?.error ?? (typeof e === 'string' ? e : ''), details].filter(Boolean).join(' — ') || 'request failed';
}

// ---------- UBL JSON builder ----------

const v = (value: string | number, attrs: Record<string, string> = {}) => [{ _: value, ...attrs }];
const amt = (n: number) => [{ _: Math.round(n * 100) / 100, currencyID: 'MYR' }];

function address(line: string, city: string, postcode: string, state: string) {
  return [{
    CityName: v(city || 'NA'),
    PostalZone: v(postcode || ''),
    CountrySubentityCode: v(state || '17'), // 17 = Not applicable
    AddressLine: [{ Line: v(line || 'NA') }],
    Country: [{ IdentificationCode: v('MYS', { listID: 'ISO3166-1', listAgencyID: '6' }) }],
  }];
}

/** Which settings are missing before an e-invoice can be submitted. */
export function missingSupplierFields(s: BusinessSettings): string[] {
  const need: [keyof BusinessSettings, string][] = [
    ['legalName', 'Registered business name'], ['tin', 'TIN'], ['brn', 'SSM registration no.'],
    ['msicCode', 'MSIC code'], ['msicDescription', 'MSIC description'], ['phone', 'Phone'],
    ['email', 'Email'], ['addressLine', 'Address'], ['city', 'City'], ['postcode', 'Postcode'],
  ];
  return need.filter(([k]) => !String(s[k] ?? '').trim()).map(([, label]) => label);
}

export function buildUblInvoice(inv: Invoice, s: BusinessSettings) {
  if (inv.type === 'credit_note') {
    throw new ProviderError('Credit notes must reference the original e-invoice; submit them from the MyInvois portal for now.');
  }
  const issued = new Date();
  const consolidated = inv.type === 'consolidated';
  const buyerTin = consolidated ? GENERAL_PUBLIC_TIN : inv.customerTin || GENERAL_PUBLIC_TIN;
  const generalPublic = buyerTin === GENERAL_PUBLIC_TIN;

  const lines = inv.lines.map((l, i) => {
    const net = l.quantity * l.unitPrice;
    const rate = l.taxRate ?? 0;
    const tax = Math.round(net * rate) / 100;
    return {
      ID: v(String(i + 1)),
      InvoicedQuantity: v(l.quantity, { unitCode: 'C62' }),
      LineExtensionAmount: amt(net),
      TaxTotal: [{
        TaxAmount: amt(tax),
        TaxSubtotal: [{
          TaxableAmount: amt(net),
          TaxAmount: amt(tax),
          Percent: v(rate),
          TaxCategory: [{
            ID: v(rate > 0 ? '01' : '06'), // 01 Sales Tax, 06 Not applicable
            TaxScheme: [{ ID: v('OTH', { schemeID: 'UN/ECE 5153', schemeAgencyID: '6' }) }],
          }],
        }],
      }],
      Item: [{
        CommodityClassification: [{ ItemClassificationCode: v(consolidated ? '004' : l.classificationCode || '022', { listID: 'CLASS' }) }],
        Description: v(l.description || 'Item'),
      }],
      Price: [{ PriceAmount: amt(l.unitPrice) }],
      ItemPriceExtension: [{ Amount: amt(net) }],
    };
  });

  const subtotal = inv.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
  const taxTotal = inv.lines.reduce((a, l) => a + Math.round(l.quantity * l.unitPrice * (l.taxRate ?? 0)) / 100, 0);
  const anyTax = taxTotal > 0;

  return {
    _D: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    _A: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    _B: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
    Invoice: [{
      ID: v(inv.invoiceNumber),
      IssueDate: v(issued.toISOString().slice(0, 10)),
      IssueTime: v(issued.toISOString().slice(11, 19) + 'Z'),
      InvoiceTypeCode: v('01', { listVersionID: '1.0' }),
      DocumentCurrencyCode: v('MYR'),
      TaxCurrencyCode: v('MYR'),
      AccountingSupplierParty: [{
        Party: [{
          IndustryClassificationCode: v(s.msicCode, { name: s.msicDescription }),
          PartyIdentification: [
            { ID: v(s.tin, { schemeID: 'TIN' }) },
            { ID: v(s.brn, { schemeID: 'BRN' }) },
            { ID: v(s.sstNo || 'NA', { schemeID: 'SST' }) },
            { ID: v('NA', { schemeID: 'TTX' }) },
          ],
          PostalAddress: address(s.addressLine, s.city, s.postcode, s.stateCode),
          PartyLegalEntity: [{ RegistrationName: v(s.legalName || s.name) }],
          Contact: [{ Telephone: v(s.phone), ElectronicMail: v(s.email) }],
        }],
      }],
      AccountingCustomerParty: [{
        Party: [{
          PartyIdentification: [
            { ID: v(buyerTin, { schemeID: 'TIN' }) },
            { ID: v(generalPublic ? 'NA' : inv.customerBrn || 'NA', { schemeID: 'BRN' }) },
            { ID: v('NA', { schemeID: 'SST' }) },
            { ID: v('NA', { schemeID: 'TTX' }) },
          ],
          PostalAddress: address(generalPublic ? 'NA' : inv.customerAddress, '', '', '17'),
          PartyLegalEntity: [{ RegistrationName: v(generalPublic ? 'General Public' : inv.customerName) }],
          Contact: [{ Telephone: v(generalPublic ? 'NA' : inv.customerPhone || 'NA'), ElectronicMail: v(inv.customerEmail || 'NA') }],
        }],
      }],
      TaxTotal: [{
        TaxAmount: amt(taxTotal),
        TaxSubtotal: [{
          TaxableAmount: amt(subtotal),
          TaxAmount: amt(taxTotal),
          TaxCategory: [{ ID: v(anyTax ? '01' : '06'), TaxScheme: [{ ID: v('OTH', { schemeID: 'UN/ECE 5153', schemeAgencyID: '6' }) }] }],
        }],
      }],
      LegalMonetaryTotal: [{
        LineExtensionAmount: amt(subtotal),
        TaxExclusiveAmount: amt(subtotal),
        TaxInclusiveAmount: amt(subtotal + taxTotal),
        PayableAmount: amt(subtotal + taxTotal),
      }],
      InvoiceLine: lines,
    }],
  };
}

// ---------- API calls ----------

export async function submitInvoice(ctx: ProviderContext, inv: Invoice, settings: BusinessSettings) {
  const missing = missingSupplierFields(settings);
  if (missing.length) throw new ProviderError(`Fill in Settings → Business profile first: ${missing.join(', ')}.`);
  const json = JSON.stringify(buildUblInvoice(inv, settings));
  const res = await apiCall(ctx, 'POST', '/api/v1.0/documentsubmissions/', {
    documents: [{
      format: 'JSON',
      documentHash: createHash('sha256').update(json, 'utf8').digest('hex'),
      codeNumber: inv.invoiceNumber,
      document: Buffer.from(json, 'utf8').toString('base64'),
    }],
  });
  if (res.status !== 202 && !res.ok) throw new ProviderError(`MyInvois rejected the submission: ${errText(res.data)}`);
  const rejected = res.data?.rejectedDocuments?.[0];
  if (rejected) throw new ProviderError(`MyInvois rejected ${inv.invoiceNumber}: ${errText(rejected)}`);
  const accepted = res.data?.acceptedDocuments?.[0];
  return {
    status: 'submitted' as const,
    submissionUid: String(res.data?.submissionUid ?? ''),
    uuid: String(accepted?.uuid ?? ''),
    submittedAt: new Date().toISOString(),
    environment: envOf(ctx),
  };
}

/** Poll validation result of a submitted document. */
export async function refreshInvoice(ctx: ProviderContext, submissionUid: string, uuid?: string) {
  const res = await apiCall(ctx, 'GET', `/api/v1.0/documentsubmissions/${encodeURIComponent(submissionUid)}?pageNo=1&pageSize=10`);
  if (!res.ok) throw new ProviderError(`MyInvois status check failed: ${errText(res.data)}`);
  const docs = (res.data?.documentSummary ?? []) as any[];
  const doc = docs.find((d) => !uuid || d.uuid === uuid) ?? docs[0];
  if (!doc) return { status: 'submitted' as const };
  const st = String(doc.status ?? '').toLowerCase();
  const status = st === 'valid' ? 'valid' : st === 'invalid' ? 'invalid' : st === 'cancelled' ? 'cancelled' : 'submitted';
  const out: Record<string, unknown> = { status, uuid: doc.uuid };
  if (doc.longId) {
    out.longId = doc.longId;
    out.validationUrl = `${HOSTS[envOf(ctx)].portal}/${doc.uuid}/share/${doc.longId}`;
  }
  if (status === 'valid') out.validatedAt = doc.dateTimeValidated ?? new Date().toISOString();
  if (status === 'invalid') {
    const detail = await apiCall(ctx, 'GET', `/api/v1.0/documents/${doc.uuid}/details`);
    const steps = (detail.data?.validationResults?.validationSteps ?? []) as any[];
    out.error = steps.filter((s) => s.status === 'Invalid').map((s) => `${s.name}: ${errText(s.error)}`).join('; ') || 'Rejected by LHDN validation.';
  }
  return out as { status: 'submitted' | 'valid' | 'invalid' | 'cancelled'; [k: string]: unknown };
}

export async function cancelDocument(ctx: ProviderContext, uuid: string, reason: string) {
  const res = await apiCall(ctx, 'PUT', `/api/v1.0/documents/state/${encodeURIComponent(uuid)}/state`, { status: 'cancelled', reason: reason.slice(0, 300) || 'Cancelled by issuer' });
  if (!res.ok) throw new ProviderError(`MyInvois cancel failed: ${errText(res.data)} (documents can only be cancelled within 72 hours of validation).`);
  return { status: 'cancelled' as const };
}

export async function validateTin(ctx: ProviderContext, tin: string, idType: string, idValue: string) {
  const res = await apiCall(ctx, 'GET', `/api/v1.0/taxpayer/validate/${encodeURIComponent(tin)}?idType=${encodeURIComponent(idType)}&idValue=${encodeURIComponent(idValue)}`);
  if (res.ok) return { valid: true, message: `${tin} is a valid taxpayer TIN.` };
  if (res.status === 404 || res.status === 400) return { valid: false, message: `LHDN could not match TIN ${tin} with ${idType} ${idValue}.` };
  throw new ProviderError(`TIN validation failed: ${errText(res.data)}`);
}

export const myinvois: Provider = {
  id: 'myinvois',
  label: 'LHDN MyInvois (e-Invoice)',
  category: 'Finance',
  description: 'Submit e-invoices to LHDN, get the validation QR link, validate buyer TINs and cancel within 72 hours.',
  docs: 'https://sdk.myinvois.hasil.gov.my/',
  fields: [
    { key: 'CLIENT_ID', label: 'Client ID', env: 'MYINVOIS_CLIENT_ID', secret: false },
    { key: 'CLIENT_SECRET', label: 'Client Secret', env: 'MYINVOIS_CLIENT_SECRET', secret: true },
    { key: 'ENV', label: 'Environment', env: 'MYINVOIS_ENV', secret: false, placeholder: 'sandbox', help: 'Optional. "sandbox" (pre-production, default) or "prod".' },
    { key: 'ON_BEHALF_OF_TIN', label: 'On behalf of TIN', env: 'MYINVOIS_ON_BEHALF_OF', secret: false, help: 'Optional. Only for intermediaries submitting for another taxpayer.' },
  ],
  async test(ctx) {
    try {
      ctx.tokens.access_token = undefined;
      await accessToken(ctx);
      return { ok: true, message: `Logged in to MyInvois ${envOf(ctx) === 'prod' ? 'production' : 'sandbox (pre-production)'}.`, account: { environment: envOf(ctx) } };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
};
