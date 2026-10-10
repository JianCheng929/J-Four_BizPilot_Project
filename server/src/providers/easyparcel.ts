import type { Provider, ProviderContext } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * EasyParcel Malaysia (https://developers.easyparcel.com) — multi-courier rate
 * check, booking, payment (label) and tracking. Uses the account wallet.
 */

function base(ctx: ProviderContext) {
  return ctx.creds.ENV === 'demo' ? 'http://demo.connect.easyparcel.my' : 'https://connect.easyparcel.my';
}

async function call(ctx: ProviderContext, action: string, params: Record<string, string | number>) {
  if (!ctx.creds.API_KEY) throw new ProviderError('EasyParcel is not connected. Add your API key in Settings → Integrations.');
  const body = new URLSearchParams({ api: ctx.creds.API_KEY });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  const res = await fetch(`${base(ctx)}/?ac=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new ProviderError(`EasyParcel ${action} returned HTTP ${res.status}.`);
  const data = (await res.json()) as any;
  if (data.api_status !== 'Success') {
    throw new ProviderError(`EasyParcel ${action}: ${data.error_remark || data.error_code || 'request failed'}`);
  }
  return data;
}

/**
 * EasyParcel needs the state code with each postcode. Malaysian postcode
 * ranges map cleanly to states (Pos Malaysia allocation).
 */
export function stateFromPostcode(postcode: string): string {
  const n = Number(String(postcode).trim().slice(0, 5));
  if (!Number.isFinite(n) || n < 1000) return '';
  const r = (a: number, b: number) => n >= a && n <= b;
  if (r(1000, 2999)) return 'pls';
  if (r(5000, 9999)) return 'kdh';
  if (r(10000, 14999)) return 'png';
  if (r(15000, 18999)) return 'ktn';
  if (r(20000, 24999)) return 'trg';
  if (r(25000, 28999) || r(39000, 39999) || r(49000, 49999) || r(69000, 69999)) return 'phg';
  if (r(30000, 36999)) return 'prk';
  if (r(50000, 60999)) return 'kul';
  if (r(62000, 62999)) return 'pjy';
  if (r(40000, 48999) || r(63000, 68999)) return 'sgr';
  if (r(70000, 73999)) return 'nsn';
  if (r(75000, 78999)) return 'mlk';
  if (r(79000, 86999)) return 'jhr';
  if (r(87000, 87999)) return 'lbn';
  if (r(88000, 91999)) return 'sbh';
  if (r(93000, 98999)) return 'srw';
  return '';
}

export interface Rate {
  serviceId: string;
  courier: string;
  service: string;
  price: number;
  etaDays: string;
}

export async function quoteRates(ctx: ProviderContext, fromPostcode: string, toPostcode: string, weightKg: number): Promise<Rate[]> {
  const pickState = stateFromPostcode(fromPostcode);
  const sendState = stateFromPostcode(toPostcode);
  if (!pickState) throw new ProviderError('Set a valid ship-from postcode in Settings → Business profile.');
  if (!sendState) throw new ProviderError(`"${toPostcode}" is not a valid Malaysian postcode.`);
  const data = await call(ctx, 'EPRateCheckingBulk', {
    'bulk[0][pick_code]': fromPostcode,
    'bulk[0][pick_state]': pickState,
    'bulk[0][pick_country]': 'MY',
    'bulk[0][send_code]': toPostcode,
    'bulk[0][send_state]': sendState,
    'bulk[0][send_country]': 'MY',
    'bulk[0][weight]': Math.max(0.1, weightKg).toFixed(2),
  });
  const rates = (data.result?.[0]?.rates ?? []) as any[];
  return rates
    .map((r) => ({
      serviceId: String(r.service_id),
      courier: String(r.courier_name ?? ''),
      service: String(r.service_name ?? ''),
      price: Number(r.price ?? r.shipment_price ?? 0),
      etaDays: String(r.delivery ?? ''),
    }))
    .sort((a, b) => a.price - b.price);
}

export interface BookingInput {
  serviceId: string;
  weightKg: number;
  content: string;
  value: number;
  sender: { name: string; phone: string; email: string; address: string; city: string; postcode: string };
  receiver: { name: string; phone: string; email: string; address: string; postcode: string };
}

/** Submit + pay in one go: returns tracking number and label link. */
export async function bookShipment(ctx: ProviderContext, b: BookingInput) {
  const today = new Date().toISOString().slice(0, 10);
  const submit = await call(ctx, 'EPSubmitOrderBulk', {
    'bulk[0][weight]': Math.max(0.1, b.weightKg).toFixed(2),
    'bulk[0][content]': b.content.slice(0, 35) || 'Goods',
    'bulk[0][value]': b.value.toFixed(2),
    'bulk[0][service_id]': b.serviceId,
    'bulk[0][pick_name]': b.sender.name,
    'bulk[0][pick_contact]': b.sender.phone,
    'bulk[0][pick_mobile]': b.sender.phone,
    'bulk[0][pick_addr1]': b.sender.address,
    'bulk[0][pick_city]': b.sender.city,
    'bulk[0][pick_code]': b.sender.postcode,
    'bulk[0][pick_state]': stateFromPostcode(b.sender.postcode),
    'bulk[0][pick_country]': 'MY',
    'bulk[0][send_name]': b.receiver.name,
    'bulk[0][send_contact]': b.receiver.phone,
    'bulk[0][send_mobile]': b.receiver.phone,
    'bulk[0][send_addr1]': b.receiver.address,
    'bulk[0][send_city]': '',
    'bulk[0][send_code]': b.receiver.postcode,
    'bulk[0][send_state]': stateFromPostcode(b.receiver.postcode),
    'bulk[0][send_country]': 'MY',
    'bulk[0][send_email]': b.receiver.email,
    'bulk[0][collect_date]': today,
    'bulk[0][sms]': 0,
  });
  const order = submit.result?.[0];
  if (!order || order.status !== 'Success') {
    throw new ProviderError(`EasyParcel booking failed: ${order?.remarks ?? order?.status ?? 'unknown error'}`);
  }
  const orderNo = String(order.order_number);
  const pay = await call(ctx, 'EPPayOrderBulk', { 'bulk[0][order_no]': orderNo });
  const paid = pay.result?.[0];
  const parcel = paid?.parcel?.[0] ?? {};
  if (paid?.messagenow && !parcel.awb) {
    throw new ProviderError(`EasyParcel payment: ${paid.messagenow} (order ${orderNo} was created but not paid — top up your wallet).`);
  }
  return {
    orderNo,
    trackingNo: String(parcel.awb ?? ''),
    labelUrl: String(parcel.awb_id_link ?? ''),
    cost: Number(order.price ?? 0),
  };
}

export async function trackShipment(ctx: ProviderContext, orderNo: string) {
  const data = await call(ctx, 'EPParcelStatusBulk', { 'bulk[0][order_no]': orderNo });
  const parcel = data.result?.[0]?.parcel?.[0] ?? data.result?.[0] ?? {};
  const status = String(parcel.ship_status ?? parcel.latest_status ?? parcel.status ?? 'unknown');
  return { status, lastEvent: String(parcel.latest_status ?? parcel.ship_status ?? status) };
}

export const easyparcel: Provider = {
  id: 'easyparcel',
  label: 'EasyParcel (multi-courier)',
  category: 'Logistics',
  description: 'Compare courier rates, book shipments, print labels and track parcels (J&T, Pos Laju, Ninja Van, DHL, Skynet…).',
  docs: 'https://developers.easyparcel.com/',
  fields: [
    { key: 'API_KEY', label: 'API key', env: 'EASYPARCEL_API_KEY', secret: true },
    { key: 'ENV', label: 'Environment', env: 'EASYPARCEL_ENV', secret: false, placeholder: 'live', help: 'Optional. Type "demo" to use the EasyParcel demo server.' },
  ],
  async test(ctx) {
    if (!ctx.creds.API_KEY) return { ok: false, message: 'Add your EasyParcel API key.' };
    try {
      const data = await call(ctx, 'EPCheckCreditBalance', {});
      return { ok: true, message: `Connected to EasyParcel. Wallet balance RM${Number(data.result ?? 0).toFixed(2)}.`, account: { balance: data.result } };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
};
