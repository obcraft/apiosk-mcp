import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
import { APIO_V2_CARD_URI, APIO_V2_CHATGPT_CARD_URI, APIO_V2_CARD_META, gatewayV2CardHtml, gatewayV2CardMeta } from '../src/gateway-v2-card.mjs';
import { V2_SOURCES_PRESENTATION } from '../src/result-presentation.mjs';
const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'};
test('approval card displays source scope without interpreting it as HTML',()=>{
 const html=gatewayV2CardHtml('https://gateway.apiosk.com');
 assert.match(html,/Scope of this check/);
 assert.match(html,/context_view\?\.coverage_notices/);
 assert.match(html,/el\('p','notice',notice\)/);
});
test('v2 exposes four model tools and an app-only approval tool while legacy stays unchanged',async()=>{
 const v2=createApioskMcpRuntime({env});const tools=await v2.listTools();assert.deepEqual(tools.map(t=>t.name),['apiosk_sources','apiosk_discover','apiosk_execute','apiosk_status','apiosk_approve']);
 for(const tool of tools){const uri=tool.name==='apiosk_approve'?undefined:APIO_V2_CARD_URI;assert.equal(tool._meta.ui.resourceUri,uri);assert.equal(tool._meta['openai/outputTemplate'],tool.name==='apiosk_approve'?undefined:APIO_V2_CHATGPT_CARD_URI);assert.equal(tool.outputSchema.type,'object');assert.deepEqual(tool._meta.ui.visibility,tool.name==='apiosk_approve'?['app']:['model','app']);assert.equal(tool._meta['openai/widgetAccessible'],true)}
 assert.ok(tools.find(t=>t.name==='apiosk_sources').outputSchema.properties.sources);
 assert.ok(tools.find(t=>t.name==='apiosk_discover').outputSchema.properties.next_actions);
 assert.ok(tools.find(t=>t.name==='apiosk_execute').outputSchema.properties.result);
 assert.ok(tools.find(t=>t.name==='apiosk_status').outputSchema.properties.status.enum.includes('cancelled'));
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
test('approval refusal preserves Gateway errors and exposes their reason without retrying',async()=>{
 const state={schema_version:'2',state_ref:'00000000-0000-4000-8000-000000000001',expires_at:'2099-01-01T00:00:00Z',revision:1,state_token:'opaque',focus:{entity_refs:[],goal_refs:[]}};
 const diagnostic={code:'approval_refused',message:'Check the connection spending limits. No new purchase was made.'};let calls=0;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>{calls++;return Response.json({protocol_version:'2',status:'failed',state:null,errors:[diagnostic],next_actions:[]},{status:403});}});
 const result=await runtime.callTool('apiosk_approve',{state,quote_ref:'00000000-0000-4000-8000-000000000002',max_total_atomic:'881698'});
 assert.equal(calls,1);assert.equal(result.isError,true);
 assert.equal(result.structuredContent.message,diagnostic.message);
 assert.equal(result.structuredContent.error_code,'approval_refused');
 assert.equal(result.structuredContent.recover_task_ref,state.state_ref);
 assert.deepEqual(result.structuredContent.errors,[diagnostic]);
});
test('v2 transport refuses insecure nonlocal configuration',()=>{
 assert.throws(()=>createApioskMcpRuntime({env:{APIOSK_GATEWAY_V2_URL:'http://example.test'}}));
});
test('v2 card events and CSP trust only the configured gateway origin',()=>{
 const staging='https://gateway.staging.apiosk.test';
 const html=gatewayV2CardHtml(`${staging}/`),meta=gatewayV2CardMeta(`${staging}/`);
 assert.deepEqual(meta.ui.csp.connectDomains,[staging]);
 assert.deepEqual(meta['openai/widgetCSP'].connect_domains,[staging]);
 assert.match(html,/gateway\.staging\.apiosk\.test/);
 assert.doesNotMatch(html,/apiosk-gateway-v2\.fly\.dev/);
 assert.doesNotMatch(html,/__APIOSK_GATEWAY_ORIGIN__/);
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
test('source presentation reaches cached hosts on every page without losing card or text fallback data', async () => {
 const source={slug:'pulsenetwork',name:'Pulse Network',service_count:87,services:[{slug:'tax-pulse',name:'TaxPulse'}]};
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url)=>Response.json({protocol_version:'2',sources:[source],total:26,offset:Number(url.searchParams.get('offset')||0),next_offset:20,categories:[],tags:[],sectors:[],capabilities:[]})});
 const tool=(await runtime.listTools()).find(t=>t.name==='apiosk_sources');
 assert.ok(tool.description.includes(V2_SOURCES_PRESENTATION));
 assert.ok(APIO_V2_CARD_META['openai/widgetDescription'].includes(V2_SOURCES_PRESENTATION));
 for(const args of [{},{offset:20},{search:'TaxPulse'}]) {
  const result=await runtime.callTool('apiosk_sources',args);
  assert.equal(result.isError,undefined);
  assert.equal(result.content.at(-1).text,V2_SOURCES_PRESENTATION);
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  assert.deepEqual(result.structuredContent.sources,[source]);
  assert.equal(result.structuredContent.total,26);
 }
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
 assert.equal(reply.content[0].text,'Maximum total price: 0.076087 USD. Actual charge so far: 0.000023 USD.');
 assert.match(reply.content.at(-1).text,new RegExp(id));assert.match(reply.content.at(-1).text,/This read is free and never buys or approves/);
 assert.equal(reply.structuredContent.billing.total_charged,'23');
});

test('historic billing metadata is fiat-only without changing source currency, signed state or approval ceiling',async()=>{
 const original={protocol_version:'2',status:'ready',state:{state_ref:'task',state_token:'signed'},proposal:{currency:'USDC',max_total_atomic:'9007199254740993'},billing:{currency:'USDC',total_charged:'23'},result:{currency:'USDC',data:{currency:'EUR',amount:'123.45'}},next_actions:[],errors:[]};
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json(original)});
 const reply=await runtime.callTool('apiosk_discover',{question:'Annual accounts'});
 assert.equal(reply.structuredContent.proposal.currency,'USD');assert.equal(reply.structuredContent.billing.currency,'USD');assert.equal(reply.structuredContent.result.currency,'USD');
 assert.deepEqual(reply.structuredContent.result.data,original.result.data);assert.deepEqual(reply.structuredContent.state,original.state);assert.equal(reply.structuredContent.proposal.max_total_atomic,original.proposal.max_total_atomic);
 assert.match(reply.content[0].text,/9007199254\.740993 USD/);
});

test('EUR account preference reaches model prices without changing the signed cap or source figures',async()=>{
 const original={protocol_version:'2',status:'ready',state:{state_ref:'task',state_token:'signed'},context_view:{money_display:{base_currency:'USD',preferred_currency:'EUR',currency:'EUR',rate:'0.92000000',as_of_date:'2026-08-21'}},proposal:{currency:'USD',max_total_atomic:'114446'},billing:{currency:'USD',total_charged:'23000'},result:{data:{currency:'GBP',amount:'123.45'}},next_actions:[],errors:[]};
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json(original)});
 const reply=await runtime.callTool('apiosk_discover',{question:'Company check'});
 assert.equal(reply.content[0].text,'Maximum total price: 0.105291 EUR. Actual charge so far: 0.02116 EUR.');
 assert.deepEqual(reply.structuredContent,{...original,proposal:{...original.proposal,label:'Data request'}});
 const tool=(await runtime.listTools()).find(t=>t.name==='apiosk_discover');
 assert.match(tool.description,/account display currency/);
 assert.doesNotMatch(tool.description,/Display Apiosk prices and charges in USD/);
});

test('annual report links use the configured gateway origin without sending buyer credentials', async()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const path=`/v2/tasks/${id}/results/${id}/report.pdf?owner=${id}&expires=99&signature=abc`;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json({protocol_version:'2',status:'succeeded',next_actions:[],errors:[],result:{report:{format:'pdf',download_path:path}}})});
 const reply=await runtime.callTool('apiosk_status',{task_ref:id});
 assert.equal(reply.structuredContent.result.report.url,`http://127.0.0.1:8082${path}`);
 assert.ok(!reply.structuredContent.result.report.url.includes('fixture'));
});


test('combined research PDF links survive status and archived turns without another execution', async()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const path=`/v2/tasks/${id}/reports/${id}/report.pdf?owner=${id}&snapshot=abc&expires=99&signature=abc`;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json({protocol_version:'2',status:'succeeded',next_actions:[],errors:[],context_view:{report:{format:'pdf',download_path:path},conversation:[{output:{report:{format:'pdf',download_path:path}}}]}})});
 const reply=await runtime.callTool('apiosk_status',{task_ref:id});
 assert.equal(reply.structuredContent.context_view.report.url,`http://127.0.0.1:8082${path}`);
 assert.equal(reply.structuredContent.context_view.conversation[0].output.report.url,`http://127.0.0.1:8082${path}`);
});


test('changed discovery input recovers an explicit request conflict once with a deterministic key',async()=>{
 const request_id='00000000-0000-4000-8000-000000000001',calls=[];
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push(body);
  return Response.json({protocol_version:'2',status:body.request_id===request_id?'failed':'needs_input',next_actions:[],errors:body.request_id===request_id?[{code:'request_conflict'}]:[]});
 }});
 for(let i=0;i<2;i++)assert.equal((await runtime.callTool('apiosk_discover',{question:'2025 versus 2024',request_id})).structuredContent.status,'needs_input');
 assert.equal(calls.length,4);assert.notEqual(calls[1].request_id,request_id);assert.equal(calls[1].request_id,calls[3].request_id);
 assert.equal(calls[1].question,calls[0].question);
});

test('paid execution conflicts and ambiguous planning transport failures are never retried',async()=>{
 let count=0;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>{count++;return Response.json({protocol_version:'2',status:'failed',next_actions:[],errors:[{code:'request_conflict'}]})}});
 await runtime.callTool('apiosk_execute',{recover_task_ref:'00000000-0000-4000-8000-000000000001'});assert.equal(count,1);
 const failed=createApioskMcpRuntime({env,fetchImpl:async()=>{count++;throw Error('timeout')}});
 await failed.callTool('apiosk_discover',{question:'Construction revenue',request_id:'00000000-0000-4000-8000-000000000001'});assert.equal(count,2);
});
