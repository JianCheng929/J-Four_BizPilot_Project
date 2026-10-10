import type { BizPilotDB } from '../../../src/lib/db/types.ts';
import { loadSnapshot, persistDiff, type BusinessRow } from '../../../src/lib/db/remote.ts';
import { supabaseAdmin } from './supabase.ts';

/**
 * Server-side unit of work: load the business's current records, apply a
 * change with the shared deterministic operations, and save the difference.
 * Changes for the same business run one at a time so two agents or webhooks
 * can't overwrite each other's stock updates.
 */

const locks = new Map<string, Promise<unknown>>();
const businessCache = new Map<string, BusinessRow>();

export async function getBusiness(businessId: string): Promise<BusinessRow> {
  const { data, error } = await supabaseAdmin().from('businesses').select('*').eq('id', businessId).single();
  if (error) throw new Error(error.message);
  businessCache.set(businessId, data as BusinessRow);
  return data as BusinessRow;
}

export async function readSnapshot(businessId: string): Promise<BizPilotDB> {
  return loadSnapshot(supabaseAdmin(), await getBusiness(businessId));
}

export async function withBusiness<T>(businessId: string, fn: (draft: BizPilotDB) => T | Promise<T>): Promise<T> {
  const prevLock = locks.get(businessId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prevLock.then(() => mine);
  locks.set(businessId, chained);
  await prevLock.catch(() => undefined);
  try {
    const before = await readSnapshot(businessId);
    const draft = structuredClone(before);
    const result = await fn(draft);
    await persistDiff(supabaseAdmin(), businessId, before, draft);
    return result;
  } finally {
    release();
    if (locks.get(businessId) === chained) locks.delete(businessId);
  }
}
