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
  return `${negative ? '-' : ''}${magnitude / 1000000n}.${(magnitude % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')} ${currency}`;
}
