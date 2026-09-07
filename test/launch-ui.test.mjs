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
  const sent=[],listeners=new Map(),nodes=new Map();
  const el=(name='div')=>({tagName:name.toUpperCase(),textContent:'',value:'',disabled:false,dataset:{},children:[],classList:{add(){},remove(){},contains(){return false}},append(...c){this.children.push(...c)},replaceChildren(...c){this.children=c},querySelectorAll(selector){return this.children.flatMap(c=>[...(selector.split(',').includes(c.tagName.toLowerCase())?[c]:[]),...c.querySelectorAll(selector)])},focus(){},addEventListener(name,fn){this['on'+name]=fn},reportValidity(){return !this.required||this.value!==''}});
  const document={documentElement:{scrollWidth:320,scrollHeight:200},getElementById(id){if(!nodes.has(id))nodes.set(id,el());return nodes.get(id)},createElement:el};
  const parent={postMessage(m){sent.push(m)}};
  const window={parent,openai,addEventListener(n,fn){listeners.set(n,fn)}};
  const ctx=vm.createContext({window,document,URL,Intl,console,setTimeout:()=>1,clearTimeout(){},ResizeObserver:class{observe(){}}});
  if(html)for(const s of html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(s[1],ctx);else vm.runInContext(APIOSK_UI_BRIDGE,ctx);
  return {
    sent,nodes,window,
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
  assert.equal(planSection.children[0].children[0].textContent,'Your plan');
  assert.equal(planSection.children.at(-1).children[0].textContent,'Approve up to 0.097826 USDC');
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
