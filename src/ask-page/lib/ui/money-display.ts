/**
 * Money on screen: two decimals at most, rounded to the nearest cent. A real,
 * non-zero amount under half a cent reads "< €0.01"; rounding it to €0.00
 * would say it is free. Only the text changes: stored, quoted and charged
 * amounts stay exact.
 */
const formatters = new Map<string, Intl.NumberFormat>()

function centsFormatter(currency: string): Intl.NumberFormat {
  const cached = formatters.get(currency)
  if (cached) return cached
  const options: Intl.NumberFormatOptions = { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }
  let made: Intl.NumberFormat
  try {
    made = new Intl.NumberFormat("en-US", options)
  } catch {
    // An unrecognised code: dollars, which is what the ledger holds.
    made = new Intl.NumberFormat("en-US", { ...options, currency: "USD" })
  }
  formatters.set(currency, made)
  return made
}

/** "< €0.01": a real amount too small to write at cents. */
export function underOneCent(currency: string): string {
  return `< ${centsFormatter(currency).format(0.01)}`
}

/** An amount in `currency`, at cents. */
export function formatCents(amount: number, currency: string): string {
  if (amount > 0 && amount < 0.005) return underOneCent(currency)
  return centsFormatter(currency).format(amount)
}

/** Micro-units already in `currency` → the nearest cent, without float drift. */
export function microToCents(micro: bigint): bigint {
  return micro < 0n ? -((-micro + 5_000n) / 10_000n) : (micro + 5_000n) / 10_000n
}

/** Micro-units already in `currency`, at cents. */
export function formatMicroCents(micro: bigint, currency: string): string {
  if (micro > 0n && micro < 5_000n) return underOneCent(currency)
  return centsFormatter(currency).format(Number(microToCents(micro)) / 100)
}

/**
 * Conversion dust: up to a hundredth of a cent above a whole cent. An exact
 * rate times an amount often lands a few micro-units over (€1.000004); that is
 * not money anyone pays, so a cost rounds down past it.
 */
const DUST_MICRO = 100n

/**
 * A cost or approval ceiling, in micro-units already in `currency` → whole
 * cents, rounded UP so what is shown is never less than what can be charged,
 * ignoring conversion dust.
 */
export function microToCentsUp(micro: bigint): bigint {
  if (micro <= 0n) return microToCents(micro)
  const trimmed = micro > DUST_MICRO ? micro - DUST_MICRO : 0n
  return (trimmed + 9_999n) / 10_000n
}

/** A cost or approval ceiling, at cents and never below what can be charged. */
export function formatMicroCentsUp(micro: bigint, currency: string): string {
  if (micro > 0n && micro < 10_000n) return underOneCent(currency)
  return centsFormatter(currency).format(Number(microToCentsUp(micro)) / 100)
}
