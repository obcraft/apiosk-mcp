import { useContext } from "react"
import { GatewayMoneyContext } from "./gateway-v2-money-context"
import { formatQuoteCeiling, formatQuoteItem, formatSourcePrice } from "@/lib/ui/source-price"
import { useMoney } from "@/environment"
import { formatMicroUsd } from "@/lib/domain/gateway-v2"

/** One display currency for quotes, approvals, results and balance details. */
export function useGatewayV2Money() {
  const money = useMoney()
  const override = useContext(GatewayMoneyContext)
  if (override) return override
  return (value: string, balance = false, maximumFractionDigits?: 3, previousQuoteAtomic?: string) => {
    if (!money.ready) return "…"
    const micro = Number(value)
    if (maximumFractionDigits === 3 && Number.isSafeInteger(micro)) {
      return formatSourcePrice(`${micro / 1_000_000} USD`, money.currency, money.rate) ?? formatMicroUsd(value)
    }
    // Display conversion uses the account's existing published rate.
    // USD stays exact, including values beyond JavaScript's safe integer range.
    if (money.currency !== "USD" && Number.isSafeInteger(micro)) {
      if (!balance && previousQuoteAtomic !== undefined) {
        return formatQuoteItem(value, previousQuoteAtomic, money.currency, money.rate) ?? formatMicroUsd(value)
      }
      // A quote ceiling must never round below the converted approval amount.
      return balance ? formatSourcePrice(`${micro / 1_000_000} USD`, money.currency, money.rate) ?? formatMicroUsd(value) : formatQuoteCeiling(value, money.currency, money.rate) ?? formatMicroUsd(value)
    }
    return formatMicroUsd(value)
  }
}
