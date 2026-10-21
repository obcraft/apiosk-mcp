import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
import { createApioskMcpServer } from '../src/create-server.mjs';
import { COMPANY_CARD_URI, COMPANY_CHATGPT_CARD_URI, companyCheckCardHtml } from '../src/company-checks-card.mjs';

const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'};
const check_id='12345678-1234-4234-8234-123456789012';
const args={check_id,occurrence:'2026-10-26:Europe-Amsterdam',companies:[{name:'Acme B.V.',kvk_number:'01234567'}]};
test('company check forwards exact company identities and replay identity without client approval',async()=>{
 const requests=[];const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,opts)=>{requests.push({url:String(url),...opts});return Response.json({view:'company_check',check_id,status:'partial',new_signals:[]})}});
 await runtime.callTool('apiosk_company_check',args);await runtime.callTool('apiosk_company_check',args);
 assert.equal(requests.length,2);assert.equal(requests[0].body,requests[1].body);assert.deepEqual(JSON.parse(requests[0].body),args);
 assert.equal(requests[0].url,'http://127.0.0.1:8082/v2/company-checks');assert.equal(requests[0].redirect,'error');
 assert.equal(JSON.parse(requests[0].body).approved,undefined);
});
test('malformed identifiers, unknown fields and implicit approval never reach Gateway',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>{calls++}});
 for(const input of [{...args,approved:true},{...args,check_id:'../../other'},{...args,occurrence:'../other'},{...args,companies:[{...args.companies[0],kvk_number:1234567}]},{...args,companies:[{...args.companies[0],kvk_number:'123'}]}]){
  assert.equal((await runtime.callTool('apiosk_company_check',input)).isError,true);
 }
 assert.equal(calls,0);
});
test('reading and collecting never acknowledge or start a purchase',async()=>{
 const requests=[];const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{requests.push({url:String(url),...options});return Response.json({view:'company_check_history',check_id,runs:[]})}});
 await runtime.callTool('apiosk_company_check_read',{check_id});await runtime.callTool('apiosk_company_check_result',{check_id,occurrence:args.occurrence});
 assert.equal(requests[0].method,'GET');assert.equal(requests[0].body,undefined);
 assert.equal(requests[1].url,`http://127.0.0.1:8082/v2/company-checks/${check_id}/collect`);
 assert.deepEqual(JSON.parse(requests[1].body),{occurrence:args.occurrence});
});
test('transport ambiguity does not retry or replace the occurrence',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>{calls++;throw new Error('lost response')}});
 const response=await runtime.callTool('apiosk_company_check',args);
 assert.equal(calls,1);assert.equal(response.isError,true);assert.equal(response.structuredContent.check_id,check_id);assert.equal(response.structuredContent.occurrence,args.occurrence);
});
test('stale Gateway routes are an explicit deployment error, not an uncertain purchase',async()=>{
 for(const status of [404,405]){
  const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>new Response('Not found',{status})});
  const r=await runtime.callTool('apiosk_company_check',args);
  assert.equal(r.isError,true);assert.equal(r.structuredContent.error_code,'company_check_route_unavailable');
  assert.equal(r.structuredContent.check_id,check_id);assert.equal(r.structuredContent.occurrence,args.occurrence);
 }
});
test('missing monitor migration is preserved as a concrete storage blocker',async()=>{
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json({errors:[{code:'company_check_storage_not_ready',message:'Apply the monitor migration.'}]},{status:503})});
 const r=await runtime.callTool('apiosk_company_check',args);
 assert.equal(r.isError,true);assert.equal(r.structuredContent.error_code,'company_check_storage_not_ready');
});
test('original evidence reopens through a read-only request with both saved identifiers',async()=>{
 let seen;const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{seen={url,...options};return Response.json({view:'company_check_evidence',source:{document:{data:{status:'active'}}}})}});
 const response=await runtime.callTool('apiosk_company_check_read',{check_id,occurrence:args.occurrence,result_ref:check_id});
 assert.equal(seen.method,'GET');assert.equal(seen.body,undefined);assert.equal(seen.url.searchParams.get('occurrence'),args.occurrence);assert.equal(seen.url.searchParams.get('result_ref'),check_id);assert.equal(response.structuredContent.source.document.data.status,'active');
 seen=null;assert.equal((await runtime.callTool('apiosk_company_check_read',{check_id,result_ref:check_id})).isError,true);assert.equal(seen,null);
});
test('hosted company tools cannot fall back to a machine token and 401 offers reconnect',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env,hostedAuthEnabled:true,fetchImpl:async()=>{calls++;return new Response('',{status:401})}});
 const anonymous=await runtime.callTool('apiosk_company_check',args);assert.equal(anonymous.isError,true);assert.ok(anonymous._meta['mcp/www_authenticate']);assert.equal(calls,0);
 const expired=await runtime.callTool('apiosk_company_check',args,{extra:{apiosk_connect_token:'expired'}});assert.ok(expired._meta['mcp/www_authenticate']);assert.equal(calls,1);
});
for(const host of ['claude','chatgpt'])test(`${host} receives company tools and its own executable UI resource`,async()=>{
 const server=createApioskMcpServer({env});const client=new Client({name:host,version:'test'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(b);await client.connect(a);const tools=(await client.listTools()).tools.filter(t=>t.name.startsWith('apiosk_company_check'));
  assert.equal(tools.length,5);
  for(const tool of tools){assert.equal(tool._meta.ui.resourceUri,COMPANY_CARD_URI);assert.equal(tool._meta['openai/outputTemplate'],COMPANY_CHATGPT_CARD_URI);assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:['mcp:tools']}])}
  assert.equal(tools.find(t=>t.name.endsWith('_read')).annotations.readOnlyHint,true);assert.equal(tools.find(t=>t.name.endsWith('_result')).annotations.readOnlyHint,false);
  const uri=host==='claude'?COMPANY_CARD_URI:COMPANY_CHATGPT_CARD_URI;
  const resource=(await client.readResource({uri})).contents[0];assert.equal(resource.mimeType,host==='claude'?'text/html;profile=mcp-app':'text/html+skybridge');
  for(const [index,match] of [...resource.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries())new vm.Script(match[1],{filename:`company-card-${index}.js`});
 }finally{await client.close();await server.close()}
});
test('company report rendering handles empty, partial and hostile evidence without HTML injection or auto acknowledgement',()=>{
 const html=companyCheckCardHtml(env.APIOSK_GATEWAY_V2_URL);
 const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
 // Execute the report renderer against a small DOM; do not run transport or
 // the existing task renderer. All source values must become text nodes.
 const start=script.indexOf('function companyText('),end=script.indexOf('async function collectCompanyCheck(');
 const nodes=[];const node=(tag,className,value)=>{const n={tag,className,textContent:value,children:[],append(...items){this.children.push(...items)},replaceChildren(){this.children=[]},classList:{add(){},remove(){}}};nodes.push(n);return n};
 const ids=new Map();const sections=node('sections');const context={output:null,sourceUsageNotices:()=>[],el:node,sections,feedback:node('feedback'),byId:id=>{if(!ids.has(id))ids.set(id,node(id));return ids.get(id)},section:title=>{const s=node('section','',title);sections.append(s);return s},window:{apiosk:{resize(){}}},money:(value,currency)=>value==null?null:`${value} ${currency}`};
 vm.createContext(context);vm.runInContext(script.slice(start,end),context);
 context.data={view:'company_check',status:'partial',company_count:3,new_signal_count:1,source_count:1,companies:args.companies,new_signals:[{kvk_number:'01234567',company_name:'<script>bad()</script>',message:'<img onerror=bad()>',evidence:[{value:'<iframe/>'}]}],coverage:[{status:'unknown',kvk_number:'01234567',message:'Geen nieuwsdekking'}],sources:[],limitations:[]};
 vm.runInContext('renderCompanyCheck(data)',context);
 assert.equal(ids.get('status-pill').textContent,'Incomplete coverage');assert.ok(nodes.some(n=>n.textContent==='<img onerror=bad()>'));
 assert.ok(!nodes.some(n=>'innerHTML' in n));
 context.data={...context.data,new_signal_count:0,new_signals:[]};vm.runInContext('renderCompanyCheck(data)',context);
 assert.ok(nodes.some(n=>String(n.textContent).includes('No new relevant signals')));
 assert.doesNotMatch(script.slice(start),/callTool\('apiosk_company_check_acknowledge'/);
});

test('the plan card bundles the same operation from one source into one row with its subjects',()=>{
 const script=[...companyCheckCardHtml(env.APIOSK_GATEWAY_V2_URL).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
 const start=script.indexOf('function renderPlan('),end=script.indexOf('function ',start+20);
 const nodes=[];const node=(tag,className,value)=>{const n={tag,className,textContent:value,children:[],append(...items){this.children.push(...items)},classList:{add(){}}};nodes.push(n);return n};
 const context={el:node,section:(title,...rest)=>{const s=node('section','',title);s.append(...rest);return s},money:value=>`€${value}`,text:String,pretty:String,sourceLine:source=>node('div','step-source',source.name),planSurface:null};
 vm.createContext(context);vm.runInContext(script.slice(start,end),context);
 const sanctions=(subject,status)=>({title:'Screen for sanctions matches',subject,status,source:{slug:'opensanctions',name:'OpenSanctions'}});
 context.data={proposal:{max_total_atomic:'402175',currency:'USD',steps:['a','b','c','d'],step_details:[{title:'Retrieve the company profile',subject:'A',source:{slug:'kvk',name:'KVK'}},sanctions('A'),sanctions('B','completed'),sanctions('C')]}};
 vm.runInContext('renderPlan(data)',context);
 assert.equal(nodes.filter(n=>n.className==='step').length,2);
 assert.ok(nodes.some(n=>n.textContent==='Screen for sanctions matches · 3×'));
 assert.ok(nodes.some(n=>n.textContent==='A · B · C'));
 assert.ok(nodes.some(n=>n.className==='state running'));
 assert.ok(nodes.some(n=>n.textContent==='€402175'));
});

test('email handoff and confirmation use saved identity and never execute a mail tool',async()=>{
 const calls=[];const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,opts)=>{calls.push({url:String(url),...opts});return Response.json({view:'company_check_delivery',dispatch_allowed:false,status:'suppressed'})}});
 const delivery_id='22222222-2222-4222-8222-222222222222';
 await runtime.callTool('apiosk_company_check_email',{check_id,occurrence:args.occurrence,delivery_id});
 await runtime.callTool('apiosk_company_check_acknowledge',{check_id,delivery_id,provider:'gmail',provider_message_id:'sent-message-1'});
 assert.equal(calls.length,2);assert.equal(calls[0].url,`http://127.0.0.1:8082/v2/company-checks/${check_id}/email`);
 assert.deepEqual(JSON.parse(calls[1].body),{delivery_id,provider:'gmail',provider_message_id:'sent-message-1'});
 const bad=await runtime.callTool('apiosk_company_check_acknowledge',{check_id,occurrence:args.occurrence,signal_ids:['a'.repeat(64)]});
 assert.equal(bad.isError,true);assert.equal(calls.length,2,'chat display cannot acknowledge email signals');
});
test('an ambiguous email handoff preserves delivery identity and forbids blind retries',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>{calls++;throw Error('timeout')}});
 const delivery_id='22222222-2222-4222-8222-222222222222';
 const r=await runtime.callTool('apiosk_company_check_email',{check_id,occurrence:args.occurrence,delivery_id});
 assert.equal(calls,1);assert.equal(r.structuredContent.delivery_id,delivery_id);assert.match(r.structuredContent.message,/uncertain email/);
});
