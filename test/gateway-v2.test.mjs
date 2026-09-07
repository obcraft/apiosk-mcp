import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'};
test('v2 exposes exactly two tools while legacy stays unchanged',async()=>{
 const v2=createApioskMcpRuntime({env});assert.deepEqual((await v2.listTools()).map(t=>t.name),['apiosk_discover','apiosk_execute']);
 assert.equal((await createApioskMcpRuntime({env:{}}).listTools()).length,11);
});
test('v2 forwards state exactly and stable action idempotency through authenticated transport',async()=>{
 const state={schema_version:'2',state_ref:'fixture',revision:3,state_token:'opaque',focus:{entity_refs:[],goal_refs:[]}};let request;
 const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{request={url,...options};return Response.json({protocol_version:'2',state,status:'requires_approval'});}});
 const result=await runtime.callTool('apiosk_execute',{action_id:'action-fixture',state,quote_ref:'quote-fixture'},{extra:{apiosk_connect_token:'request-token'}});
 assert.equal(request.headers.authorization,'Bearer request-token');assert.equal(request.redirect,'error');
 const body=JSON.parse(request.body);assert.deepEqual(body.state,state);assert.equal(body.idempotency_key,'action-fixture');assert.equal(body.approved,undefined);
 assert.equal(result.structuredContent.status,'requires_approval');
});
test('v2 does not call gateway without a connection',async()=>{
 let calls=0;const runtime=createApioskMcpRuntime({env:{APIOSK_GATEWAY_V2_URL:env.APIOSK_GATEWAY_V2_URL},fetchImpl:async()=>{calls++;}});
 assert.equal((await runtime.callTool('apiosk_discover',{question:'x'})).isError,true);assert.equal(calls,0);
});
test('v2 transport refuses insecure nonlocal configuration',()=>{
 assert.throws(()=>createApioskMcpRuntime({env:{APIOSK_GATEWAY_V2_URL:'http://example.test'}}));
});
