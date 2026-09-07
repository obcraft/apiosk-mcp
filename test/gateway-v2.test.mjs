import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'};
test('v2 exposes exactly two tools while legacy stays unchanged',async()=>{
 const v2=createApioskMcpRuntime({env});assert.deepEqual((await v2.listTools()).map(t=>t.name),['apiosk_discover','apiosk_execute']);
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
