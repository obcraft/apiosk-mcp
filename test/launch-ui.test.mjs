import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APIOSK_UI_BRIDGE } from '../src/ui-bridge.mjs';
import { APIO_OFFER_CARD_HTML } from '../src/offer-card.mjs';
import { APIO_RESULT_CANVAS_HTML } from '../src/result-canvas.mjs';
import { APIO_RESULTS_PICKER_HTML } from '../src/results-picker.mjs';
import { APIO_V2_CARD_HTML } from '../src/gateway-v2-card.mjs';
import { executionKey, runExecute } from '../src/tools/execute.mjs';

function harness(html=null,openai=null) {
  const sent=[],listeners=new Map(),nodes=new Map(),timers=new Map();let timerId=0;
  const el=(name='div')=>({nodeType:1,tagName:name.toUpperCase(),textContent:'',value:'',disabled:false,dataset:{},children:[],classList:{add(){},remove(){},contains(){return false}},append(...c){this.children.push(...c)},replaceChildren(...c){this.children=c},querySelectorAll(selector){return this.children.flatMap(c=>[...(selector.split(',').includes(c.tagName.toLowerCase())?[c]:[]),...c.querySelectorAll(selector)])},focus(){},addEventListener(name,fn){this['on'+name]=fn},reportValidity(){return !this.required||this.value!==''}});
  const document={documentElement:{scrollWidth:320,scrollHeight:200},getElementById(id){if(!nodes.has(id))nodes.set(id,el());return nodes.get(id)},createElement:el};
  const parent={postMessage(m){sent.push(m)}};
  const window={parent,openai,addEventListener(n,fn){listeners.set(n,fn)}};
  const ctx=vm.createContext({window,document,URL,Intl,console,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},ResizeObserver:class{observe(){}}});
  if(html)for(const s of html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(s[1],ctx);else vm.runInContext(APIOSK_UI_BRIDGE,ctx);
  return {
    sent,nodes,window,
    async globals(globals) {
      Object.assign(window.openai,globals);
      listeners.get('openai:set_globals')?.({detail:{globals}});
      for(let i=0;i<12;i++)await Promise.resolve();
    },
    async tick(ms) {
      const entry=[...timers].find(([,t])=>t.ms===ms);
      if(!entry)return false;
      timers.delete(entry[0]);entry[1].fn();
      for(let i=0;i<12;i++)await Promise.resolve();
      return true;
    },
    async message(data,source=parent) {
      listeners.get('message')?.({source,data});
      await Promise.resolve();await Promise.resolve();
    },
    async initialize(hostName='test-host') {
      const init=sent.find(m=>m.method==='ui/initialize');
      await this.message({jsonrpc:'2.0',id:init.id,result:{hostInfo:{name:hostName,version:'1'},hostCapabilities:{serverTools:{},message:{text:{}},openLinks:{},updateModelContext:{text:{}}}}});
    },
  };
}

test('MCP Apps negotiates the current protocol and accepts only its parent frame',async()=>{
  const h=harness();const init=h.sent[0];
  assert.equal(init.method,'ui/initialize');assert.equal(init.params.protocolVersion,'2026-01-26');assert.equal(init.params.appInfo.name,'Apiosk');
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{answer:'forged'}}},{});
  assert.equal(h.window.apiosk.data,null);
  await h.initialize();assert.ok(h.sent.some(m=>m.method==='ui/notifications/initialized'));
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{answer:'verified'}}});
  assert.equal(h.window.apiosk.data.answer,'verified');
});

test('the shared bridge reports compact content height to ChatGPT',()=>{
  const heights=[];const h=harness(null,{notifyIntrinsicHeight:value=>heights.push(value)});
  h.window.apiosk.resize();
  assert.deepEqual(heights,[200]);
});

test('the shared bridge delivers tool input to interactive paginated cards',async()=>{
  const h=harness();let input=null;h.window.apiosk.onInput(value=>{input=value});
  await h.initialize();
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{search:'security',offset:20}});
  assert.deepEqual(input,{search:'security',offset:20});
});

test('the v2 card renders sources and a priced plan from structured content',async()=>{
  const sources=harness(APIO_V2_CARD_HTML);await sources.initialize();
  assert.doesNotMatch(APIO_V2_CARD_HTML,/Preparing your request|apiosk-wordmark/);
  assert.doesNotMatch(APIO_V2_CARD_HTML,/Check progress/);
  await sources.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{protocol_version:'2',sources:[{name:'Registry',category:'company data',endpoint_count:3,capabilities:['company.profile']}],total:1,offset:0,next_offset:null}}});
  assert.equal(sources.nodes.get('title').textContent,'1 matching source');
  assert.equal(sources.nodes.get('status-pill').textContent,'Ready');
  const plan=harness(APIO_V2_CARD_HTML);await plan.initialize();
  await plan.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{protocol_version:'2',status:'requires_approval',proposal:{label:'Your plan',currency:'USDC',max_total_atomic:'97826',approval_url:'https://app.apiosk.com/gateway-v2?task=task',steps:['company.profile'],step_details:[{title:'Retrieve company profile',status:'pending',source:{name:'Global Company Registry'}}]},context_view:{},billing:{currency:'USD',total_charged:'0',balance_available:'15101060'},next_actions:[{action_id:'run',kind:'execute_quoted_step'}],errors:[],state:{state_ref:'task',revision:1}}}});
  const planSection=plan.nodes.get('sections').children[0];
  assert.equal(planSection.children[0].children[0].textContent,'Data request');
  assert.equal(planSection.children.at(-1).children[0].textContent,'Approve up to 0.097826 USD');
  assert.equal(plan.nodes.get('status-pill').textContent,'Approval needed');
});

test('conversation messages use content blocks and honor host rejection',async()=>{
  const h=harness();await h.initialize();const promise=h.window.apiosk.say('Please continue');
  const message=h.sent.find(m=>m.method==='ui/message');
  assert.equal(message.params.content[0].type,'text');assert.equal(message.params.content[0].text,'Please continue');
  await h.message({jsonrpc:'2.0',id:message.id,result:{isError:true}});assert.equal(await promise,false);
  assert.equal(await h.window.apiosk.openLink('javascript:alert(1)'),false);
});

const offer={query:'Current registration?',top:{provider:'GLEIF',description:'Official registry',price_usdc:0.012,offer_token:'signed',input_fields:[]}};
test('both cards render MCP Apps tool-result notifications without OpenAI globals',async()=>{
  const proposal=harness(APIO_OFFER_CARD_HTML);await proposal.initialize();await proposal.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:offer}});
  assert.equal(proposal.nodes.get('provider').textContent,'GLEIF');assert.match(proposal.nodes.get('approve').textContent,/0.012/);
  const result=harness(APIO_RESULT_CANVAS_HTML);await result.initialize();await result.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{answer:'The registration is active.',result:{status:'ACTIVE'}}}});
  assert.equal(result.nodes.get('answer').textContent,'The registration is active.');assert.match(result.nodes.get('source').textContent,/ACTIVE/);
});

test('Deny locks the proposal without invoking a paid tool',async()=>{
  let calls=0;const h=harness(APIO_OFFER_CARD_HTML,{toolOutput:offer,callTool:async()=>{calls++},sendFollowUpMessage:async()=>{}});
  await h.nodes.get('deny').onclick();await h.nodes.get('approve').onclick();
  assert.equal(calls,0);assert.equal(h.nodes.get('approve').disabled,true);assert.match(h.nodes.get('status').textContent,/Nothing was spent/);
});

test('a paid success remains locked when delivering the chat answer fails',async()=>{
  let calls=0;const h=harness(APIO_OFFER_CARD_HTML,{toolOutput:offer,callTool:async()=>{calls++;return{structuredContent:{ok:true,answer:'Active',result:{status:'ACTIVE'}}}},sendFollowUpMessage:async()=>{throw new Error('Host unavailable')}});
  await h.nodes.get('approve').onclick();await h.nodes.get('approve').onclick();
  assert.equal(calls,1);assert.equal(h.nodes.get('approve').disabled,true);assert.equal(h.nodes.get('description').textContent,'Active');
});

test('purchase keys survive retries and input property reordering',()=>{
  const a=executionKey('signed',{input:{a:1,b:2}});
  assert.equal(a,executionKey('signed',{input:{b:2,a:1}}));
  assert.notEqual(a,executionKey('other',{input:{a:1,b:2}}));assert.notEqual(a,executionKey('signed',{input:{a:2,b:2}}));
  assert.match(a,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('execute returns a readable answer and retains structured source details',async()=>{
  const gateway={requestJson:async path=>path==='/v1/select'?{selection_id:'selection'}:{ok:true,answer:'The registration is active.',result:{status:'ACTIVE'}}};
  const result=await runExecute({offer_token:'signed',prompt:offer.query,max_price_usdc:0.012},{gateway});
  assert.equal(result.content[0].text,'The registration is active.');assert.equal(result.structuredContent.result.status,'ACTIVE');
});

test('prefilled enum and numeric fields retain their values behind Request details',async()=>{
  let args;const fields=[{name:'country',type:'string',location:'query',options:['NL','US'],default_value:'NL'},{name:'year',type:'integer',location:'body',default_value:2026}];
  const h=harness(APIO_OFFER_CARD_HTML,{toolOutput:{...offer,top:{...offer.top,input_fields:fields}},callTool:async(_name,value)=>{args=value;return{ok:true,answer:'Done'}},sendFollowUpMessage:async()=>{}});
  assert.equal(h.nodes.get('fields').children[0].children[0].tagName,'SELECT');
  await h.nodes.get('approve').onclick();
  assert.equal(args.input_parts.query.country,'NL');assert.equal(args.input_parts.body.year,2026);
});

test('missing required input prevents a paid request',async()=>{
  let calls=0;const h=harness(APIO_OFFER_CARD_HTML,{toolOutput:{...offer,top:{...offer.top,input_fields:[{name:'country',type:'string',required:true}]}},callTool:async()=>{calls++}});
  await h.nodes.get('approve').onclick();assert.equal(calls,0);assert.match(h.nodes.get('status').textContent,/required fields/);
});

test('the alternatives picker also keeps a completed purchase locked',async()=>{
  let calls=0;const selection={query:offer.query,options:[{id:'one',provider:'GLEIF',price_label:'$0.012',input_fields:[],execute_arguments:{offer_token:'signed',prompt:offer.query,max_price_usdc:.012}}]};
  const h=harness(APIO_RESULTS_PICKER_HTML,{toolOutput:{selection},callTool:async()=>{calls++;return{ok:true,answer:'Active'}},sendFollowUpMessage:async()=>{throw new Error('Host unavailable')}});
  await h.nodes.get('run').onclick();await h.nodes.get('run').onclick();assert.equal(calls,1);assert.equal(h.nodes.get('run').disabled,true);
});

test('Claude approvals open Apiosk without attempting an in-card purchase',async()=>{
  const h=harness(APIO_OFFER_CARD_HTML);await h.initialize('Claude');
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:offer}});
  assert.match(h.nodes.get('approve').textContent,/Approve in Apiosk/);
  const approval=h.nodes.get('approve').onclick();const link=h.sent.find(m=>m.method==='ui/open-link');
  assert.equal(new URL(link.params.url).origin,'https://app.apiosk.com');
  await h.message({jsonrpc:'2.0',id:link.id,result:{}});await approval;
  assert.ok(!h.sent.some(m=>m.method==='tools/call'));assert.match(h.nodes.get('status').textContent,/Nothing was spent here/);
});

const v2Ready={status:'ready',state:{state_ref:'task',revision:1},proposal:{quote_ref:'quote',expires_at:'2099-01-01',currency:'USDC',max_total_atomic:'21739',approval_url:'https://app.apiosk.com/gateway-v2?task=task',steps:['company.search']},context_view:{execution_enabled:true},billing:{authorization_active:false,quote_ref:'quote'},next_actions:[{action_id:'run',kind:'execute_quoted_step'}]};
test('in-chat approval requires a click, uses the exact displayed cap once and continues without an external link',async()=>{
 const calls=[];let release,links=0;
 const data={...v2Ready,context_view:{execution_enabled:true,approval_mode:'chatbot'}};
 const approved={...data,billing:{...data.billing,authorization_active:true}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,openExternal(){links++},callTool:async(name,args)=>{calls.push({name,args});if(name==='apiosk_approve')await new Promise(resolve=>{release=resolve});return{structuredContent:name==='apiosk_approve'?approved:{...approved,status:'succeeded',next_actions:[],result:{data:{name:'Example'}}}}}});
 await h.tick(350);await h.tick(2000);assert.equal(calls.length,0);
 const button=h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to'));
 const pending=button.onclick();await button.onclick();assert.equal(calls.length,1);
 assert.equal(calls[0].name,'apiosk_approve');assert.equal(calls[0].args.max_total_atomic,'21739');assert.equal(calls[0].args.quote_ref,'quote');assert.equal(calls[0].args.state.state_ref,'task');
 release();await pending;await h.tick(350);
 assert.equal(calls.length,2);assert.equal(calls[1].name,'apiosk_execute');assert.equal(calls[1].args.idempotency_key,'run');assert.equal(links,0);assert.equal(h.nodes.get('title').textContent,'Source result');
});
test('ChatGPT global updates cannot replace an approved result with the original plan or cancel its next step',async()=>{
 const calls=[];const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
 const approved={...data,billing:{authorization_active:true,quote_ref:'quote'}};
 const done={...approved,status:'succeeded',next_actions:[],result:{data:{name:'Saved company'}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push(name);return{structuredContent:name==='apiosk_approve'?approved:done}}});
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 await h.globals({theme:'dark'});
 await h.globals({toolOutput:JSON.parse(JSON.stringify(data))});
 await h.globals({toolOutput:{...data,request_id:'resent-original-plan'}});
 await h.tick(350);
 assert.deepEqual(calls,['apiosk_approve','apiosk_execute']);
 await h.globals({widgetState:{result:done}});
 await h.globals({toolOutput:JSON.parse(JSON.stringify(data))});
 assert.equal(h.nodes.get('title').textContent,'Source result');
 assert.equal(h.nodes.get('sections').querySelectorAll('button').some(b=>b.textContent.startsWith('Approve up to')),false);
});
test('in-chat approval never buys after a refused or mismatched approval response or expired quote',async()=>{
 for(const response of [{error_code:'approval_refused',message:'Limit exceeded'},{...v2Ready,billing:{authorization_active:true,quote_ref:'other'}}]){
  const calls=[];const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name)=>{calls.push(name);return{structuredContent:response}}});
  await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
  await h.tick(350);await h.tick(2000);assert.deepEqual(calls,['apiosk_approve']);
 }
 let calls=0;const data={...v2Ready,context_view:{approval_mode:'chatbot'},proposal:{...v2Ready.proposal,expires_at:'2000-01-01'}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async()=>{calls++}});
 const button=h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Quote expired'));
 assert.equal(button.disabled,true);await button.onclick();assert.equal(calls,0);
});
test('Claude receives result context without an unsolicited composer draft or second confirmation',async()=>{
 const h=harness(APIO_V2_CARD_HTML);await h.initialize('Claude');
 await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:v2Ready}});
 const read={...v2Ready,status:'succeeded',next_actions:[],result:{data:{name:'Example'}}};
 const refreshing=h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent==='Check status').onclick();
 const call=h.sent.find(m=>m.method==='tools/call');
 await h.message({jsonrpc:'2.0',id:call.id,result:{structuredContent:read}});await refreshing;
 const context=h.sent.find(m=>m.method==='ui/update-model-context');assert.ok(context);assert.equal(JSON.parse(context.params.content[0].text).result.data.name,'Example');
 await h.message({jsonrpc:'2.0',id:context.id,result:{}});
 assert.equal(h.sent.some(m=>m.method==='ui/message'),false);assert.equal(h.nodes.get('title').textContent,'Source result');
});
test('v2 card observes approval then executes once with the saved quote and publishes the result',async()=>{
 const calls=[],contexts=[],messages=[];
 const approved={...v2Ready,billing:{...v2Ready.billing,authorization_active:true}};
 const done={...approved,status:'succeeded',next_actions:[],result:{data:{resultaten:[{naam:"Tony's Chocolonely",kvkNummer:'34241705'}],totaal:16,pagina:1}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:v2Ready,openExternal(){},callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:args.task_ref?approved:done}},setWidgetState:value=>contexts.push(value),sendFollowUpMessage:async value=>messages.push(value)});
 assert.equal(calls.length,0);
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 await h.tick(2000);
 assert.equal(calls[0].args.task_ref,'task');
 await h.tick(350);
 assert.equal(calls.length,2);
 assert.equal(calls[1].args.quote_ref,'quote');assert.equal(calls[1].args.idempotency_key,'run');
 assert.equal(h.nodes.get('title').textContent,'Source result');assert.equal(contexts.at(-1).privateContent.apioskResult.status,'succeeded');
 assert.equal(messages.length,1);assert.match(messages[0].prompt,/Do not purchase/);
 assert.match(messages[0].prompt,/only a brief completion note and source citation/);
 assert.match(messages[0].prompt,/Do not repeat the card's figures, tables, JSON, charges/);
 assert.match(messages[0].prompt,/only when the actual user explicitly asks/);
 assert.doesNotMatch(messages[0].prompt,/Include actual charges and any missing data/);
 assert.equal(await h.tick(350),false);
});
test('v2 card never executes absent, mismatched or disabled consent',async()=>{
 for(const changes of [{},{billing:{authorization_active:true,quote_ref:'old'}},{billing:{authorization_active:true,quote_ref:'quote'},context_view:{execution_enabled:false}}]){
  const calls=[];const data={...v2Ready,...changes};
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push(args);return{structuredContent:data}}});
  await h.tick(350);await h.tick(2000);
  assert.ok(calls.every(args=>args.task_ref==='task'));
 }
});
test('v2 card never automatically replays an interrupted paid action',async()=>{
 let paid=0;
 const data={...v2Ready,billing:{authorization_active:true,quote_ref:'quote'}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(_name,args)=>{if(args.task_ref)return{structuredContent:data};paid++;throw new Error('Connection interrupted')}});
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent==='Continue approved request').onclick();
 await h.tick(350);await h.tick(350);await h.tick(2000);
 assert.equal(paid,1);assert.match(h.nodes.get('feedback-text').textContent,/Connection interrupted/);
});

test('v2 card preserves task recovery when a tool returns a transport error envelope',async()=>{
 const calls=[];
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:v2Ready,callTool:async(name,args)=>{calls.push(args);return{structuredContent:{error_code:'gateway.unavailable',message:'Recover the saved task'}}}});
 const refresh=h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent==='Check status');
 assert.ok(refresh);await refresh.onclick();await refresh.onclick();
 assert.equal(calls.length,2);assert.equal(calls[1].task_ref,'task');
 assert.match(h.nodes.get('feedback-text').textContent,/Recover the saved task/);
});
test('passive copies of an approved card do not compete with the active card',async()=>{
 let calls=0;const data={...v2Ready,billing:{authorization_active:true,quote_ref:'quote'}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async()=>{calls++;return{structuredContent:data}}});
 await h.tick(350);await h.tick(2000);assert.equal(calls,0);
});

test('choosing a named company resumes an approved plan even after the active watch expired',async()=>{
 const calls=[];const data={...v2Ready,status:'needs_selection',billing:{authorization_active:true,quote_ref:'quote'},context_view:{candidates:[{entity_ref:'mollie',label:'Mollie B.V.',facts:[{type:'company_registry.kvknummer',value:'30204462'}]},{entity_ref:'other',label:'Mollie B.V.',facts:[{type:'company_registry.kvknummer',value:'92327737'}]}]},next_actions:[{action_id:'select',kind:'select_entity'}]};
 const approved={...v2Ready,billing:data.billing};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:args.action_id==='select'?approved:{...approved,status:'succeeded',next_actions:[]}}}});
 await h.tick(350);assert.equal(calls.length,0);
 const choices=h.nodes.get('sections').querySelectorAll('button');assert.ok(choices.some(b=>b.textContent==='Mollie B.V. · KVK 92327737'));
 await choices.find(b=>b.textContent==='Mollie B.V. · KVK 30204462').onclick();await h.tick(350);
 assert.equal(calls.length,2);assert.equal(calls[0].args.input.entity_ref,'mollie');assert.equal(calls[1].args.action_id,'run');assert.ok(calls.every(c=>c.name==='apiosk_execute'));
});

test('annual account fields render nested values without inventing a currency or hiding zero and negative values',async()=>{
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:{...v2Ready,status:'succeeded',next_actions:[],result:{data:{opendataFields:[{key:'FinancialYear',value:'2020'},{key:'IncomeStatement',opendataFields:[{key:'ResultAfterTax',value:'-5166000'},{key:'IncomeTaxExpense',value:0}]}]}}}});
 const rows=h.nodes.get('sections').querySelectorAll('div').filter(n=>n.className==='result-row');
 assert.deepEqual(rows.map(row=>row.children.map(n=>n.textContent)),[['Financial Year','2020'],['Result After Tax','-5,166,000'],['Income Tax Expense','0']]);
});

test('reopening a card restores saved results with one free recovery and never runs a paid step or sends a draft',async()=>{
 const calls=[],messages=[];const saved={...v2Ready,status:'succeeded',billing:{authorization_active:true,quote_ref:'quote',total_charged:'21739'},next_actions:[],result:{data:{name:'Saved company'}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:v2Ready,callTool:async(name,args)=>{calls.push(args);return{structuredContent:saved}},sendFollowUpMessage:value=>messages.push(value)});
 await h.tick(100);await h.tick(350);await h.tick(2000);
 assert.equal(calls.length,1);assert.deepEqual(Object.keys(calls[0]),['task_ref']);assert.equal(h.nodes.get('title').textContent,'Source result');assert.equal(messages.length,0);
});

test('a second host snapshot during mount cannot suppress free task recovery',async()=>{
 const calls=[];const saved={...v2Ready,status:'succeeded',next_actions:[],result:{data:{name:'Saved company'}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:v2Ready,callTool:async(name,args)=>{calls.push(args);return{structuredContent:saved}}});
 await h.globals({toolOutput:{...v2Ready,request_id:'new-host-delivery'}});
 await h.tick(100);
 assert.equal(calls.length,1);assert.deepEqual(Object.keys(calls[0]),['task_ref']);assert.equal(h.nodes.get('title').textContent,'Source result');
});

test('Claude compatibility globals do not enable automatic composer messages after host negotiation',async()=>{
 const messages=[];const h=harness(null,{sendFollowUpMessage:value=>messages.push(value)});await h.initialize('Claude');
 assert.equal(h.window.apiosk.can.autoFollowUp,false);assert.equal(messages.length,0);
});

test('a stalled background recovery cannot block a card action or overwrite its newer response',async()=>{
 const calls=[];let recover;
 const initial={...v2Ready,next_actions:[...v2Ready.next_actions,{action_id:'cancel',kind:'cancel'}]};
 const cancelled={...initial,state:{...initial.state,revision:2},status:'cancelled',next_actions:[]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:initial,callTool:(name,args)=>{calls.push({name,args});return name==='apiosk_status'?new Promise(resolve=>{recover=resolve}):Promise.resolve({structuredContent:cancelled})}});
 await h.tick(100);
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent==='Stop remaining steps').onclick();
 assert.deepEqual(calls.map(c=>c.name),['apiosk_status','apiosk_execute']);
 assert.equal(calls[1].args.action_id,'cancel');assert.equal(h.nodes.get('title').textContent,'Cancelled');
 recover({structuredContent:initial});for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(h.nodes.get('title').textContent,'Cancelled');
});

test('ChatGPT persists its returned result even when the host also supports MCP model context',async()=>{
 const states=[];const h=harness(null,{setWidgetState:v=>states.push(v)});await h.initialize('ChatGPT');
 const saved={...v2Ready,state:{...v2Ready.state,revision:2},status:'succeeded',next_actions:[],result:{data:{FinancialYear:'2020'}}};
 const updating=h.window.apiosk.context(saved);
 assert.equal(states.length,1);assert.equal(states[0].privateContent.apioskResult.result.data.FinancialYear,'2020');
 const context=h.sent.find(m=>m.method==='ui/update-model-context');assert.ok(context);await h.message({jsonrpc:'2.0',id:context.id,result:{}});await updating;
 let calls=0;const reopened=harness(APIO_V2_CARD_HTML,{toolOutput:v2Ready,widgetState:states[0],callTool:async()=>{calls++;return{structuredContent:saved}}});
 assert.equal(reopened.nodes.get('title').textContent,'Source result');
 await reopened.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:v2Ready}});
 assert.equal(reopened.nodes.get('title').textContent,'Source result');await reopened.tick(350);assert.equal(calls,0);await reopened.tick(100);assert.equal(calls,1);
});
test('persisted widget views cannot replace another task or a newer server revision',()=>{
 for(const state of [{state_ref:'another-task',revision:20},{state_ref:'task',revision:0}]){
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:v2Ready,widgetState:{privateContent:{apioskResult:{...v2Ready,state,status:'succeeded',next_actions:[]}}}});
  assert.notEqual(h.nodes.get('title').textContent,'Source result');
 }
});

test('a host returning text blocks without structuredContent preserves the JSON after formatted pricing',async()=>{
 const cancelled={...v2Ready,state:{...v2Ready.state,revision:2},status:'cancelled',next_actions:[]};
 const h=harness(null,{callTool:async()=>({content:[{type:'text',text:'Actual charge so far: 0.00 USD.'},{type:'text',text:JSON.stringify(cancelled)}]})});
 const result=await h.window.apiosk.callTool('apiosk_status',{task_ref:'task'});
 assert.equal(result.status,'cancelled');assert.equal(result.state.revision,2);
});

test('a stale host notification with different request metadata cannot overwrite a locally returned revision',async()=>{
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:v2Ready});
 const saved={...v2Ready,state:{...v2Ready.state,revision:2},status:'succeeded',next_actions:[],result:{data:{name:'Saved company'}}};
 await h.globals({toolOutput:saved});await h.window.apiosk.context(saved);
 await h.globals({toolOutput:{...v2Ready,request_id:'resent-initial-response'}});
 assert.equal(h.nodes.get('title').textContent,'Source result');
});

test('historic token quotes render exact dollars beside the request title and one free result control',async()=>{
 const calls=[]; const data={...v2Ready,status:'succeeded',proposal:{...v2Ready.proposal,max_total_atomic:'97826'},result:{data:{opendataFields:[{key:'FinancialYear',value:'2020'}]}},next_actions:[{action_id:'a',kind:'read_result',label:'Lees het opgeslagen resultaat'},{action_id:'b',kind:'read_result',label:'Lees het opgeslagen resultaat'}]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:data}}});
 const flatten=n=>[n.textContent,...n.children.flatMap(c=>flatten(c))];
 const sections=h.nodes.get('sections'),header=sections.children[0].children[0];
 assert.ok(flatten(header).includes('Data request'));
 assert.ok(flatten(header).includes('0.097826 USD'));
 assert.doesNotMatch(flatten(sections).join(' '),/USDC|Lees het|Your plan/);
 const buttons=sections.querySelectorAll('button').filter(b=>b.textContent==='View saved result');
 assert.equal(buttons.length,1);await buttons[0].onclick();
 assert.deepEqual(calls.map(c=>c.name),['apiosk_status']);assert.equal(calls[0].args.task_ref,'task');
});
