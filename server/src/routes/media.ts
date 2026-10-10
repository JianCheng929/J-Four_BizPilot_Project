import { Router } from 'express';
import { requireUser, ctx } from '../lib/auth.ts';
import { handle, HttpError } from '../lib/http.ts';
import { generateImage, type Aspect } from '../lib/media.ts';

export const media = Router();

/** Generate one marketing image from a text prompt. */
media.post('/image', requireUser, handle(async (req) => {
  const c = ctx(req);
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) throw new HttpError(400, 'Describe the image to generate.');
  const aspect = (['1:1', '4:5', '9:16', '16:9'].includes(req.body?.aspect) ? req.body.aspect : '1:1') as Aspect;
  return generateImage(c.business.id, prompt, aspect);
}));
