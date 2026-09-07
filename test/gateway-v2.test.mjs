import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'};
test('v2 exposes three tools while legacy stays unchanged',async()=>{
 const v2=createApioskMcpRuntime({env});const tools=await v2.listTools();assert.deepEqual(tools.map(t=>t.name),['apiosk_sources','apiosk_discover','apiosk_execute']);
 for(const tool of tools){assert.equal(tool._meta.ui.resourceUri,'ui://apiosk/gateway-v2-card-v2.html');assert.equal(tool._meta['openai/outputTemplate'],'ui://apiosk/gateway-v2-card-v2.html')}
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
test('v2 omits optional nulls instead of forwarding chatbot placeholder values', async () => {
 let request;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{request={url,...options};return Response.json({protocol_version:'2',status:'unsupported',next_actions:[],errors:[]});}});
 const tool=(await runtime.listTools()).find(t=>t.name==='apiosk_discover');
 assert.equal(tool.inputSchema.properties.state.type,'object');
 await runtime.callTool('apiosk_discover',{question:'Find website SEO audits',state:null,context_delta:null});
 const body=JSON.parse(request.body);
 assert.equal(body.state,undefined);assert.equal(body.context_delta,undefined);
});
