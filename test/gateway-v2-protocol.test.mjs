import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApioskMcpServer, resolveServerPresentation } from '../src/create-server.mjs';
import { V2_INSTRUCTIONS } from '../src/gateway-v2.mjs';

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
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),['apiosk_discover','apiosk_execute']);
  for(const tool of tools) assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:['mcp:tools']}]);
  const {resources}=await client.listResources();assert.equal(resources.length,1);
  const doc=await client.readResource({uri:resources[0].uri});assert.equal(doc.contents[0].text,V2_INSTRUCTIONS);
  assert.deepEqual((await client.listPrompts()).prompts,[]);
  const result=await client.callTool({name:'apiosk_discover',arguments:{question:'Example'}});
  assert.equal(result.isError,true);assert.ok(result._meta['mcp/www_authenticate']);
 }finally{await client.close();await server.close();}
});
