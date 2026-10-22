import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApioskMcpServer, resolveServerPresentation } from '../src/create-server.mjs';
import { V2_INSTRUCTIONS } from '../src/gateway-v2.mjs';
import { APIO_V2_CHATGPT_CARD_URI, APIO_V2_CARD_URI, APIO_V2_CARD_LEGACY_URIS, APIO_V2_MODERN_CARD_URIS } from '../src/gateway-v2-card.mjs';

test('source notice cards invalidate both host caches while keeping the preceding resources compatible',()=>{
 assert.notEqual(APIO_V2_CARD_URI,'ui://apiosk/gateway-v2-card-v59.html');
 assert.notEqual(APIO_V2_CHATGPT_CARD_URI,'ui://apiosk/gateway-v2-card-v23-chatgpt.html');
 assert.ok(APIO_V2_CARD_LEGACY_URIS.includes('ui://apiosk/gateway-v2-card-v59.html'));
 assert.ok(APIO_V2_MODERN_CARD_URIS.includes('ui://apiosk/gateway-v2-card-v59.html'));
 assert.ok(APIO_V2_CARD_LEGACY_URIS.includes('ui://apiosk/gateway-v2-card-v23-chatgpt.html'));
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
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),['apiosk_sources','apiosk_ask','apiosk_discover','apiosk_execute','apiosk_status','apiosk_approve','apiosk_requote']);
  for(const tool of tools){assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:['mcp:tools']}]);assert.equal(tool.outputSchema.type,'object')}
  for(const tool of tools.filter(tool=>!['apiosk_approve','apiosk_requote'].includes(tool.name))){
   assert.equal(tool._meta.ui.resourceUri,APIO_V2_CARD_URI);
   assert.equal(tool._meta['openai/outputTemplate'],APIO_V2_CHATGPT_CARD_URI);
   assert.notEqual(tool._meta.ui.resourceUri,tool._meta['openai/outputTemplate']);
  }
  for(const name of ['apiosk_approve','apiosk_requote']){
    const tool=tools.find(tool=>tool.name===name);
    assert.equal(tool._meta.ui.resourceUri,undefined);
    assert.equal(tool._meta['openai/outputTemplate'],undefined);
    assert.deepEqual(tool._meta.ui.visibility,['app']);
    assert.equal(tool._meta['openai/visibility'],'private');
  }
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

test('connected original requirements and gaps survive planning and free saved-result reads in both output channels',async()=>{
  const requestId='00000000-0000-4000-8000-000000000011',taskRef='00000000-0000-4000-8000-000000000012';
  const question='Verzamel bedrijfsgegevens, bestuurders en eigendomsstructuur van Financial Crime Compliance Associates; KVK 91251982. Vermeld ontbrekende informatie.';
  const originalIntake={parsed_request:{subjects:[{id:'s1',label:'Financial Crime Compliance Associates',type:'company',identifiers:{kvk_number:'91251982'}}],capabilities:[{slug:'company.profile',subject_id:'s1',outputs:['company_details','directors','ownership_structure','sources','missing_information']}]},matches:[],selected_capabilities:['company.profile']};
  const connectedCoverage={original_intake:originalIntake,gaps:[{subject:'Financial Crime Compliance Associates',output:'directors'},{subject:'Financial Crime Compliance Associates',output:'ownership_structure'}],limitations:[]};
  const notices=['This price covers only the listed source calls. Not retrieved or verified: directors and ownership structure. These items remain missing.'];
  const state={schema_version:'2',state_ref:taskRef,revision:1,expires_at:'2099-01-01T00:00:00Z',focus:{entity_refs:[],goal_refs:[]},state_token:'fixture'};
  const saved={source:{name:'Fixture register',url:'https://registry.example.test'},data:{name:'Financial Crime Compliance Associates',kvk_number:'91251982'}};
  const base={protocol_version:'2',request_id:requestId,intent_ref:taskRef,context_view:{connected_coverage:connectedCoverage,coverage_notices:notices},proposal:null,result:null,billing:{authorization_active:false,total_charged:'0',currency:'USD'},next_actions:[],state,errors:[]};
  const quoted={...base,status:'requires_approval',proposal:{label:'Company details only',quote_ref:requestId,price_status:'quoted',currency:'USD',max_total_atomic:'100000',expires_at:'2099-01-01T00:00:00Z',approval_url:`https://app.apiosk.test/approve/${taskRef}`,steps:['company.profile'],step_details:[{source:saved.source}]}};
  const payloads=[quoted,{...base,status:'partial',result:saved,context_view:{...base.context_view,results:[saved]}},{...base,status:'succeeded',result:saved,context_view:{...base.context_view,results:[saved]}}];
  const requests=[];
  const server=createApioskMcpServer({env:{APIOSK_GATEWAY_V2_URL:'http://127.0.0.1:8082',APIOSK_CONNECT_TOKEN:'fixture'},fetchImpl:async(url,options)=>{
    requests.push({path:url.pathname,method:options.method,body:options.body});return Response.json(payloads.shift());
  }});
  const client=new Client({name:'claude',version:'test'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(b);await client.connect(a);await client.listTools();
    for(const [name,args] of [['apiosk_discover',{question,request_id:requestId}],['apiosk_status',{task_ref:taskRef}],['apiosk_status',{task_ref:taskRef}]]){
      const reply=await client.callTool({name,arguments:args});
      assert.equal(reply.isError,undefined);
      assert.deepEqual(reply.structuredContent.context_view.connected_coverage,connectedCoverage);
      assert.deepEqual(reply.structuredContent.context_view.coverage_notices,notices);
      const textEnvelope=reply.content.find(item=>item.type==='text'&&item.text.startsWith('{'));
      assert.deepEqual(JSON.parse(textEnvelope.text),reply.structuredContent,'text-only hosts receive the same coverage evidence');
      if(name==='apiosk_status')assert.deepEqual(reply.structuredContent.result,saved);
    }
    assert.deepEqual(requests,[{path:'/v2/discover',method:'POST',body:JSON.stringify({question,request_id:requestId})},...Array.from({length:2},()=>({path:`/v2/tasks/${taskRef}`,method:'GET',body:undefined}))]);
  }finally{await client.close();await server.close();}
});
