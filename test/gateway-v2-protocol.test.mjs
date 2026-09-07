import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApioskMcpServer, resolveServerPresentation } from '../src/create-server.mjs';
import { V2_INSTRUCTIONS } from '../src/gateway-v2.mjs';
import { APIO_V2_CARD_URI } from '../src/gateway-v2-card.mjs';

for (const host of ['chatgpt','claude']) test(`${host}: v2 initialize, tools and resource share the same contract`,async()=>{
 const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082'};
 const server=createApioskMcpServer({env,hostedAuthEnabled:true});
 const client=new Client({name:host,version:'test'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(b);await client.connect(a);
  assert.equal(client.getInstructions(),V2_INSTRUCTIONS);
  assert.deepEqual(client.getServerVersion(),resolveServerPresentation(env).info);
  assert.equal(client.getServerCapabilities().extensions,undefined);
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),['apiosk_sources','apiosk_discover','apiosk_execute']);
  for(const tool of tools){assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:['mcp:tools']}]);assert.equal(tool.outputSchema.type,'object')}
  const {resources}=await client.listResources();assert.equal(resources.length,2);
  const contract=resources.find(r=>r.uri==='apiosk://v2/host-contract');
  const card=resources.find(r=>r.uri===APIO_V2_CARD_URI);
  assert.ok(contract);assert.ok(card);assert.match(card.mimeType,/text\/html/);
  const doc=await client.readResource({uri:contract.uri});assert.equal(doc.contents[0].text,V2_INSTRUCTIONS);
  const ui=await client.readResource({uri:card.uri});assert.match(ui.contents[0].text,/Apiosk balance/);
  assert.deepEqual((await client.listPrompts()).prompts,[]);
  const result=await client.callTool({name:'apiosk_discover',arguments:{question:'Example'}});
  assert.equal(result.isError,true);assert.ok(result._meta['mcp/www_authenticate']);
 }finally{await client.close();await server.close();}
});
