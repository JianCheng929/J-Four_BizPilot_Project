import type { BizPilotDB } from '../../../src/lib/db/types.ts';
import { commitDiff, ConflictError, loadSnapshot, type BusinessRow, type Versions } from '../../../src/lib/db/remote.ts';
import { supabaseAdmin } from './supabase.ts';

/**
 * Server-side unit of work: load the business's current records, apply a
 * change with the shared deterministic operations, and save the difference.
 * Changes for the same business run one at a time on this server, and every
 * save is one version-checked database transaction: if the web app (or anyone
 * else) saved a newer version of a touched record in the meantime, the change
 * is redone on fresh data instead of overwriting it.
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
    const business = await getBusiness(businessId);
    for (let attempt = 1; ; attempt++) {
      const versions: Versions = new Map();
      const before = await loadSnapshot(supabaseAdmin(), business, versions);
      const draft = structuredClone(before);
      const result = await fn(draft);
      try {
        await commitDiff(supabaseAdmin(), businessId, before, draft, versions);
        return result;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 4) throw e;
      }
    }
  } finally {
    release();
    if (locks.get(businessId) === chained) locks.delete(businessId);
  }
}
