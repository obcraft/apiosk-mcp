// Driver safeguards only. These fixtures do not establish live acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advance } from '../examples/run-company-monitor-local.mjs';

const fixture = () => {
  const companies=[{name:'Test B.V.',kvk_number:'01234567'}];
  const report={view:'company_check',check_id:'check',occurrence:'week',companies,status:'completed',
    coverage:['registry','sanctions','news'].map(category=>({kvk_number:'01234567',category,status:'checked'})),
    sources:[{result_ref:'source'}],new_signals:[{signal_id:'signal'}]};
  return {companies,report,state:{check_id:'check',occurrence:'week',companies,recipient:'self@example.test'}};
};
const wrapped = structuredContent => ({structuredContent});
test('live driver persists identity before purchase and stops at missing host email receipt',async()=>{
  const {state,report}=fixture(); const calls=[]; let saved=false;
  const outcome=await advance({state,save:async()=>{saved=true},call:async(name,args)=>{
    assert.ok(saved); calls.push(name);
    if(name==='apiosk_company_check')return wrapped(report);
    if(name==='apiosk_company_check_read')return wrapped({view:'company_check_evidence',source:{result_ref:'source',document:{data:{fact:true}}}});
    if(name==='apiosk_company_check_email')return wrapped({delivery_id:args.delivery_id,dispatch_allowed:true,status:'awaiting_confirmation',payload:{signal_ids:['signal']}});
    throw Error('unexpected tool');
  }});
  assert.equal(outcome.accepted,false);assert.equal(outcome.reason,'host_email_receipt_required');
  assert.ok(!calls.includes('apiosk_approve'));assert.ok(!calls.includes('apiosk_company_check_acknowledge'));
});
test('incomplete or empty coverage cannot pass acceptance or prepare an email',async()=>{
  const {state,report}=fixture(); report.coverage=[];const calls=[];
  const result=await advance({state,save:async()=>{},call:async(name)=>{calls.push(name);return wrapped(report)}});
  assert.equal(result.accepted,false);assert.equal(result.reason,'incomplete_source_coverage');
  assert.deepEqual(calls,['apiosk_company_check']);
});
test('a receipt checkpoint resumes without another source run and verifies duplicate suppression',async()=>{
  const {state,report}=fixture();state.report=report;state.delivery_id='delivery';
  state.delivery={delivery_id:'delivery',dispatch_allowed:true,payload:{signal_ids:['signal']}};
  const calls=[];
  const outcome=await advance({state,save:async()=>{},receipt:{delivery_id:'delivery',recipient:state.recipient,sent:true,provider:'test-mail',provider_message_id:'message'},call:async(name,args)=>{
    calls.push(name);
    if(name==='apiosk_company_check_read')return wrapped({view:'company_check_evidence',source:{result_ref:'source',document:{data:{fact:true}}}});
    if(name==='apiosk_company_check_acknowledge')return wrapped({status:'sent'});
    if(name==='apiosk_company_check_result')return wrapped({...report,new_signals:[]});
    if(name==='apiosk_company_check_email')return wrapped({status:args.delivery_id==='delivery'?'sent':'suppressed',dispatch_allowed:false});
    throw Error('unexpected tool');
  }});
  assert.equal(outcome.accepted,true);assert.equal(outcome.schedule_verified,false);
  assert.equal(outcome.fresh_weekly_run_verified,false);assert.ok(!calls.includes('apiosk_company_check'));
});
test('drafts and receipts for another recipient never acknowledge signals',async()=>{
  for(const override of [{sent:false},{recipient:'wrong@example.test'},{delivery_id:'wrong'}]) {
    const {state,report}=fixture();state.report=report;state.delivery_id='delivery';state.delivery={delivery_id:'delivery',payload:{signal_ids:['signal']}};
    let acknowledged=false;
    await assert.rejects(advance({state,save:async()=>{},receipt:{delivery_id:'delivery',recipient:state.recipient,sent:true,provider:'test',provider_message_id:'message',...override},call:async name=>{
      if(name==='apiosk_company_check_acknowledge')acknowledged=true;
      return wrapped({view:'company_check_evidence',source:{result_ref:'source',document:{data:{fact:true}}}});
    }}));
    assert.equal(acknowledged,false);
  }
});
