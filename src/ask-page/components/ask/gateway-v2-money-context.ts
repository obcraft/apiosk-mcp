import { createContext } from 'react'

/** Local display override; never changes the ledger or approval payload. */
export type GatewayMoneyFormatter = (value: string, balance?: boolean, maximumFractionDigits?: 3, previousQuoteAtomic?: string) => string
export const GatewayMoneyContext = createContext<GatewayMoneyFormatter | null>(null)
