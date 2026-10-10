import type { NextFunction, Request, Response } from 'express';

/**
 * Blueprint §17 rate limiting and abuse monitoring: a fixed-window counter per key.
 * In memory, which is right for BizPilot's single server; repeated hits are logged.
 */
export function rateLimit(opts: { name: string; windowMs: number; max: number; key?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(opts.windowMs, 60_000)).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = opts.key?.(req) ?? req.ctx?.userId ?? req.ip ?? 'unknown';
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (h.count <= opts.max) return next();
    const wait = Math.ceil((h.resetAt - now) / 1000);
    if (h.count === opts.max + 1) console.warn(`[rate-limit] ${opts.name}: ${key} went over ${opts.max} per ${opts.windowMs / 1000}s`);
    res.setHeader('Retry-After', String(wait));
    res.status(429).json({ error: `Too many requests. Try again in ${wait} seconds.` });
  };
}
