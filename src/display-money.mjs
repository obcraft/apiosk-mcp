// Self-contained: this exact function is also embedded in the chat card.
// Conversion affects display only, never the amount submitted for approval.
export function formatDisplayMoney(atomic, currency = 'USD', display = null, ceiling = false) {
  if (atomic == null || !/^-?\d+$/.test(String(atomic))) return null;
  currency = !currency || currency === 'USDC' ? 'USD' : currency;
  let value = BigInt(atomic);
  if (currency === 'USD' && display?.base_currency === 'USD' && /^[A-Z]{3}$/.test(display.currency || '') && /^\d{1,18}(\.\d{1,18})?$/.test(display.rate || '')) {
    const [whole, fraction = ''] = display.rate.split('.');
    const numerator = BigInt(whole + fraction), denominator = 10n ** BigInt(fraction.length);
    if (numerator > 0n) {
      const product = value * numerator;
      const negative = product < 0n, magnitude = negative ? -product : product;
      const rounding = ceiling && !negative ? denominator - 1n : denominator / 2n;
      value = (negative ? -1n : 1n) * ((magnitude + rounding) / denominator);
      currency = display.currency;
    }
  }
  const negative = value < 0n, magnitude = negative ? -value : value;
  // Shown at cents. A ceiling rounds up, so it never reads below what can be
  // charged, but ignores conversion dust (up to 100 micro-units over a cent,
  // as in 1.000004); anything else rounds to the nearest cent. A real amount
  // below a cent reads "< 0.01" rather than looking free.
  const up = ceiling && !negative;
  if (magnitude > 0n && magnitude < (up ? 10000n : 5000n)) return `${negative ? '> -' : '< '}0.01 ${currency}`;
  const cents = up ? ((magnitude > 100n ? magnitude - 100n : 0n) + 9999n) / 10000n : (magnitude + 5000n) / 10000n;
  return `${negative ? '-' : ''}${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')} ${currency}`;
}
