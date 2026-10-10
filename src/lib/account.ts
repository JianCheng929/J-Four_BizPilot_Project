import { createContext, useContext } from 'react';
import type { BusinessRow } from './db/remote';

/** The businesses this login can open, and switching between them (provided by App's Gate). */
export interface Account {
  businesses: BusinessRow[];
  switchBusiness: (id: string) => void;
  addBusiness: () => void;
}

export const AccountCtx = createContext<Account | null>(null);
export const useAccount = () => useContext(AccountCtx);
