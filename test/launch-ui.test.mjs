import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { APIOSK_UI_BRIDGE } from '../src/ui-bridge.mjs';
import { APIO_V2_CARD_HTML } from '../src/gateway-v2-card.mjs';

const flatten=node=>[node.textContent,...node.children.flatMap(flatten)];

function harness(html=null,openai=null) {
  const sent=[],listeners=new Map(),nodes=new Map(),timers=new Map();let timerId=0;
  const el=(name='div')=>({nodeType:1,tagName:name.toUpperCase(),textContent:'',value:'',disabled:false,dataset:{},children:[],isConnected:true,get lastElementChild(){return this.children.at(-1)},classList:{values:new Set(),add(...values){for(const value of values)this.values.add(value)},remove(...values){for(const value of values)this.values.delete(value)},toggle(value,force){const enabled=force===undefined?!this.values.has(value):force;enabled?this.values.add(value):this.values.delete(value);return enabled},contains(value){return this.values.has(value)}},append(...c){this.children.push(...c)},prepend(...c){this.children.unshift(...c)},replaceChildren(...c){this.children=c},querySelector(selector){return this.querySelectorAll(selector)[0]},querySelectorAll(selector){return this.children.flatMap(c=>[...(selector.split(',').some(s=>s.startsWith('.')?(c.className||'').split(' ').includes(s.slice(1)):s===c.tagName.toLowerCase())?[c]:[]),...c.querySelectorAll(selector)])},setAttribute(name,value){this[name]=value},focus(){},addEventListener(name,fn){this['on'+name]=fn},reportValidity(){return !this.required||this.value!==''}});
  // Match DOM move semantics: appending a node reparents it, never duplicates it.
  const element=name=>Object.assign(el(name),{
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null},
    append(...children){for(const child of children){child.remove?.();child.parentElement=this;this.children.push(child)}},
    prepend(...children){for(const child of [...children].reverse()){child.remove?.();child.parentElement=this;this.children.unshift(child)}},
    replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children)},
    after(){},
  });
  const document={documentElement:{scrollWidth:320,scrollHeight:200,dataset:{},style:{}},getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},createElement:element};
  const parent={postMessage(m){sent.push(m)}};
  const window={parent,openai,addEventListener(n,fn){listeners.set(n,fn)}};
  const ctx=vm.createContext({window,document,URL,Intl,console,EventSource:openai?.EventSource,setInterval:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms,repeat:true});return id},clearInterval(id){timers.delete(id)},setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},ResizeObserver:class{observe(){}}});
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
      if(!entry[1].repeat)timers.delete(entry[0]);entry[1].fn();
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

test('CBS live result card shows decoded annual figures and keeps complete JSON collapsed',async()=>{
  const data=JSON.parse(readFileSync(new URL('./fixtures/cbs-annual-ui.json',import.meta.url)));
  Object.assign(data,{status:'succeeded',state:{state_ref:'saved-cbs'},result:data.context_view.results.at(-1)});
  const h=harness(APIO_V2_CARD_HTML);await h.initialize();
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:data}});
  const sections=h.nodes.get('sections'),tables=sections.querySelectorAll('table');
  assert.equal(tables.length,1);
  const values=tables[0].querySelectorAll('td').map(n=>n.textContent);
  assert.ok(values.includes('128,6'));assert.ok(values.includes('6,9'));
  assert.ok(values.includes('2024'));assert.ok(values.includes('2025'));
  assert.ok(values.includes('Definitief'));assert.ok(values.includes('2021=100'));
  assert.equal(sections.querySelectorAll('pre').length,1);
  assert.ok(sections.querySelectorAll('p').some(n=>n.textContent==='+6,9%'));
  assert.ok(sections.querySelectorAll('details').some(n=>!n.open&&n.querySelectorAll('table').length===1));
  assert.ok(!sections.querySelectorAll('button').some(n=>n.textContent==='Check status'));
  assert.ok(sections.querySelectorAll('details').some(n=>!n.open&&n.querySelectorAll('pre').length===1));
  assert.ok(sections.querySelectorAll('button').some(n=>n.textContent==='Bron bekijken'));
  assert.equal(h.sent.filter(m=>m.method==='tools/call').length,0);
});

test('MCP Apps negotiates the current protocol and accepts only its parent frame',async()=>{
  const h=harness();const init=h.sent[0];
  assert.equal(init.method,'ui/initialize');assert.equal(init.params.protocolVersion,'2026-01-26');assert.equal(init.params.appInfo.name,'Apiosk');
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{answer:'forged'}}},{});
  assert.equal(h.window.apiosk.data,null);
  await h.initialize();assert.ok(h.sent.some(m=>m.method==='ui/notifications/initialized'));
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{answer:'verified'}}});
  assert.equal(h.window.apiosk.data.answer,'verified');
});

test('supplier answer precedes one collapsed source group and opening it never purchases',async()=>{
  const data=JSON.parse(readFileSync(new URL('./fixtures/uk-supplier-ui.json',import.meta.url)));
  Object.assign(data.context_view.results[0].data,{items_per_page:10,page_number:1,start_index:0});
  const calls=[],h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(...args)=>{calls.push(args);return {structuredContent:data}}});
  const sections=h.nodes.get('sections');
  assert.equal(h.nodes.get('title').textContent,'Supplier verification');
  assert.ok(flatten(sections.children[0]).includes('Not fully verified'));
  assert.ok(flatten(sections.children[0]).includes('Not verified · no validation result'));
  assert.equal(sections.children[0].querySelectorAll('.result-row').length,0);
  const disclosure=sections.querySelector('.source-results-toggle');
  assert.equal(disclosure.open,false);
  assert.equal(disclosure.children[0].textContent,'Sources and details · 4 sources · 8 results');
  assert.equal(disclosure.querySelector('.source-results-list').children.length,4,'one collapsed row per provider');
  const companyRow=disclosure.querySelector('.source-result-summary');
  assert.deepEqual(companyRow.children.map(node=>flatten(node).join('')),['C','Companies House','Kindsearch#companies','Results9','Items per page10','Page number1','Start index0']);
  assert.ok(disclosure.querySelectorAll('.source-result-group').every(group=>!group.open));
  assert.equal(disclosure.querySelectorAll('pre').length,8,'every original source response is retained');
  assert.ok(flatten(disclosure).includes('VAT remains unverified because no UK VAT candidate was found.'));
  // As in the App: no document was asked for, so the report waits in details.
  assert.ok(!sections.children[0].querySelectorAll('button').some(b=>b.textContent==='Download PDF'));
  assert.ok(disclosure.querySelectorAll('button').some(b=>b.textContent==='Download PDF'));
  disclosure.open=true;disclosure.ontoggle();
  assert.equal(calls.length,0);
  await h.globals({toolOutput:{...data,state:{...data.state,revision:10}}});
  assert.equal(sections.querySelector('.source-results-toggle').open,true,'free refresh preserves the open state');
  const current=sections.querySelector('.source-results-toggle');current.open=false;current.ontoggle();
  await h.globals({toolOutput:{...data,state:{...data.state,revision:11}}});
  assert.equal(sections.querySelector('.source-results-toggle').open,false);
  assert.equal(calls.length,0);
});

test('generic research also puts the supplied answer before collapsed source records',()=>{
  const data={status:'partial',state:{state_ref:'generic'},context_view:{analysis:{status:'partial',observations:[{text:'Source-backed answer',evidence:[]}],limitations:['Important missing coverage']},results:[{source:{name:'Registry'},data:{name:'Company',count:0}}]},next_actions:[]};
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data}),sections=h.nodes.get('sections');
  assert.ok(flatten(sections.children[0]).includes('Source-backed answer'));
  assert.ok(flatten(sections.children[0]).includes('Important missing coverage'));
  assert.equal(sections.querySelector('.source-results-toggle').open,false);
  assert.equal(sections.querySelectorAll('.result-row').length,2);
});

test('result headings, summaries and source fields remain inert text',()=>{
  const data=JSON.parse(readFileSync(new URL('./fixtures/uk-supplier-ui.json',import.meta.url)));
  const hostile='<img src=x onerror="alert(1)">';data.context_view.results[1].data.company_name=hostile;
  data.context_view.results[1].data.company_status=hostile;
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data}),sections=h.nodes.get('sections');
  assert.ok(flatten(sections.children[0]).includes(hostile));
  assert.equal(sections.querySelectorAll('img').length,0);
});

test('host tool cancellation preserves the durable task snapshot and recovery identity',async()=>{
  const h=harness();await h.initialize();
  const running={status:'running',state:{state_ref:'saved-task',revision:4},context_view:{worker_active:true}};
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:running}});
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-cancelled',params:{reason:'host stopped waiting'}});
  assert.deepEqual(h.window.apiosk.data,running);
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
  const flatten=n=>[n.textContent,...n.children.flatMap(c=>flatten(c))];
  assert.equal(planSection.children[0].children[0].textContent,'Your plan');
  assert.ok(flatten(planSection).includes('Approve up to 0.097826 USD'));
  assert.ok(flatten(planSection).includes('Details'));
  assert.ok(!flatten(planSection).includes('pending'));
  assert.equal(plan.nodes.get('status-pill').textContent,'Approval needed');
  assert.equal(plan.nodes.get('subtitle').textContent,'Review the sources and maximum total before approving.');
});

test('workspace tasks use one status header without identity and retain scoped shortcuts',async()=>{
  const opened=[];
  const data={...v2Ready,context_view:{...v2Ready.context_view,workspace:{kind:'workspace',workspace_id:'workspace',name:'Risk Desk',organisation_name:'Northwind'},navigation:{balance_url:'https://app.apiosk.com/settings/billing?workspace=workspace',history_url:'https://app.apiosk.com/usage/history?workspace=workspace'}},billing:{...v2Ready.billing,workspace:{kind:'workspace',workspace_id:'workspace',name:'Risk Desk',organisation_name:'Northwind'}}};
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,openExternal:({href})=>opened.push(href)});
  assert.doesNotMatch(APIO_V2_CARD_HTML,/account-name|account-org|account-bar|\.card\.plan-mode>\.shell\{display:none\}/);
  assert.equal((APIO_V2_CARD_HTML.match(/<header\b/g)||[]).length,1);
  assert.match(APIO_V2_CARD_HTML,/<header[^>]*>[\s\S]*id="title"[\s\S]*id="account-shortcuts"[\s\S]*<\/header>/);
  assert.equal(h.nodes.get('account-shortcuts').classList.contains('hidden'),false);
  await h.nodes.get('balance-shortcut').onclick();await h.nodes.get('history-shortcut').onclick();
  assert.deepEqual(opened,['https://app.apiosk.com/settings/billing?workspace=workspace','https://app.apiosk.com/usage/history?workspace=workspace']);
});

test('personal tasks hide account identity and reject off-origin shortcuts',async()=>{
  const data={...v2Ready,context_view:{...v2Ready.context_view,workspace:{kind:'personal',workspace_id:null},navigation:{balance_url:'https://attacker.example/settings/billing',history_url:'javascript:alert(1)'}}};
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,openExternal:()=>{throw new Error('must not open')}});
  assert.equal(h.nodes.get('account-shortcuts').classList.contains('hidden'),true);
  assert.equal(h.nodes.get('balance-shortcut').onclick,null);
  assert.equal(h.nodes.get('history-shortcut').onclick,null);
});

test('input-needed uses the request status as its header and rejects unsafe workspace links',async()=>{
  const data={...v2Ready,status:'needs_input',proposal:null,context_view:{workspace:{kind:'workspace',workspace_id:'workspace',name:'Testing Group',organisation_name:'Testing Org.'},navigation:{balance_url:'https://attacker.example/settings/billing',history_url:'javascript:alert(1)'},clarification:{message:'Which VAT number should be checked?'}}};
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data});
  assert.equal(h.nodes.get('title').textContent,'Input needed');
  assert.equal(h.nodes.get('subtitle').textContent,'More information is needed to prepare your request.');
  assert.equal(h.nodes.get('account-shortcuts').classList.contains('hidden'),true);
  assert.equal(h.nodes.get('balance-shortcut').onclick,null);
  assert.equal(h.nodes.get('history-shortcut').onclick,null);
});

test('the source list says what can be executed, not how much is listed',async()=>{
  // A seller with 980 registered endpoints and 34 accepted contracts must not
  // read as the biggest source on the card, and a source whose resale is not
  // authorized must not read as available. Readiness is what the gateway sends
  // for this; absent readiness must not fall back to a registered count.
  const h=harness(APIO_V2_CARD_HTML);await h.initialize();
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{protocol_version:'2',total:4,offset:0,next_offset:null,sources:[
    {name:'Registry',category:'company data',endpoint_count:3,capabilities:['company.profile']},
    {name:'EODHD Market Data',category:'finance',readiness:{status:'blocked',contracts:{registered_endpoints:60,supported_endpoints:0}}},
    {name:'x402 Endpoints',category:'registers',readiness:{status:'discovery-only',contracts:{registered_endpoints:52,supported_endpoints:0}}},
    {name:'PulseNetwork',category:'intelligence',readiness:{status:'partially-supported',contracts:{registered_endpoints:980,supported_endpoints:34}}}]}}});
  const counts=h.nodes.get('sections').querySelectorAll('.count');
  assert.deepEqual(counts.map(c=>c.textContent),['Availability unknown','Not purchasable','Not executable','34 available functions']);
  assert.deepEqual(counts.map(c=>c.className),['count','count unavailable','count unavailable','count']);
});

test('conversation messages use content blocks and honor host rejection',async()=>{
  const h=harness();await h.initialize();const promise=h.window.apiosk.say('Please continue');
  const message=h.sent.find(m=>m.method==='ui/message');
  assert.equal(message.params.content[0].type,'text');assert.equal(message.params.content[0].text,'Please continue');
  await h.message({jsonrpc:'2.0',id:message.id,result:{isError:true}});assert.equal(await promise,false);
  assert.equal(await h.window.apiosk.openLink('javascript:alert(1)'),false);
});

const v2Ready={status:'ready',state:{state_ref:'task',revision:1},proposal:{quote_ref:'quote',expires_at:'2099-01-01',currency:'USDC',max_total_atomic:'21739',approval_url:'https://app.apiosk.com/gateway-v2?task=task',steps:['company.search']},context_view:{execution_enabled:true},billing:{authorization_active:false,quote_ref:'quote'},next_actions:[{action_id:'run',kind:'execute_quoted_step'}]};
test('EUR card approval, live completion and balance display retain the original micro USD authorization',async()=>{
 const calls=[];
 const data={...v2Ready,context_view:{execution_enabled:true,approval_mode:'chatbot',money_display:{base_currency:'USD',currency:'EUR',rate:'0.92000000'}},proposal:{...v2Ready.proposal,max_total_atomic:'114446'}};
 const approved={...data,billing:{...data.billing,authorization_active:true}};
 const done={...approved,status:'succeeded',state:{...data.state,revision:3},next_actions:[],billing:{...approved.billing,currency:'USD',total_charged:'23000',balance_available:'12986468'},result:{data:{name:'Saved result'}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:name==='apiosk_approve'?approved:done}}});
 const button=h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to'));
 assert.equal(button.textContent,'Approve up to 0.105291 EUR');
 await button.onclick();await h.tick(350);
 assert.equal(calls[0].args.max_total_atomic,'114446');
 assert.equal(calls[0].args.quote_ref,'quote');
 assert.deepEqual(calls.map(c=>c.name),['apiosk_approve','apiosk_execute']);
 const visible=h.nodes.get('sections').querySelectorAll('b,strong,summary,p').map(n=>n.textContent).join(' ');
 assert.match(visible,/0.02116 EUR/);assert.match(visible,/11.947551 EUR/);assert.doesNotMatch(visible,/USD|USDC/);
});
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
test('Gateway errors-array approval refusal is shown verbatim and never executes or retries',async()=>{
 const message='Approval could not be saved. Check the connection spending limits.';
 const calls=[];const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name)=>{calls.push(name);return {isError:true,structuredContent:{protocol_version:'2',status:'failed',state:null,errors:[{code:'approval_refused',message}],next_actions:[]}}}});
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 assert.equal(h.nodes.get('feedback-text').textContent,message);
 await h.tick(350);await h.tick(2000);
 assert.deepEqual(calls,['apiosk_approve']);
 assert.ok(h.nodes.get('sections').querySelectorAll('button').some(b=>b.textContent==='Check status'));
});
test('approval budget messages show the required amount and the blocked limit in account currency',async()=>{
 for(const [code,available,fragment] of [
  ['approval_per_request_limit','271739','allows 0.25 EUR per request'],
  ['approval_daily_limit','86956','0.08 EUR left in its daily budget'],
  ['approval_balance_insufficient','86956','available Apiosk balance is 0.08 EUR'],
 ]){
  const calls=[];
  const data={...v2Ready,context_view:{approval_mode:'chatbot',money_display:{base_currency:'USD',currency:'EUR',rate:'0.92000000'}}};
  const response={errors:[{code,message:'Safe budget explanation',details:{required_atomic:'881698',available_atomic:available,currency:'USD'}}]};
  const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async name=>{calls.push(name);return {isError:true,structuredContent:response}}});
  const button=h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to'));
  await button.onclick();
  const message=h.nodes.get('feedback-text').textContent;
  assert.ok(message.includes('up to 0.811163 EUR'));
  assert.ok(message.includes(fragment));
  assert.ok(message.includes('ask a smaller question'));
  assert.ok(message.includes('Nothing was purchased by this approval attempt.'));
  assert.doesNotMatch(message,/USD|micro|Approval was not confirmed/);
  assert.equal(button.disabled,false);
  await h.tick(350);await h.tick(2000);
  assert.deepEqual(calls,['apiosk_approve']);
 }
});
test('Claude also shows actionable EUR budget feedback without executing or drafting a message',async()=>{
 const h=harness(APIO_V2_CARD_HTML);await h.initialize('Claude');
 const data={...v2Ready,context_view:{approval_mode:'chatbot',money_display:{base_currency:'USD',currency:'EUR',rate:'0.92000000'}}};
 await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:data}});
 const clicking=h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 const call=h.sent.find(m=>m.method==='tools/call');
 assert.equal(call.params.name,'apiosk_approve');
 await h.message({jsonrpc:'2.0',id:call.id,result:{isError:true,structuredContent:{errors:[{code:'approval_daily_limit',message:'Daily budget exceeded',details:{required_atomic:'881698',available_atomic:'86956',currency:'USD'}}]}}});
 await clicking;
 assert.match(h.nodes.get('feedback-text').textContent,/0.08 EUR left in its daily budget/);
 assert.match(h.nodes.get('feedback-text').textContent,/Set a higher daily limit below/);
 const limits=h.nodes.get('feedback-actions').querySelectorAll('button').find(b=>b.textContent==='Set higher limits');
 assert.ok(limits);
 const opening=limits.onclick();
 const open=h.sent.find(m=>m.method==='ui/open-link');
 assert.equal(open.params.url,'https://app.apiosk.com/connections');
 await h.message({jsonrpc:'2.0',id:open.id,result:{}});await opening;
 assert.ok(h.nodes.get('feedback-actions').querySelectorAll('p').some(p=>p.textContent.includes('Or reconnect Apiosk')));
 await h.tick(350);await h.tick(2000);
 assert.equal(h.sent.filter(m=>m.method==='tools/call').length,1);
 assert.equal(h.sent.some(m=>m.method==='ui/message'),false);
});
test('an uncertain approval never claims that nothing was purchased',async()=>{
 const calls=[];const message='We could not confirm your approval yet. Use Check status to recover your saved request before trying again.';
 const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async name=>{calls.push(name);return {isError:true,structuredContent:{errors:[{code:'approval_unconfirmed',message}]}}}});
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 assert.equal(h.nodes.get('feedback-text').textContent,message);
 assert.doesNotMatch(h.nodes.get('feedback-text').textContent,/Nothing was purchased/);
 assert.equal(h.nodes.get('feedback-actions').querySelectorAll('button').length,0);
 await h.tick(350);await h.tick(2000);assert.deepEqual(calls,['apiosk_approve']);
});
test('Set higher limits opens existing connection settings without reconnecting or purchasing',async()=>{
 const calls=[],links=[];const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
 const response={errors:[{code:'approval_per_request_limit',message:'Increase your limit.'}]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,openExternal:value=>links.push(value.href),callTool:async name=>{calls.push(name);return {isError:true,structuredContent:response}}});
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 const actions=h.nodes.get('feedback-actions');
 const button=actions.querySelectorAll('button').find(b=>b.textContent==='Set higher limits');
 await button.onclick();
 assert.deepEqual(links,['https://app.apiosk.com/connections']);
 assert.deepEqual(calls,['apiosk_approve']);
 assert.ok(actions.querySelectorAll('p').some(p=>p.textContent.includes('new connection')));
 await h.tick(350);await h.tick(2000);assert.deepEqual(calls,['apiosk_approve']);
});
test('a host that cannot open settings gives clear manual guidance instead of a dead button',async()=>{
 const calls=[];const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,openExternal:()=>{throw Error('blocked')},callTool:async name=>{calls.push(name);return {isError:true,structuredContent:{errors:[{code:'approval_daily_limit',message:'Increase your daily limit.'}]}}}});
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 await h.nodes.get('feedback-actions').querySelectorAll('button')[0].onclick();
 assert.ok(h.nodes.get('feedback-actions').querySelectorAll('p').some(p=>p.textContent.startsWith('Open Apiosk > Integrations')));
 assert.deepEqual(calls,['apiosk_approve']);
});
test('balance errors do not suggest higher connection limits or reconnecting',async()=>{
 const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async()=>({isError:true,structuredContent:{errors:[{code:'approval_balance_insufficient',message:'Add funds.'}]}})});
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 assert.equal(h.nodes.get('feedback-actions').children.length,0);
});
test('after correcting a budget the saved plan can be approved once and complete without a new question',async()=>{
 const calls=[];let approvals=0;
 const data={...v2Ready,context_view:{approval_mode:'chatbot'}};
 const approved={...data,billing:{authorization_active:true,quote_ref:data.proposal.quote_ref}};
 const done={...approved,status:'succeeded',next_actions:[],result:{data:{name:'Anthropic Limited'}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{
  calls.push({name,args});
  if(name==='apiosk_status')return {structuredContent:data};
  if(name==='apiosk_approve')return ++approvals===1
   ? {isError:true,structuredContent:{errors:[{code:'approval_per_request_limit',message:'Increase your connection limit.'}]}}
   : {structuredContent:approved};
  return {structuredContent:done};
 }});
 const approve=()=>h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent.startsWith('Approve up to')).onclick();
 await approve();await h.tick(350);assert.equal(calls.length,1);
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent==='Check status').onclick();
 assert.equal(calls.filter(c=>c.name==='apiosk_approve').length,1);
 await approve();await h.tick(350);
 assert.deepEqual(calls.map(c=>c.name),['apiosk_approve','apiosk_status','apiosk_approve','apiosk_execute']);
 assert.deepEqual(calls[0].args,calls[2].args);
 assert.equal(h.nodes.get('title').textContent,'Source result');
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
 assert.match(messages[0].prompt,/only a brief conclusion and source citation/);
 assert.match(messages[0].prompt,/Do not repeat the card's figures, tables, JSON, charges/);
 assert.match(messages[0].prompt,/only when the actual user explicitly asks/);
 assert.doesNotMatch(messages[0].prompt,/Include actual charges and any missing data/);
 assert.equal(await h.tick(350),false);
});
test('v2 card restores a KVK countdown and continues the approved second report with both results',async()=>{
 const calls=[];
 const first={subject:{label:'HEMA'},data:{year:'2025'}},second={subject:{label:'AFAS'},data:{year:'2024'}};
 const approved={...v2Ready,billing:{...v2Ready.billing,authorization_active:true},result:first,context_view:{results:[first]}};
 const waiting={...approved,status:'running',retry_after_ms:60000,next_actions:[{kind:'poll',action_id:'wait'}],context_view:{results:[first],cooldown:{until:new Date(Date.now()+60000).toISOString(),message:'KVK allows one annual-accounts request per minute.'}}};
 const done={...approved,status:'succeeded',next_actions:[],result:second,context_view:{results:[first,second],analysis:{status:'completed',observations:[],limitations:['Reporting periods differ.']}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:waiting,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:args.action_id==='wait'?approved:done}}});
 const allText=()=>h.nodes.get('sections').querySelectorAll('h3,p').map(n=>n.textContent).join(' ');
 assert.match(allText(),/Result · HEMA/);assert.match(allText(),/Next annual report in (1:00|0:59)/);
 assert.equal(calls.length,0);
 await h.tick(60000);await h.tick(350);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.name==='apiosk_execute'));
 assert.equal(calls[1].args.quote_ref,'quote');
 assert.match(allText(),/Result · HEMA/);assert.match(allText(),/Result · AFAS/);assert.match(allText(),/Reporting periods differ/);
});
test('v2 card labels generic source waits without claiming KVK',()=>{
 const waiting={...v2Ready,status:'running',next_actions:[],context_view:{execution_mode:'server',worker_active:true,cooldown:{until:new Date(Date.now()+60000).toISOString(),message:'Waiting for the source request to finish.'}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:waiting});
 const text=h.nodes.get('sections').querySelectorAll('h3,p').map(n=>n.textContent).join(' ');
 assert.match(text,/Waiting for the source/);assert.match(text,/Checking again in/);
 assert.doesNotMatch(text,/KVK|annual report/);
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
 const flatten=n=>[n.textContent,...n.children.flatMap(c=>flatten(c))];
 const choices=h.nodes.get('sections').querySelectorAll('button');assert.ok(choices.some(b=>flatten(b).includes('Mollie B.V.')&&flatten(b).includes('KVK 92327737')));
 await choices.find(b=>flatten(b).includes('KVK 30204462')).onclick();await h.tick(350);
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
 await h.nodes.get('sections').querySelectorAll('button').find(b=>b.textContent==='Cancel request').onclick();
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

test('historic token quotes render exact dollars without a redundant saved-result control',async()=>{
 const calls=[]; const data={...v2Ready,status:'succeeded',proposal:{...v2Ready.proposal,max_total_atomic:'97826'},result:{data:{opendataFields:[{key:'FinancialYear',value:'2020'}]}},next_actions:[{action_id:'a',kind:'read_result',label:'Lees het opgeslagen resultaat'},{action_id:'b',kind:'read_result',label:'Lees het opgeslagen resultaat'}]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:data}}});
 const flatten=n=>[n.textContent,...n.children.flatMap(c=>flatten(c))];
 const sections=h.nodes.get('sections'),header=sections.children[0].children[0];
 assert.ok(flatten(header).includes('Result'));
 assert.ok(!flatten(header).includes('0.097826 USD'));
 assert.doesNotMatch(flatten(sections).join(' '),/USDC|Lees het|Your plan/);
 const buttons=sections.querySelectorAll('button').filter(b=>b.textContent==='View saved result');
 assert.equal(buttons.length,0,'the rendered result already has its disclosure; no redundant refresh button');
 assert.equal(calls.length,0);
});

test('annual report download opens the saved PDF without a paid tool call',async()=>{
 const opened=[],calls=[];
 const url='https://apiosk-gateway-v2.fly.dev/v2/tasks/task/results/result/report.pdf?signature=fixture';
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:{...v2Ready,status:'succeeded',next_actions:[],result:{data:{opendataFields:[]},report:{format:'pdf',url}}},openExternal:({href})=>opened.push(href),callTool:async(...args)=>calls.push(args)});
 const button=h.nodes.get('sections').querySelectorAll('button').find(n=>n.textContent==='Download PDF');
 assert.ok(button); await button.onclick();
 assert.deepEqual(opened,[url]); assert.deepEqual(calls,[]);
});

 test('failed requests never claim to be up to date',async()=>{
  const h=harness(APIO_V2_CARD_HTML);await h.initialize();
  await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{protocol_version:'2',status:'failed',errors:[{code:'question_unavailable',message:'The question could not be processed.'}],next_actions:[]}}});
  assert.equal(h.nodes.get('subtitle').textContent,'Your request could not be completed.');
 });

test('server execution streams results and never asks the card to execute provider steps',async()=>{
 const calls=[],streams=[];
 class Events { constructor(url){this.url=url;streams.push(this)} addEventListener(name,fn){this[name]=fn} close(){this.closed=true} }
 const running={...v2Ready,status:'running',context_view:{execution_mode:'server',worker_active:true,events_url:'https://api.apiosk.com/v2/tasks/task/events?signature=fixture'},billing:{authorization_active:true,quote_ref:'quote'},next_actions:[]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:running,EventSource:Events,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:running}}});
 assert.equal(streams.length,1);
 const done={...running,status:'succeeded',state:{...running.state,revision:2},context_view:{...running.context_view,worker_active:false},result:{data:{answer:'Saved source result'}}};
 streams[0].task({data:JSON.stringify(done)});
 for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(streams[0].closed,true);
 assert.equal(calls.length,0);
 assert.equal(h.nodes.get('title').textContent,'Source result');
 assert.ok(!h.nodes.get('sections').querySelectorAll('button').some(b=>/Approve|Continue|Run next/.test(b.textContent)));
});

test('source cards keep Pulse services nested and render every source in the page',async()=>{
 const h=harness(APIO_V2_CARD_HTML);await h.initialize();
 const pulse={slug:'pulsenetwork',name:'Pulse Network',service_count:87,matching_service_count:2,services:[{slug:'taxpulse',name:'TaxPulse',description:'Tax data'},{slug:'legalpulse',name:'LegalPulse',description:'Legal data'}]};
 const sources=[pulse,...Array.from({length:19},(_,i)=>({slug:'source-'+i,name:'Source '+i,endpoint_count:1}))];
 await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{protocol_version:'2',total:26,offset:0,next_offset:20,sources}}});
 assert.equal(h.nodes.get('title').textContent,'26 matching sources');
 assert.equal(h.nodes.get('sections').querySelectorAll('.source').length,20);
 const names=h.nodes.get('sections').querySelectorAll('.source-name').map(n=>n.textContent);
 assert.equal(names.filter(n=>n==='Pulse Network').length,1);
 assert.ok(!names.includes('TaxPulse'));
 assert.equal(h.nodes.get('sections').querySelectorAll('.source-service').length,2);
 assert.equal(h.nodes.get('sections').querySelectorAll('.count')[0].textContent,'87 services');
});

test('a single matching service stays within its parent source',async()=>{
 const h=harness(APIO_V2_CARD_HTML);await h.initialize();
 await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{protocol_version:'2',total:1,offset:0,next_offset:null,sources:[{slug:'pulsenetwork',name:'Pulse Network',service_count:76,matching_service_count:1,services:[{slug:'taxpulse',name:'TaxPulse'}]}]}}});
 assert.equal(h.nodes.get('title').textContent,'1 matching source');
 assert.equal(h.nodes.get('sections').querySelectorAll('summary')[0].textContent,'View 1 service');
});


test('missing input names the requested field and submits only the entered value',async()=>{
 const calls=[];
 const data={status:'needs_input',state:{state_ref:'task',revision:1},context_view:{},next_actions:[{kind:'supply_input',action_id:'query',label:'Provide web.query',input_schema:{properties:{value:{type:'string'}}}}]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:data}}});
 const sections=h.nodes.get('sections'),form=sections.querySelector('form'),field=form.querySelector('input');
 assert.ok(flatten(sections).includes('Search query'));
 assert.ok(flatten(sections).includes('What should the web search look for?'));
 assert.equal(field['aria-label'],'Search query');
 assert.equal(form.className,'field actions');
 assert.equal(form.querySelector('button').className,'quiet');
 await form.onsubmit({preventDefault(){}});assert.equal(calls.length,0);
 field.value='ASML Holding N.V.';await form.onsubmit({preventDefault(){}});
 assert.equal(calls[0].name,'apiosk_execute');
 assert.equal(calls[0].args.input.value,'ASML Holding N.V.');
 assert.equal(Object.keys(calls[0].args.input).length,1);
 assert.equal(calls[0].args.action_id,'query');
});

test('missing input uses schema help and never presents an unidentified field',()=>{
 const data={status:'needs_input',state:{state_ref:'task',revision:1},next_actions:[{kind:'supply_input',label:'Provide vat.number',input_schema:{properties:{value:{type:'string',title:'VAT number',description:'Which VAT number should be checked?',examples:['NL123456789B01']}}}}]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data});
 assert.ok(flatten(h.nodes.get('sections')).includes('Which VAT number should be checked?'));
 assert.equal(h.nodes.get('sections').querySelector('input').placeholder,'For example: NL123456789B01');
 const unknown=harness(APIO_V2_CARD_HTML,{toolOutput:{...data,next_actions:[{kind:'supply_input',input_schema:{}}]}});
 assert.equal(unknown.nodes.get('sections').querySelectorAll('input').length,0);
 assert.ok(flatten(unknown.nodes.get('sections')).includes('The request did not identify the missing detail. Use Check status to reload the saved request.'));
});

test('an idle clarification displays its question, accepts only user input and always offers status recovery',async()=>{
 const calls=[],streams=[];
 class Events {constructor(){streams.push(this)} close(){} addEventListener(){}}
 const data={status:'needs_input',state:{state_ref:'task',revision:1},context_view:{execution_mode:'server',worker_active:false,events_url:'https://api.apiosk.com/v2/tasks/task/events',conversation:[{question:'Compare construction revenue',reply:'Which period should be compared?'}]},next_actions:[]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,EventSource:Events,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:data}}});
 assert.equal(streams.length,0);assert.equal(calls.length,0);
 assert.ok(h.nodes.get('sections').querySelectorAll('p').some(n=>n.textContent==='Which period should be compared?'));
 const form=h.nodes.get('sections').querySelector('form'),field=form.querySelector('input');
 await form.onsubmit({preventDefault(){}});assert.equal(calls.length,0);
 field.value='2025 versus 2024';await form.onsubmit({preventDefault(){}});
 assert.equal(calls[0].name,'apiosk_discover');assert.equal(calls[0].args.request_id,undefined);
 assert.match(calls[0].args.question,/Compare construction revenue\n\nUser clarification: 2025 versus 2024/);
 await h.nodes.get('sections').querySelectorAll('button').find(n=>n.textContent==='Check status').onclick();
 assert.equal(calls[1].name,'apiosk_status');assert.deepEqual(Object.keys(calls[1].args),['task_ref']);
});

test('interrupted live updates recover saved state and stale stream errors cannot overwrite completion',async()=>{
 const calls=[],streams=[];
 class Events {constructor(){streams.push(this)} addEventListener(name,fn){this[name]=fn} close(){this.closed=true}}
 const running={...v2Ready,status:'running',context_view:{execution_mode:'server',worker_active:true,events_url:'https://api.apiosk.com/v2/tasks/task/events'},next_actions:[]};
 const done={...running,status:'succeeded',state:{state_ref:'task',revision:2},context_view:{...running.context_view,worker_active:false},result:{data:{answer:'Saved'}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:running,EventSource:Events,callTool:async(name,args)=>{calls.push({name,args});return{structuredContent:done}}});
 streams[0].onerror();assert.equal(streams[0].closed,true);
 await h.tick(2000);assert.equal(calls.length,1);assert.equal(calls[0].name,'apiosk_status');
 assert.equal(h.nodes.get('title').textContent,'Source result');assert.equal(streams.length,1);
 const feedback=h.nodes.get('feedback').textContent;streams[0].onerror();assert.equal(h.nodes.get('feedback').textContent,feedback);
});

test('company names use readable casing throughout the card without changing selection identity or source JSON', async () => {
 const raw='ORION BEHEER BV',entity='ORION-REF';
 const result={subject:{label:raw},source:{name:'KVK'},data:{resultaten:[{naam:raw,kvkNummer:'01234567',adres:{binnenlandsAdres:{plaats:'AMSTERDAM'}}}]}};
 const data={...v2Ready,status:'needs_selection',context_view:{candidates:[{entity_ref:entity,label:raw,facts:[{type:'company.name',value:raw}]}]},next_actions:[{action_id:'select',kind:'select_entity'}]};
 const before=JSON.stringify(data),calls=[];
 const completed={...v2Ready,status:'succeeded',proposal:{...v2Ready.proposal,step_details:[{subject:raw,source:{name:'KVK'}}]},next_actions:[],result,context_view:{analysis:{status:'completed',limitations:[],observations:[{text:raw+' is registered.',evidence:[{pointer:'/data/resultaten/0/naam',value:raw}]}]}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:data,callTool:async(name,args)=>{calls.push(args);return{structuredContent:completed}}});
 const flatten=node=>[node.textContent,...node.children.flatMap(flatten)];
 const choice=h.nodes.get('sections').querySelectorAll('button').find(button=>flatten(button).includes('Orion Beheer BV'));
 assert.ok(choice);await choice.onclick();
 assert.equal(calls[0].input.entity_ref,entity);assert.equal(JSON.stringify(data),before);
 const rendered=flatten(h.nodes.get('sections'));
 assert.ok(rendered.includes('Result · Orion Beheer BV'));
 assert.ok(rendered.includes('Orion Beheer BV is registered.'));
 assert.ok(rendered.includes('Orion Beheer BV'));
 const cells=h.nodes.get('sections').querySelectorAll('td').map(n=>n.textContent);
 assert.deepEqual(cells,['Orion Beheer BV','01234567','Amsterdam']);
 assert.ok(h.nodes.get('sections').querySelectorAll('pre').some(node=>node.textContent.includes(raw)));
 assert.equal(result.data.resultaten[0].naam,raw);
});

test('evidence bundle download opens the saved archive without calling a paid tool',async()=>{
 const opened=[],calls=[];
 const evidence_url='https://apiosk-gateway-v2.fly.dev/v2/tasks/task/reports/quote/evidence.zip?signature=fixture';
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:{...v2Ready,status:'succeeded',next_actions:[],context_view:{report:{format:'pdf',evidence_url}},result:{data:{name:'Example'}}},openExternal:({href})=>opened.push(href),callTool:async(...args)=>calls.push(args)});
 const button=h.nodes.get('sections').querySelectorAll('button').find(n=>n.textContent==='Download evidence');
 assert.ok(button); await button.onclick(); assert.deepEqual(opened,[evidence_url]);assert.deepEqual(calls,[]);
});

test('the card carries the App tokens for both themes and its type rules',()=>{
 const css=APIO_V2_CARD_HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
 assert.doesNotMatch(css,/CanvasText|Canvas\b|color-mix|monospace|uppercase/);
 assert.match(css,/:root\{[^}]*--card:oklch\(1 0 0\)[^}]*--foreground:#303036/);
 assert.match(css,/:root\[data-theme=dark\]\{[^}]*--card:oklch\(\.185 \.015 265\)[^}]*--danger-fg:#fda4af/);
 assert.match(css,/@media\(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{[^}]*--foreground:oklch\(\.925 \.008 265\)/);
 assert.deepEqual([...new Set([...css.matchAll(/font-size:(\d+)px/g)].map(m=>Number(m[1])))].sort((a,b)=>a-b),[12,14,16,24]);
 assert.match(css,/body\{[^}]*font-weight:400/);
 assert.doesNotMatch(css,/letter-spacing:\.0[3-9]/);
 for(const weight of [400,500,600])assert.match(css,new RegExp('inter-latin-'+weight+'-normal\\.woff2'));
});

const searchView={protocol_version:'2',view:'source_search',apiosk_sources_searched:112,catalog_version:'c1',notice:'Prices are per call.',
 parsed_request:{capabilities:[{slug:'company.profile',name:'Company profile',description:'Registered company details'},{slug:'time.current',name:'Current time'},{slug:'weather.current',name:'Current weather'}]},
 matches:[
  {slug:'company.profile',query:'company profile',operations:['lookup'],coinbase:[],coinbase_status:'skipped',apiosk:[
   {origin:'apiosk',name:'KVK Basisprofiel',description:'Dutch company register profile',source_slug:'kvk',capability:'company.profile',endpoint_id:'e1',url:null,method:'GET',price:'0.001',network:null,calls_30d:12,availability:'supported',logo_url:null,
    endpoint:{endpoint_id:'e1',capability:'company.profile',name:'KVK Basisprofiel',description:'Profile',source:{slug:'kvk',name:'KVK',logo_url:null,url:'https://kvk.nl'},inputs:[{field:'company_registry.kvknummer',required:true,schema:{type:'string'}},{field:'company.name',required:false,schema:{}}],lookup:null,price:{currency:'USDC',provider_atomic:'1000',buyer_atomic:'1100'}}},
   {origin:'apiosk',name:'OpenCorporates',description:'Global registry index',source_slug:'opencorporates',capability:'company.profile',endpoint_id:null,url:null,method:'GET',price:null,network:null,calls_30d:null,availability:'discovery_only',logo_url:null,endpoint:null}]},
  {slug:'time.current',query:'current time',operations:[],apiosk:[],coinbase_status:'complete',coinbase:[{origin:'coinbase',name:'Clock API',description:'x402 time service',source_slug:null,capability:null,endpoint_id:null,url:null,method:'GET',price:'0.0025 USD',network:'base',calls_30d:null,availability:'unverified',logo_url:null}]},
  {slug:'weather.current',query:'weather',operations:[],apiosk:[],coinbase:[],coinbase_status:'unavailable'}]};

test('a source search lists candidates per requested capability and offers nothing to buy',async()=>{
 const calls=[],h=harness(APIO_V2_CARD_HTML,{toolOutput:searchView,callTool:async(...args)=>{calls.push(args);return{structuredContent:searchView}}});
 const sections=h.nodes.get('sections'),texts=flatten(sections);
 assert.equal(h.nodes.get('title').textContent,'3 matching sources');
 assert.equal(h.nodes.get('subtitle').textContent,'Searched 112 Apiosk sources. Nothing is bought from this list.');
 assert.deepEqual(sections.querySelectorAll('h3').map(n=>n.textContent),['Company profile','Current time','Current weather','About these results']);
 assert.deepEqual(sections.querySelectorAll('.search-name').map(n=>n.textContent),['KVK Basisprofiel','OpenCorporates','Clock API']);
 assert.deepEqual(sections.querySelectorAll('.search-price').map(n=>n.textContent),['0.0011 USD','—','0.0025 USD']);
 assert.deepEqual(sections.querySelectorAll('.search-state').map(n=>n.textContent),['Available','Discovery only','Unverified']);
 assert.deepEqual(sections.querySelectorAll('.search-inputs').map(n=>n.textContent),['Needs KVK number'],'only required inputs of supported rows');
 for(const line of ['Registered company details','No matching source was found for this part of the question.','Coinbase Bazaar search is unavailable right now.','Prices are per call.'])assert.ok(texts.includes(line),line);
 assert.equal(sections.querySelectorAll('button').length,0);
 await h.tick(100);await h.tick(350);assert.deepEqual(calls,[]);
});

test('existing views still render after a source search',async()=>{
 const h=harness(APIO_V2_CARD_HTML);await h.initialize();
 await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:searchView}});
 await h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{protocol_version:'2',sources:[{name:'Registry',category:'company data'}],total:1,offset:0,next_offset:null}}});
 assert.equal(h.nodes.get('title').textContent,'1 matching source');
 assert.equal(h.nodes.get('sections').querySelectorAll('.search-row').length,0);
});

test('a single-endpoint result reads as the App answer body, not as a missing assessment',async()=>{
 const opened=[],result={result_ref:'r1',subject:{label:'ACME BV'},source:{name:'Registry',provider:'registry'},data:{data:{id:'abc123',name:'ACME BV',website:'https://acme.example',employees:12,address:{city:'UTRECHT'},filings:[{year:2023,revenue:100},{year:2024,revenue:120}]}}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:{...v2Ready,status:'succeeded',next_actions:[],context_view:{},result},openExternal:({href})=>opened.push(href)});
 const sections=h.nodes.get('sections'),texts=flatten(sections);
 assert.equal(h.nodes.get('title').textContent,'Source result');
 assert.ok(!texts.some(t=>/assessment is not available|Sources and details/.test(t)));
 assert.equal(sections.children[0].querySelector('h3').textContent,'Result · Acme BV');
 assert.deepEqual(sections.querySelectorAll('dt').map(n=>n.textContent),['Name','Website','Employees','City'],'plumbing such as id stays out of the reader');
 assert.ok(texts.includes('Acme BV')&&texts.includes('Utrecht')&&texts.includes('12'));
 assert.deepEqual(sections.querySelectorAll('th').map(n=>n.textContent),['Year','Revenue']);
 assert.deepEqual(sections.querySelectorAll('td').map(n=>flatten(n).join('')),['2023','100','2024','120']);
 const link=sections.querySelectorAll('a')[0];assert.equal(link.href,'https://acme.example');
 link.onclick({preventDefault(){}});assert.deepEqual(opened,['https://acme.example']);
 const full=sections.querySelectorAll('details').find(d=>d.children[0].textContent==='Full source data');
 assert.ok(!full.open);assert.match(full.querySelector('pre').textContent,/abc123/);
});

test('research answers show every observation, period headings, all specific limitations and the follow-up',()=>{
 const results=[{result_ref:'a',source:{name:'KVK'},data:{fiscal_year:'2023',revenue:'1250000',currency:'EUR'}},{result_ref:'b',source:{name:'KVK'},data:{fiscal_year:'2024',revenue:'1500000',currency:'EUR'}}];
 const generic='Some source information is unavailable. The answer uses the available results.';
 const analysis={status:'completed',follow_up_question:'Compare with 2022?',limitations:[generic,'Filed accounts are unaudited.','Group figures are not consolidated.'],observations:[
  {text:'Revenue was 1250000 EUR.',evidence:[{result_ref:'a',pointer:'/data/revenue',value:'1250000'}]},{text:'Revenue rose to 1500000 EUR.',evidence:[{result_ref:'b',pointer:'/data/revenue',value:'1500000'}]},
  {text:'Third finding.',evidence:[]},{text:'Fourth finding.',evidence:[]},{text:'Fifth finding.',evidence:[]}]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:{...v2Ready,status:'succeeded',next_actions:[],context_view:{analysis,results}}});
 const answer=h.nodes.get('sections').children[0],texts=flatten(answer);
 assert.equal(h.nodes.get('title').textContent,'Answer');
 assert.deepEqual(answer.querySelectorAll('h3').map(n=>n.textContent),['Reporting period 2023','Reporting period 2024','Key findings','Source notes']);
 for(const line of ['€ 1,250,000.','€ 1,500,000.','Fifth finding.','Filed accounts are unaudited.','Group figures are not consolidated.','Compare with 2022?'])assert.ok(texts.includes(line),line);
 assert.ok(!texts.includes(generic),'generic caveats stay in details');
 assert.ok(flatten(h.nodes.get('sections').querySelector('.source-results-toggle')).includes(generic));
});

test('version 2 answer blocks render a sortable, filterable table, bars and a generic fallback',()=>{
 const analysis={status:'completed',answer_schema_version:2,observations:[{text:'Two companies matched.',evidence:[]}],limitations:[],source_index:[{result_ref:'r',name:'Registry'}],blocks:[
  {id:'n',kind:'narrative',observation_ids:['o1'],provisional:false,produced_by:'model'},
  {id:'t',kind:'data_table',title:'Companies',provisional:false,produced_by:'model',collection:{result_ref:'r',rows_pointer:'/data/items',row_indices:[0,1]},columns:[{id:'name',label:'Name',pointer:'/name',role:'label'},{id:'emp',label:'Employees',pointer:'/employees',role:'number'}],rows:[{row_index:1,cells:[{value:'Beta'},{value:null}]},{row_index:0,cells:[{value:'Alpha'},{value:1200}]}],sort:{column_id:'emp',direction:'desc'},coverage:{selected:2,fetched:2,total_available:9,paginated:true,scope:'fetched_page'}},
  {id:'b',kind:'bar_chart',value_label:'Employees',provisional:false,produced_by:'model',bars:[{id:'b1',label:'Alpha',rank:1,fact:{value:1200,result_ref:'r',pointer:'/data/items/0/employees'}},{id:'b2',label:'Beta'}]},
  {id:'k',kind:'kpi',title:'Headcount',provisional:false,produced_by:'model',cards:[{id:'c',label:'Total employees',fact:{value:1200,derivation_id:'sum'}}]}]};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:{...v2Ready,status:'succeeded',next_actions:[],context_view:{analysis,results:[{result_ref:'r',source:{name:'Registry'},data:{items:[]}}]}}});
 const answer=h.nodes.get('sections').children[0],texts=flatten(answer);
 assert.ok(texts.includes('Two companies matched.'));
 assert.ok(!texts.some(t=>/narrative/.test(t)));
 const [table,generic]=answer.querySelectorAll('table');
 assert.deepEqual(table.querySelectorAll('th').map(n=>n.textContent),['Name','Employees']);
 assert.deepEqual(table.querySelectorAll('.fact-value,.body-muted').map(n=>n.textContent),['Alpha','1.200','Beta','Unknown'],'sorted descending, nulls last');
 assert.ok(texts.includes('Registry · /data/items/0/name'));
 assert.ok(texts.includes('2 selected · 2 fetched · 9 total available'));
 const filter=answer.querySelector('.block-filter');filter.value='bet';filter.oninput();
 assert.ok(flatten(answer).includes('2 selected · 2 fetched · 9 total available · 1 match the filter'));
 assert.deepEqual(answer.querySelectorAll('table')[0].querySelectorAll('.fact-value,.body-muted').map(n=>n.textContent),['Beta','Unknown']);
 assert.deepEqual(answer.querySelectorAll('.bar-label').map(n=>n.textContent),['#1 Alpha','Beta']);
 assert.equal(answer.querySelectorAll('.bar-fill').length,1);
 assert.deepEqual(generic.querySelectorAll('th').map(n=>n.textContent),['Field','Value','Source']);
 assert.deepEqual(generic.querySelectorAll('td').map(n=>flatten(n).join('')),['Total employees','1.200','Calculated']);
});

test('a presentation table formats cited values without dumping the source rows',()=>{
 const analysis={status:'completed',observations:[{text:'Revenue by year.',evidence:[]}],limitations:[],presentation:{kind:'table',title:'Revenue',columns:[{value:'Year'},{value:'Revenue'},{value:'Currency'}],rows:[[{value:'2023'},{value:'1250000',result_ref:'a',pointer:'/data/revenue'},{value:'EUR'}]]}};
 const h=harness(APIO_V2_CARD_HTML,{toolOutput:{...v2Ready,status:'succeeded',next_actions:[],context_view:{analysis,results:[{result_ref:'a',source:{name:'KVK'},data:{revenue:'1250000'}}]}}});
 const answer=h.nodes.get('sections').children[0];
 assert.deepEqual(answer.querySelectorAll('th').map(n=>n.textContent),['Year','Revenue','Currency']);
 assert.deepEqual(answer.querySelectorAll('td').map(n=>flatten(n).join('')),['2023','€ 1,250,000','EUR']);
 assert.ok(flatten(answer).includes('1 rows shown. Based on saved source data. Missing values are unknown.'));
});

test('the report PDF joins the answer only when the question asked for a document',()=>{
 const base={...v2Ready,status:'succeeded',next_actions:[],context_view:{analysis:{status:'completed',observations:[{text:'Done.',evidence:[]}],limitations:[]},report:{format:'pdf',url:'https://api.apiosk.com/r.pdf',evidence_url:'https://api.apiosk.com/e.zip'},results:[{result_ref:'a',source:{name:'KVK'},data:{name:'Acme'}}]}};
 for(const [question,inAnswer] of [['Prepare a due diligence report for Acme',true],['Is Acme active?',false]]){
  const data={...base,context_view:{...base.context_view,conversation:[{question}]}};
  const sections=harness(APIO_V2_CARD_HTML,{toolOutput:data}).nodes.get('sections'),labels=node=>node.querySelectorAll('button').map(b=>b.textContent);
  assert.equal(labels(sections.children[0]).includes('Download PDF'),inAnswer,question);
  assert.ok(!labels(sections.children[0]).includes('Download evidence'));
  const details=sections.querySelector('.source-results-toggle');
  assert.ok(labels(details).includes('Download PDF')&&labels(details).includes('Download evidence'));
 }
});
