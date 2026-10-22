// Metadata and unauthenticated transport only: no buyer token or purchase.
import assert from 'node:assert/strict';
import {ToolSchema} from '@modelcontextprotocol/sdk/types.js';
const base=process.env.APIOSK_MCP_TEST_ORIGIN || 'http://localhost:3002';
const card=await fetch(`${base}/.well-known/mcp/server-card.json`).then(r=>r.json());
const resource=await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then(r=>r.json());
assert.equal(card.authentication.required,true);
assert.equal(resource.resource,`${base}/mcp`);
assert.deepEqual(card.tools.map(t=>ToolSchema.parse(t).name).sort(),['apiosk_approve','apiosk_ask','apiosk_discover','apiosk_execute','apiosk_requote','apiosk_sources','apiosk_status']);
for(const name of ['apiosk_approve','apiosk_requote']){
 const tool=card.tools.find(tool=>tool.name===name);
 assert.deepEqual(tool._meta.ui.visibility,['app']);
 assert.equal(tool._meta['openai/visibility'],'private');
 assert.equal(tool._meta.ui.resourceUri,undefined);
 assert.equal(tool._meta['openai/outputTemplate'],undefined);
}
for(const method of ['initialize','tools/list','tools/call']) {
 const response=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:22,method,params:method==='tools/call'?{name:'apiosk_sources',arguments:{}}:{}})});
 assert.equal(response.status,401);
 assert.match(response.headers.get('www-authenticate'),/resource_metadata=/);
}
console.log('HTTP v2: seven tool schemas (five model-visible), OAuth discovery and sign-in challenge before first use verified. No execution.');
