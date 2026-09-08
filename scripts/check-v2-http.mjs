// Metadata and unauthenticated transport only: no buyer token or purchase.
import assert from 'node:assert/strict';
import {ToolSchema} from '@modelcontextprotocol/sdk/types.js';
const base=process.env.APIOSK_MCP_TEST_ORIGIN || 'http://localhost:3002';
const card=await fetch(`${base}/.well-known/mcp/server-card.json`).then(r=>r.json());
const resource=await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then(r=>r.json());
assert.equal(card.authentication.required,true);
assert.equal(resource.resource,`${base}/mcp`);
assert.deepEqual(card.tools.map(t=>ToolSchema.parse(t).name),['apiosk_sources','apiosk_discover','apiosk_execute','apiosk_status','apiosk_approve']);
for(const method of ['initialize','tools/list','tools/call']) {
 const response=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:22,method,params:method==='tools/call'?{name:'apiosk_sources',arguments:{}}:{}})});
 assert.equal(response.status,401);
 assert.match(response.headers.get('www-authenticate'),/resource_metadata=/);
}
console.log('HTTP v2: five tool schemas (four model-visible), OAuth discovery and sign-in challenge before first use verified. No execution.');
