import { formatCents, formatMicroCentsUp, microToCentsUp, underOneCent } from "./money-display"
const usd = (price: string | null) => price?.match(/^(\d+(?:\.\d+)?)\s+USD(?:C)?$/i)?.[1]

/** Display-only conversion: the original source price and payment amounts stay exact. */
export function formatSourcePrice(price: string | null, currency: string, rate: number): string | null {
  const amount = usd(price)
  if (amount === undefined || !Number.isFinite(rate) || rate <= 0) return null
  const converted = Number(amount) * rate
  if (!Number.isFinite(converted)) return null
  return formatCents(converted, currency)
}

function convertedMicros(microUsd: string, rate: number): bigint | null {
  if (!/^\d+$/.test(microUsd) || !Number.isFinite(rate) || rate <= 0) return null
  const [, whole, fraction = "", exponent = "0"] = String(rate).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/)!
  const scale = Number(exponent) - fraction.length
  let numerator = BigInt(microUsd) * BigInt(whole + fraction)
  const denominator = scale < 0 ? 10n ** BigInt(-scale) : 1n
  if (scale > 0) numerator *= 10n ** BigInt(scale)
  return (numerator + denominator - 1n) / denominator
}

/** A converted approval ceiling at cents, rounded up so it never shows less than the cap; the approved micro amount itself stays exact. */
export function formatQuoteCeiling(microUsd: string, currency: string, rate: number): string | null {
  const converted = convertedMicros(microUsd, rate)
  return converted === null ? null : formatMicroCentsUp(converted, currency)
}

/** Share sub-micro rounding across a complete quote so displayed rows sum to its ceiling. */
export function quoteBreakdownOffsets(total: string, amounts: (string | null | undefined)[]): string[] | null {
  if (!/^\d+$/.test(total) || amounts.some(amount => typeof amount !== 'string' || !/^\d+$/.test(amount))) return null
  let sum = 0n
  const offsets = amounts.map(amount => { const before = sum.toString(); sum += BigInt(amount!); return before })
  return sum === BigInt(total) ? offsets : null
}

export function formatQuoteItem(microUsd: string, previousMicroUsd: string, currency: string, rate: number): string | null {
  if (!/^\d+$/.test(microUsd) || !/^\d+$/.test(previousMicroUsd)) return null
  const before = convertedMicros(previousMicroUsd, rate)
  const through = convertedMicros((BigInt(previousMicroUsd) + BigInt(microUsd)).toString(), rate)
  if (before === null || through === null) return null
  // Each row is the difference of rounded running totals, so the rows still add up to the rounded total.
  const cents = microToCentsUp(through) - microToCentsUp(before)
  return cents === 0n && through > before ? underOneCent(currency) : formatCents(Number(cents) / 100, currency)
}

/**
 * A display estimate for several sources: the sum of their listed prices.
 * Not a quote: a source may need a lookup call first, so the quoted total can
 * be higher. `partial` when a source listed no usable price.
 */
export function estimateSourcesTotal(prices: (string | null)[], currency: string, rate: number): { text: string; partial: boolean } | null {
  const known = prices.map(usd).filter((amount): amount is string => amount !== undefined)
  if (!known.length) return null
  // Sum in integer micro-USD so float drift never rounds the estimate up a cent.
  const micro = known.reduce((sum, amount) => sum + Math.round(Number(amount) * 1_000_000), 0)
  const text = formatSourcePrice(`${(micro / 1_000_000).toFixed(6)} USD`, currency, rate)
  return text ? { text, partial: known.length < prices.length } : null
}
