import type { Provider } from './types.ts';
import { shopee } from './shopee.ts';
import { lazada } from './lazada.ts';
import { tiktokShop } from './tiktokShop.ts';
import { easyparcel } from './easyparcel.ts';
import { myinvois } from './myinvois.ts';
import { meta } from './meta.ts';
import { smtp } from './smtp.ts';

export const PROVIDERS: Provider[] = [shopee, lazada, tiktokShop, easyparcel, myinvois, meta, smtp];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export const MARKETPLACES = ['shopee', 'lazada', 'tiktok_shop'] as const;
