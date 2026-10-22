import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApioskMcpServer, resolveServerPresentation } from '../src/create-server.mjs';
import { V2_INSTRUCTIONS } from '../src/gateway-v2.mjs';
import { APIO_V2_CHATGPT_CARD_URI, APIO_V2_CARD_URI, APIO_V2_CARD_LEGACY_URIS, APIO_V2_MODERN_CARD_URIS } from '../src/gateway-v2-card.mjs';

test('source notice cards invalidate both host caches while keeping the preceding resources compatible',()=>{
 assert.notEqual(APIO_V2_CARD_URI,'ui://apiosk/gateway-v2-card-v57.html');
 assert.notEqual(APIO_V2_CHATGPT_CARD_URI,'ui://apiosk/gateway-v2-card-v21-chatgpt.html');
 assert.ok(APIO_V2_CARD_LEGACY_URIS.includes('ui://apiosk/gateway-v2-card-v57.html'));
 assert.ok(APIO_V2_MODERN_CARD_URIS.includes('ui://apiosk/gateway-v2-card-v57.html'));
 assert.ok(APIO_V2_CARD_LEGACY_URIS.includes('ui://apiosk/gateway-v2-card-v21-chatgpt.html'));
});

for (const host of ['chatgpt','claude']) test(`${host}: v2 initialize, tools and resource share the same contract`,async()=>{
 const env={APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082'};
 const server=createApioskMcpServer({env,hostedAuthEnabled:true,legacyUiMime:host==='chatgpt'});
 const expectedMime='text/html;profile=mcp-app';
 const client=new Client({name:host,version:'test'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(b);await client.connect(a);
  assert.equal(client.getInstructions(),V2_INSTRUCTIONS);
  assert.deepEqual(client.getServerVersion(),resolveServerPresentation(env).info);
  assert.equal(client.getServerCapabilities().extensions,undefined);
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),['apiosk_sources','apiosk_ask','apiosk_discover','apiosk_execute','apiosk_status','apiosk_approve']);
  for(const tool of tools){assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:['mcp:tools']}]);assert.equal(tool.outputSchema.type,'object')}
  for(const tool of tools.filter(tool=>tool.name!=='apiosk_approve')){
   assert.equal(tool._meta.ui.resourceUri,APIO_V2_CARD_URI);
   assert.equal(tool._meta['openai/outputTemplate'],APIO_V2_CHATGPT_CARD_URI);
   assert.notEqual(tool._meta.ui.resourceUri,tool._meta['openai/outputTemplate']);
  }
  assert.equal(tools.find(tool=>tool.name==='apiosk_approve')._meta.ui.resourceUri,undefined);
  assert.equal(tools.find(tool=>tool.name==='apiosk_approve')._meta['openai/outputTemplate'],undefined);
  const {resources}=await client.listResources();assert.equal(resources.length,3+APIO_V2_CARD_LEGACY_URIS.length);
  const contract=resources.find(r=>r.uri==='apiosk://v2/host-contract');
  const card=resources.find(r=>r.uri===APIO_V2_CARD_URI);
  assert.ok(contract);assert.ok(card);assert.equal(card.mimeType,expectedMime);
  const doc=await client.readResource({uri:contract.uri});assert.equal(doc.contents[0].text,V2_INSTRUCTIONS);
  const ui=await client.readResource({uri:card.uri});assert.match(ui.contents[0].text,/Apiosk balance/);assert.equal(ui.contents[0].mimeType,expectedMime);
  const compat=await client.readResource({uri:APIO_V2_CHATGPT_CARD_URI});assert.equal(compat.contents[0].mimeType,'text/html+skybridge');assert.equal(compat.contents[0].text,ui.contents[0].text);
  assert.equal(tools.find(t=>t.name==='apiosk_approve')._meta['openai/visibility'],'private');
  assert.equal(ui.contents[0]._meta.ui.domain,undefined);
  assert.equal(ui.contents[0]._meta['openai/widgetDomain'],'https://mcp.apiosk.com');
  assert.deepEqual(ui.contents[0]._meta['openai/widgetCSP'].redirect_domains,['https://app.apiosk.com','http://127.0.0.1:8082']);
  for(const uri of APIO_V2_CARD_LEGACY_URIS){
   assert.ok(resources.find(resource=>resource.uri===uri));
   const compatible=await client.readResource({uri});assert.match(compatible.contents[0].text,/Apiosk balance/);
   assert.equal(compatible.contents[0].mimeType,APIO_V2_MODERN_CARD_URIS.includes(uri)?'text/html;profile=mcp-app':uri.endsWith('-chatgpt.html')||host==='chatgpt'?'text/html+skybridge':'text/html;profile=mcp-app');
  }
  assert.deepEqual((await client.listPrompts()).prompts,[]);
  const result=await client.callTool({name:'apiosk_discover',arguments:{question:'Example'}});
  assert.equal(result.isError,true);assert.ok(result._meta['mcp/www_authenticate']);
 }finally{await client.close();await server.close();}
});

test('gateway v2 contract routes supplier onboarding through one qualified Apiosk task',()=>{
  for (const phrase of [
    'Supplier onboarding due diligence',
    'use `apiosk_discover` ONCE with the complete request',
    'one combined price ceiling and one purchase approval',
    'Never guess a company number or VAT number',
    'unknown—not clean',
    'surface `context_view.report.url` as the combined PDF',
    'one- or two-sentence summary',
  ]) assert.ok(V2_INSTRUCTIONS.includes(phrase),`missing supplier due-diligence contract: ${phrase}`);
});

test('Claude sends the complete Dutch client investigation once and receives one combined Gateway quote',async()=>{
  const question='Via Apiosk: Verzamel de bedrijfsgegevens, bestuurders en eigendomsstructuur van Financial Crime Compliance Associates; KVK-nummer: 91251982 voor een cliëntonderzoek. Vermeld de bronnen en geef aan welke informatie ontbreekt of nog gecontroleerd moet worden.';
  const requestId='00000000-0000-4000-8000-000000000001';
  const taskRef='00000000-0000-4000-8000-000000000002';
  const quoteRef='00000000-0000-4000-8000-000000000003';
  const state={schema_version:'2',state_ref:taskRef,revision:1,expires_at:'2099-01-01T00:00:00Z',focus:{entity_refs:[],goal_refs:[]},state_token:'fixture-signed-state'};
  // Fixture prices and sources exercise the transport contract, not live availability.
  const steps=['Company details','Directors','Ownership structure'];
  const stepDetails=steps.map((label,index)=>({label,source:{name:`Fixture source ${index+1}`,url:`https://source-${index+1}.example.test/`},max_cost_atomic:String((index+1)*100000)}));
  const coverage=['Ultimate beneficial ownership still requires independent verification.'];
  const plan={protocol_version:'2',request_id:requestId,status:'requires_approval',intent_ref:taskRef,
    context_view:{approval_mode:'chatbot',coverage_notices:coverage},
    proposal:{label:'Client investigation',quote_ref:quoteRef,price_status:'quoted',currency:'USD',max_total_atomic:'600000',expires_at:'2099-01-01T00:00:00Z',approval_url:`https://app.apiosk.test/approve/${taskRef}`,steps,step_details:stepDetails},
    result:null,billing:{authorization_active:false,total_charged:'0',currency:'USD'},next_actions:[],state,errors:[]};
  const requests=[];
  const server=createApioskMcpServer({env:{APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'},fetchImpl:async(url,options)=>{
    requests.push({path:url.pathname,method:options.method,body:JSON.parse(options.body)});
    return Response.json(plan);
  }});
  const client=new Client({name:'claude',version:'test'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(b);await client.connect(a);await client.listTools();
    const result=await client.callTool({name:'apiosk_discover',arguments:{question,request_id:requestId}});
    assert.equal(result.isError,undefined);
    assert.deepEqual(requests,[{path:'/v2/discover',method:'POST',body:{question,request_id:requestId}}]);
    assert.equal(result.structuredContent.status,'requires_approval');
    assert.deepEqual(result.structuredContent.proposal,{...plan.proposal,label:'Data request'});
    assert.deepEqual(result.structuredContent.context_view.coverage_notices,coverage);
    assert.deepEqual(result.structuredContent.state,state);
    assert.equal(result.structuredContent.billing.authorization_active,false);
    assert.equal(result.structuredContent.billing.total_charged,'0');
    assert.equal(result.content.filter(item=>item.type==='text'&&item.text.startsWith('Maximum total price:')).length,1);
    assert.match(result.content[0].text,/Maximum total price: 0\.60 USD/);
  }finally{await client.close();await server.close();}
});
