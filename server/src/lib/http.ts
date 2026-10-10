import type { NextFunction, Request, Response } from 'express';
import { OpError } from '../../../src/lib/ops.ts';
import { ProviderError } from '../providers/types.ts';
import { getProvider } from '../providers/index.ts';
import { providerContext } from './integrations.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wrap an async route so thrown errors become JSON responses. */
export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res)
      .then((out) => {
        if (!res.headersSent) res.json(out ?? { ok: true });
      })
      .catch((e: unknown) => {
        const err = e as Error;
        const status = e instanceof HttpError ? e.status : e instanceof OpError || e instanceof ProviderError ? 400 : 500;
        if (status === 500) console.error(err);
        if (!res.headersSent) res.status(status).json({ error: err.message || 'Something went wrong.' });
      });
  };

export async function contextFor(businessId: string, providerId: string) {
  const provider = getProvider(providerId);
  if (!provider) throw new HttpError(404, `Unknown integration "${providerId}".`);
  return { provider, pctx: await providerContext(businessId, provider) };
}
