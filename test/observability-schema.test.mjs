import test from 'node:test';
import assert from 'node:assert/strict';
import { logToolCall, openSession } from '../src/observability.mjs';

test('MCP logging follows physically moved tables and preserves upsert headers', async () => {
 const original=globalThis.fetch, calls=[];
 globalThis.fetch=async (url,options)=>{calls.push({url,options});return calls.length===1?Response.json({code:'PGRST205'},{status:404}):new Response(null,{status:204});};
 try {
  const env={SUPABASE_URL:'https://fixture.example',SUPABASE_SERVICE_ROLE_KEY:'fixture'};
  await openSession(env,{sessionId:'fixture'});
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.headers['Content-Profile'],'agents');
  assert.equal(calls[1].options.headers.authorization,'Bearer fixture');
  assert.equal(calls[1].options.headers.prefer,calls[0].options.headers.prefer);
  assert.equal(calls[1].options.body,calls[0].options.body);
  await logToolCall(env,{toolName:'fixture'});
  assert.equal(calls.length,3);
  assert.equal(calls[2].options.headers['Content-Profile'],'agents');
 } finally {globalThis.fetch=original;}
});

test('MCP logging does not retry authorization or server errors', async () => {
 const original=globalThis.fetch;
 try {
  for (const status of [401,403,409,429,500]) {
   let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({code:'42501'},{status});};
   await logToolCall({SUPABASE_URL:`https://failure-${status}.example`,SUPABASE_SERVICE_ROLE_KEY:'fixture'},{toolName:'fixture'});
   assert.equal(calls,1);
  }
 } finally {globalThis.fetch=original;}
});
