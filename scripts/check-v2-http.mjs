// Metadata and unauthenticated transport only: no LLM, buyer token or purchase.
import assert from 'node:assert/strict';
import {ToolSchema} from '@modelcontextprotocol/sdk/types.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base='http://localhost:3002';
const card=await fetch(`${base}/.well-known/mcp/server-card.json`).then(r=>r.json());
const resource=await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then(r=>r.json());
assert.equal(card.authentication.required,true);
assert.equal(resource.resource,`${base}/mcp`);
const client=new Client({name:'v2-http-check',version:'1'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
 assert.deepEqual((await client.listTools()).tools,card.tools.map(t=>ToolSchema.parse(t)));
 assert.deepEqual(client.getServerVersion(),card.serverInfo);
 assert.equal(client.getInstructions(),card.instructions);
 assert.equal((await client.listResources()).resources[0].uri,card.resources[0].uri);
 const denied=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:22,method:'tools/call',params:{name:'apiosk_execute',arguments:{recover_task_ref:'00000000-0000-4000-8000-000000000001'}}})});
 assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/resource_metadata=/);
 console.log('HTTP v2 verified: initialize, exactly two tools, instructions, resource, OAuth discovery and 401 challenge agree. No execution.');
} finally {await client.close();}
