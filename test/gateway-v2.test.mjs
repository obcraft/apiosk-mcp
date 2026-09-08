import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
import { APIO_V2_CARD_URI } from '../src/gateway-v2-card.mjs';
const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'};
test('v2 exposes four model tools and an app-only approval tool while legacy stays unchanged',async()=>{
 const v2=createApioskMcpRuntime({env});const tools=await v2.listTools();assert.deepEqual(tools.map(t=>t.name),['apiosk_sources','apiosk_discover','apiosk_execute','apiosk_status','apiosk_approve']);
 for(const tool of tools){const uri=tool.name==='apiosk_approve'?undefined:APIO_V2_CARD_URI;assert.equal(tool._meta.ui.resourceUri,uri);assert.equal(tool._meta['openai/outputTemplate'],uri);assert.equal(tool.outputSchema.type,'object');assert.deepEqual(tool._meta.ui.visibility,tool.name==='apiosk_approve'?['app']:['model','app']);assert.equal(tool._meta['openai/widgetAccessible'],true)}
 assert.ok(tools.find(t=>t.name==='apiosk_sources').outputSchema.properties.sources);
 assert.ok(tools.find(t=>t.name==='apiosk_discover').outputSchema.properties.next_actions);
 assert.ok(tools.find(t=>t.name==='apiosk_execute').outputSchema.properties.result);
 for (const name of ['apiosk_discover','apiosk_execute','apiosk_status']) {
   const description=tools.find(t=>t.name===name).description;
   assert.match(description,/only a brief confirmation/);
   assert.match(description,/unless the user explicitly requests those details/);
 }
 assert.equal((await createApioskMcpRuntime({env:{}}).listTools()).length,11);
});
test('v2 forwards state exactly and stable action idempotency through authenticated transport',async()=>{
 const state={schema_version:'2',state_ref:'00000000-0000-4000-8000-000000000001',expires_at:'2099-01-01T00:00:00Z',revision:3,state_token:'opaque',focus:{entity_refs:[],goal_refs:[]}};let request;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{request={url,...options};return Response.json({protocol_version:'2',state,status:'requires_approval',next_actions:[],errors:[]});}});
 const result=await runtime.callTool('apiosk_execute',{action_id:'00000000-0000-4000-8000-000000000002',state,quote_ref:'00000000-0000-4000-8000-000000000003'},{extra:{apiosk_connect_token:'request-token'}});
 assert.equal(request.headers.authorization,'Bearer request-token');assert.equal(request.redirect,'error');
 const body=JSON.parse(request.body);assert.deepEqual(body.state,state);assert.equal(body.idempotency_key,'00000000-0000-4000-8000-000000000002');assert.equal(body.approved,undefined);
 assert.equal(result.structuredContent.status,'requires_approval');
});
test('v2 does not call gateway without a connection',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env:{APIOSK_GATEWAY_V2_URL:env.APIOSK_GATEWAY_V2_URL},fetchImpl:async()=>{calls++;}});
 assert.equal((await runtime.callTool('apiosk_discover',{question:'x'})).isError,true);assert.equal(calls,0);
});
test('v2 transport refuses insecure nonlocal configuration',()=>{
 assert.throws(()=>createApioskMcpRuntime({env:{APIOSK_GATEWAY_V2_URL:'http://example.test'}}));
});

test('hosted v2 never inherits a machine-wide buyer token',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env,hostedAuthEnabled:true,fetchImpl:async()=>{calls++;}});
 const response=await runtime.callTool('apiosk_discover',{question:'Example'});
 assert.equal(calls,0);assert.equal(response.isError,true);
 assert.match(response._meta['mcp/www_authenticate'][0],/oauth-protected-resource\/mcp/);
});
test('v2 validates invented approval and malformed recovery before transport',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>{calls++;}});
 for(const args of [{question:'Example',approved:true},{question:''}]) assert.equal((await runtime.callTool('apiosk_discover',args)).isError,true);
 assert.equal((await runtime.callTool('apiosk_execute',{recover_task_ref:'https://example.com'})).isError,true);
 assert.equal(calls,0);
});
test('recovery is GET only; upstream expired authentication returns OAuth challenge',async()=>{
 let seen;const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{seen={url,...options};return new Response('',{status:401});}});
 const id='00000000-0000-4000-8000-000000000001';
 const response=await runtime.callTool('apiosk_execute',{recover_task_ref:id});
 assert.equal(seen.method,'GET');assert.equal(seen.body,undefined);assert.equal(seen.url.pathname,`/v2/tasks/${id}`);
 assert.equal(response.structuredContent.error_code,'unauthorized');assert.ok(response._meta['mcp/www_authenticate']);
});
test('saved status is a separate read-only tool with only authenticated GET and no execution inputs',async()=>{
 const requests=[];const id='00000000-0000-4000-8000-000000000001';
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{requests.push({url,...options});return Response.json({protocol_version:'2',status:'succeeded',state:{state_ref:id},next_actions:[],errors:[],billing:{total_charged:'97826',currency:'USD'},result:{data:{FinancialYear:'2020'}}})}});
 const descriptor=(await runtime.listTools()).find(t=>t.name==='apiosk_status');
 assert.deepEqual(descriptor.annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true});
 for(const args of [{task_ref:id,action_id:id},{task_ref:id,approved:true},{task_ref:'https://example.com'},{}])assert.equal((await runtime.callTool('apiosk_status',args)).isError,true);
 assert.equal(requests.length,0);
 const result=await runtime.callTool('apiosk_status',{task_ref:id},{extra:{apiosk_connect_token:'connected-user'}});
 assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');assert.equal(requests[0].body,undefined);assert.equal(requests[0].url.pathname,`/v2/tasks/${id}`);assert.equal(requests[0].headers.authorization,'Bearer connected-user');
 assert.equal(result.structuredContent.result.data.FinancialYear,'2020');assert.match(result.content.at(-1).text,/calling apiosk_status/);
 assert.match(result.content.at(-1).text,/default reply after it is only 1–3 short sentences/);
 assert.match(result.content.at(-1).text,/only when the actual user explicitly asks/);
 assert.equal(result.structuredContent.billing.total_charged,'97826');
 const unauth=createApioskMcpRuntime({env,hostedAuthEnabled:true,fetchImpl:async()=>{throw new Error('must not fetch')}});
 assert.equal((await unauth.callTool('apiosk_status',{task_ref:id})).structuredContent.error_code,'unauthorized');
});
test('transport errors do not expose upstream credentials and preserve recovery identity',async()=>{
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>{throw new Error('secret-in-upstream-error')}});
 const response=await runtime.callTool('apiosk_execute',{recover_task_ref:'00000000-0000-4000-8000-000000000001'});
 assert.doesNotMatch(JSON.stringify(response),/secret-in-upstream-error/);
 assert.equal(response.structuredContent.recover_task_ref,'00000000-0000-4000-8000-000000000001');
});

test('source browsing is an authenticated GET with filters and no purchase body', async () => {
 let request;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{request={url,...options};return Response.json({protocol_version:'2',sources:[],total:0,next_offset:null});}});
 const tool=(await runtime.listTools()).find(t=>t.name==='apiosk_sources');
 assert.equal(tool.annotations.readOnlyHint,true);
 const response=await runtime.callTool('apiosk_sources',{search:'company & data',category:'finance',capability:'company.accounts',offset:20,limit:20});
 assert.equal(response.isError,undefined);
 assert.equal(request.method,'GET');assert.equal(request.body,undefined);
 assert.equal(request.url.pathname,'/v2/sources');assert.equal(request.url.searchParams.get('search'),'company & data');
 assert.equal(request.url.searchParams.get('offset'),'20');assert.equal(request.url.searchParams.get('capability'),'company.accounts');assert.equal(request.url.searchParams.has('request_id'),false);
 assert.equal((await runtime.callTool('apiosk_sources',{limit:51})).isError,true);
 assert.equal((await runtime.callTool('apiosk_sources',{approved:true})).isError,true);
});
test('source browsing keeps internal readiness fields out of chatbot output', async () => {
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json({protocol_version:'2',sources:[{slug:'registry',provider_slug:'provider',logo_url:'https://api.apiosk.com/logo.png',name:'Registry',description:'Company data',category:'data',tags:[],sectors:[],endpoint_count:4,available_in_v2:true,capabilities:[],input_types:[]}],total:1,catalog_total:1,offset:0,next_offset:null,categories:['data'],tags:[],sectors:[],capabilities:[],notice:'internal'})});
 const response=await runtime.callTool('apiosk_sources',{});
 assert.equal(response.structuredContent.sources[0].can_answer_questions,undefined);
 assert.equal(response.structuredContent.sources[0].available_in_v2,undefined);
 assert.equal(response.structuredContent.catalog_total,undefined);
 assert.doesNotMatch(response.structuredContent.notice,/available_in_v2|validated contract/i);
});
test('v2 omits optional nulls instead of forwarding chatbot placeholder values', async () => {
 let request;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{request={url,...options};return Response.json({protocol_version:'2',status:'unsupported',next_actions:[],errors:[]});}});
 const tool=(await runtime.listTools()).find(t=>t.name==='apiosk_discover');
 assert.equal(tool.inputSchema.properties.state.type,'object');
 await runtime.callTool('apiosk_discover',{question:'Find website SEO audits',state:null,context_delta:null});
 const body=JSON.parse(request.body);
 assert.equal(body.state,undefined);assert.equal(body.context_delta,undefined);
});

test('model-facing prices preserve sub-cent units and include free recovery for later questions',async()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json({protocol_version:'2',status:'ready',state:{state_ref:id},proposal:{max_total_atomic:'76087',currency:'USDC'},billing:{total_charged:'23',currency:'USD'},next_actions:[],errors:[]})});
 const reply=await runtime.callTool('apiosk_discover',{question:'Annual accounts'});
 assert.equal(reply.content[0].text,'Maximum total price: 0.076087 USDC. Actual charge so far: 0.000023 USD.');
 assert.match(reply.content.at(-1).text,new RegExp(id));assert.match(reply.content.at(-1).text,/This read is free and never buys or approves/);
 assert.equal(reply.structuredContent.billing.total_charged,'23');
});
