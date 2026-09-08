import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSourceValue, sourceCurrency } from '../src/source-value-format.mjs';

test('financial display groups exact digits and preserves signs, decimals and zero', () => {
  assert.equal(formatSourceValue('191534000', 'AssetsCurrent'), '191.534.000');
  assert.equal(formatSourceValue('-5166000', 'ResultAfterTax'), '-5.166.000');
  assert.equal(formatSourceValue('9007199254740993123.4500', 'Assets'), '9.007.199.254.740.993.123,4500');
  assert.equal(formatSourceValue(0, 'IncomeTaxExpense'), '0');
});
test('currency comes only from source metadata and identifiers are never grouped', () => {
  assert.equal(formatSourceValue('191534000', 'AssetsCurrent', sourceCurrency({currency:'EUR'})), '€ 191.534.000');
  assert.equal(formatSourceValue('191534000', 'AssetsCurrent'), '191.534.000');
  for (const [key,value] of [['FinancialYear','2020'],['SbiBusinessCode','6201'],['kvkNummer','30204462'],['DocumentAdoptionDate','2021-05-28'],['AccountId','00123456']]) assert.equal(formatSourceValue(value,key,'EUR'),value);
  assert.equal(formatSourceValue('10000','EmployeeCount','EUR'),'10.000');
  assert.equal(sourceCurrency({unit:'iso4217:EUR'}),'EUR');
});
