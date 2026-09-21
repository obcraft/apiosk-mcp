import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalFeedback } from '../src/approval-feedback.mjs';
import { formatDisplayMoney } from '../src/display-money.mjs';

test('missing or malformed budget amounts keep the safe server explanation',()=>{
  for(const details of [undefined,{}, {currency:'EUR',required_atomic:'12',available_atomic:'1'}, {currency:'USD',required_atomic:'bad',available_atomic:'1'}]){
    const data={errors:[{code:'approval_per_request_limit',message:'Increase the limit in Connections.',details}]};
    assert.equal(approvalFeedback(data,formatDisplayMoney,'fallback'),'Increase the limit in Connections.');
  }
});
test('unknown errors keep their message even if they carry budget-like details',()=>{
  const data={errors:[{code:'approval_unconfirmed',message:'Check status first.',details:{currency:'USD',required_atomic:'12',available_atomic:'1'}}]};
  assert.equal(approvalFeedback(data,formatDisplayMoney,'fallback'),'Check status first.');
});
