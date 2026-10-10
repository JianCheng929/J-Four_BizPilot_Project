import * as ops from '../../../src/lib/ops.ts';
import type { SalesSource } from '../../../src/lib/db/types.ts';
import type { ExternalOrder, ExternalReview } from '../providers/types.ts';
import { getProvider } from '../providers/index.ts';
import { HttpError } from './http.ts';
import { getIntegrationRow, isConfigured, providerContext, upsertIntegration } from './integrations.ts';
import { withBusiness } from './workspace.ts';

const LABEL: Record<string, string> = { shopee: 'Shopee', lazada: 'Lazada', tiktok_shop: 'TikTok Shop', website: 'Own website' };
const PREFIX: Record<string, string> = { shopee: 'SP', lazada: 'LZ', tiktok_shop: 'TT', website: 'WEB' };

export interface SyncResult {
  orders: { imported: number; updated: number; unmatchedItems: number };
  reviews?: { imported: number };
  message: string;
}

/**
 * Pull new/updated marketplace orders and reviews into BizPilot. Items are
 * matched to products by SKU, barcode or the product's channel SKU; unmatched
 * items are kept on the order (without stock movement) and reported.
 */
export async function syncMarketplace(businessId: string, providerId: string, actor: string): Promise<SyncResult> {
  const provider = getProvider(providerId);
  if (!provider?.fetchOrders) throw new HttpError(400, `${providerId} is not a marketplace integration.`);
  const pctx = await providerContext(businessId, provider);
  if (!isConfigured(provider, pctx) || !pctx.tokens.access_token) {
    throw new HttpError(400, `Connect ${provider.label} in Settings → Integrations first.`);
  }
  const row = await getIntegrationRow(businessId, provider.id);
  const startedAt = new Date();
  // Overlap a day so late status changes are caught; first sync looks back 30 days.
  const since = row?.last_sync_at ? new Date(new Date(row.last_sync_at).getTime() - 86_400_000) : new Date(Date.now() - 30 * 86_400_000);

  try {
    const orders = await provider.fetchOrders(pctx, since);
    const reviews = provider.fetchReviews ? await provider.fetchReviews(pctx, since) : null;
    const result = await importOrders(businessId, providerId, orders, reviews, actor);

    await upsertIntegration(businessId, provider.id, { last_sync_at: startedAt.toISOString(), status: 'connected', error: null });
    return {
      orders: { imported: result.imported, updated: result.updated, unmatchedItems: result.unmatchedItems },
      ...(reviews ? { reviews: { imported: result.reviewsImported } } : {}),
      message: `${LABEL[providerId]}: ${result.imported} new orders, ${result.updated} updated${reviews ? `, ${result.reviewsImported} new reviews` : ''}.`,
    };
  } catch (e) {
    await upsertIntegration(businessId, provider.id, { status: 'error', error: (e as Error).message }).catch(() => undefined);
    throw e;
  }
}

/**
 * Brings outside orders into BizPilot once each (matched by source + external id); later
 * calls only apply cancellations, shipping and payment changes. Used by marketplace sync
 * and by the agent when it reads the owner's own website.
 */
export function importOrders(
  businessId: string, providerId: string, orders: ExternalOrder[], reviews: ExternalReview[] | null, actor: string,
  /** Past orders whose stock the source already took off (its stock numbers are copied as they are): shipped ones are booked without moving stock again. */
  stockAlreadyCounted = false,
) {
    const source = providerId as SalesSource;
    return withBusiness(businessId, (db) => {
      let imported = 0, updated = 0, unmatchedItems = 0, reviewsImported = 0;
      const tryFulfil = (id: string) => {
        try { ops.fulfilSalesOrder(db, id, actor); } catch (e) {
          ops.notify(db, `${LABEL[providerId]} order shipped but stock is short`, (e as Error).message, 'warning');
        }
      };
      for (const o of orders) {
        const existing = db.salesOrders.find((x) => x.source === source && x.externalId === o.externalId);
        if (!existing) {
          if (o.cancelled) continue;
          const lines = o.items.map((it) => {
            const p = (it.sku && ops.findProduct(db, it.sku)) || ops.findProduct(db, it.name);
            if (!p) unmatchedItems++;
            return { productId: p?.id ?? null, sku: it.sku, name: it.name, quantity: it.quantity, unitPrice: it.unitPrice };
          });
          if (!lines.length) continue;
          const so = ops.createSalesOrder(db, {
            channel: 'online',
            source,
            externalId: o.externalId,
            orderNumber: `${PREFIX[providerId] ?? 'EXT'}-${o.orderNumber}`,
            customerName: o.customerName,
            customerPhone: o.customerPhone,
            shippingAddress: o.shippingAddress,
            shippingPostcode: o.shippingPostcode,
            lines,
            paymentStatus: o.paymentStatus,
            paymentMethod: o.paymentMethod,
            date: o.date,
          }, actor);
          // Keep the marketplace total (it includes shipping/vouchers)
          if (o.total > 0) so.total = Math.round(o.total * 100) / 100;
          if (o.shipped && stockAlreadyCounted) {
            for (const l of so.lines) {
              const p = l.productId ? db.products.find((x) => x.id === l.productId) : undefined;
              if (p) p.reserved = Math.max(0, p.reserved - l.quantity);
            }
            so.status = 'fulfilled';
          } else if (o.shipped) tryFulfil(so.id);
          imported++;
        } else {
          let changed = false;
          if (o.cancelled && existing.status !== 'cancelled') {
            ops.cancelSalesOrder(db, existing.id, actor, o.paymentStatus === 'refunded');
            changed = true;
          } else if (o.shipped && existing.status === 'awaiting_fulfilment') {
            tryFulfil(existing.id);
            changed = true;
          }
          if (existing.paymentStatus !== o.paymentStatus && existing.status !== 'cancelled') {
            // Paid on the marketplace: the order and its invoice are settled together.
            if (o.paymentStatus === 'paid') ops.recordOrderPayment(db, existing.id, actor);
            else existing.paymentStatus = o.paymentStatus;
            changed = true;
          }
          if (changed) updated++;
        }
      }
      for (const r of reviews ?? []) {
        const p = r.sku ? ops.findProduct(db, r.sku) : undefined;
        const added = ops.addReview(db, {
          source: LABEL[providerId], externalId: r.externalId, productId: p?.id ?? null,
          customerName: r.customerName, rating: r.rating, text: r.text, date: r.date,
        }, actor);
        if (added) reviewsImported++;
      }
      if (unmatchedItems) {
        ops.notify(db, `${unmatchedItems} ${LABEL[providerId]} item(s) not matched`, 'Add the marketplace SKU to the product (Inventory → Edit → Channel SKUs) so stock is deducted.', 'warning');
      }
      ops.audit(db, actor, 'sync', 'integration', providerId, `Imported ${imported}, updated ${updated} orders; ${reviewsImported} reviews`);
      return { imported, updated, unmatchedItems, reviewsImported };
    });
}
