import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDisplayMoney } from '../src/display-money.mjs';

const eur = { base_currency: 'USD', currency: 'EUR', rate: '0.92000000' };
test('display conversion preserves sub-cent amounts and rounds ceilings upward', () => {
  assert.equal(formatDisplayMoney('114446', 'USD', eur, true), '0.105291 EUR');
  assert.equal(formatDisplayMoney('23000', 'USD', eur), '0.02116 EUR');
  assert.equal(formatDisplayMoney('12986468', 'USD', eur), '11.947551 EUR');
  assert.equal(formatDisplayMoney('1', 'USD', {...eur, rate:'0.1'}, true), '0.000001 EUR');
  assert.equal(formatDisplayMoney('-23000', 'USD', eur), '-0.02116 EUR');
  assert.equal(formatDisplayMoney('1000000', 'USD', {...eur, currency:'JPY', rate:'150.25'}), '150.25 JPY');
  assert.equal(formatDisplayMoney('9007199254740993', 'USDC', eur, true), '8286623314.361714 EUR');
});
test('invalid or absent conversion never disguises USD as EUR and source currencies are untouched', () => {
  for (const display of [null, {...eur, rate:'0'}, {...eur, rate:'NaN'}, {...eur, rate:'-1'}, {...eur, rate:'1e2'}, {...eur, base_currency:'EUR'}]) {
    assert.equal(formatDisplayMoney('23000', 'USD', display), '0.023 USD');
  }
  assert.equal(formatDisplayMoney('23000', 'GBP', eur), '0.023 GBP');
  assert.equal(formatDisplayMoney(null, 'USD', eur), null);
});
