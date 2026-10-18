import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { APIO_V2_CARD_HTML } from '../src/gateway-v2-card.mjs';
import { preKybVerdictAnalysis, preKybVerdictView, supplierVerdictView } from '../src/gateway-v2-card-verdict.mjs';

// Contract: gateway/docs/pre-kyb-check.md. The gateway decides; the card only shows.
function harness(html) {
  const sent=[],listeners=new Map(),nodes=new Map();
  const el=(name='div')=>({nodeType:1,tagName:name.toUpperCase(),textContent:'',value:'',disabled:false,dataset:{},children:[],isConnected:true,get lastElementChild(){return this.children.at(-1)},classList:{add(){},remove(){},contains(){return false}},append(...c){this.children.push(...c)},prepend(...c){this.children.unshift(...c)},replaceChildren(...c){this.children=c},querySelector(selector){return this.querySelectorAll(selector)[0]},querySelectorAll(selector){return this.children.flatMap(c=>[...(selector.split(',').some(s=>s.startsWith('.')?(c.className||'').split(' ').includes(s.slice(1)):s===c.tagName.toLowerCase())?[c]:[]),...c.querySelectorAll(selector)])},setAttribute(name,value){this[name]=value},focus(){},addEventListener(name,fn){this['on'+name]=fn}});
  const element=name=>Object.assign(el(name),{remove(){},after(){}});
  const document={documentElement:{scrollWidth:320,scrollHeight:200,dataset:{},style:{}},getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},createElement:element};
  const parent={postMessage(m){sent.push(m)}};
  const window={parent,addEventListener(n,fn){listeners.set(n,fn)}};
  const ctx=vm.createContext({window,document,URL,Intl,console,setInterval:()=>0,clearInterval(){},setTimeout:()=>0,clearTimeout(){},ResizeObserver:class{observe(){}}});
  for(const s of html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(s[1],ctx);
  const message=async data=>{listeners.get('message')?.({source:parent,data});await Promise.resolve();await Promise.resolve()};
  return {
    sent,nodes,
    async show(structuredContent){
      const init=sent.find(m=>m.method==='ui/initialize');
      await message({jsonrpc:'2.0',id:init.id,result:{hostInfo:{name:'test-host',version:'1'},hostCapabilities:{serverTools:{},message:{text:{}},openLinks:{},updateModelContext:{text:{}}}}});
      await message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent}});
    },
    find(selector){return nodes.get('sections').querySelectorAll(selector)},
    texts(){const all=[];const walk=n=>{if(n.textContent)all.push(n.textContent);for(const c of n.children||[])walk(c)};walk(nodes.get('sections'));return all},
  };
}

const ref='00000000-0000-0000-0000-000000000000';
const evidence=[{result_ref:ref,pointer:'/data/kvkNummer',value:'12345678'}];
function analysis(decision='pass',extra={}){
  return {status:'completed',kind:'pre_kyb_check',
    verdict:{decision,label:{pass:'PASS',review:'REVIEW',reject:'REJECT'}[decision],language:'en',
      headline:{pass:'✅ PASS: no red flags in the completed checks',review:'🔎 REVIEW: a human must look',reject:'⛔ REJECT: the company is dissolved'}[decision],
      reasons:decision==='pass'?[]:['Company status is in liquidation.','Sanctions screen returned one unconfirmed candidate.'],
      next_action:'Proceed to full KYB. This pre-screen complements it and does not replace it.',
      subject:{name:'Example B.V.',country:'NL',screening_level:'Standard',registration:'12345678',vat_number:null,domain:'example.nl',iban_masked:null},
      identity:[
        {id:'legal_name',label:'Legal name',value:'Example B.V.',source:'KVK',result_ref:ref,retrieved_at:'2026-10-18T10:00:00Z',evidence:[{result_ref:ref,pointer:'/data/statutaireNaam',value:'Example B.V.'}]},
        {id:'registration_number',label:'Registration number',value:'12345678',source:'KVK',result_ref:ref,retrieved_at:'2026-10-18T10:00:00Z',evidence},
        {id:'status',label:'Status',value:'Active',source:'KVK',result_ref:ref,retrieved_at:'2026-10-18T10:00:00Z',evidence:[]},
      ],
      checks:[
        {id:'identity_resolved',label:'Registered identity resolved',status:'pass',detail:'Registered with KVK under 12345678.',source:'KVK',evidence},
        {id:'sanctions',label:'Sanctions screen',status:decision==='pass'?'pass':'warn',detail:decision==='pass'?'No candidates returned.':'One unconfirmed candidate.',source:'OpenSanctions',evidence:[]},
        {id:'domain',label:'Domain age',status:'unknown',detail:'RDAP unavailable.',source:'RDAP & DNS',evidence:[]},
        {id:'filings',label:'Filed accounts',status:'not_selected',detail:'Enhanced screening adds filed accounts.',source:'KVK',evidence:[]},
      ],
      coverage_gaps:['Directors and owners were not individually screened for sanctions, PEP status or disqualification.','Ultimate beneficial ownership was not established.'],
      ...extra},
    observations:[{text:'LEGACY OBSERVATION TEXT',evidence}],
    limitations:['Register data as returned on the retrieval date.']};
}
const done=(context_view,extra={})=>({status:'succeeded',state:{state_ref:'pre-kyb-task',revision:3},next_actions:[],context_view,...extra});

test('pre-KYB view maps pass, review and reject to fixed labels and icons', () => {
  for(const [decision,icon,label] of [['pass','✅','PASS'],['review','🔎','REVIEW'],['reject','⛔','REJECT']]){
    const view=preKybVerdictView(analysis(decision));
    assert.equal(view.decision,decision);assert.equal(view.icon,icon);assert.equal(view.label,label);
    assert.equal(view.headline,analysis(decision).verdict.headline);
  }
  // A label from another decision never reaches the banner.
  const mislabeled=analysis('reject');mislabeled.verdict.label='PASS';
  assert.equal(preKybVerdictView(mislabeled).label,'REJECT');
});

test('pre-KYB view rejects other kinds and unknown decisions, and never claims a supplier verdict', () => {
  assert.equal(preKybVerdictView(null),null);
  assert.equal(preKybVerdictView({status:'completed',observations:[]}),null);
  assert.equal(preKybVerdictView({...analysis(),kind:'supplier_payment_check'}),null);
  assert.equal(preKybVerdictView({...analysis(),kind:'research'}),null);
  const bad=analysis();bad.verdict.decision='ok';assert.equal(preKybVerdictView(bad),null);
  const hold=analysis();hold.verdict.decision='hold';assert.equal(preKybVerdictView(hold),null);
  assert.equal(preKybVerdictView({kind:'pre_kyb_check',verdict:null}),null);
  assert.equal(supplierVerdictView(analysis()),null);
});

test('pre-KYB view normalises statuses, strings and lists defensively without mutating the input', () => {
  const data=analysis('review');
  data.verdict.checks[0].status='bogus';
  data.verdict.checks.push(null,{label:'   '},{id:'iban',label:'  IBAN  ',status:'fail',detail:'  invalid  ',source:'  IBAN check ',evidence:'nope'});
  data.verdict.identity.push(null,{label:'No value',value:null,source:'KVK'},{id:'trade_names',label:'Trade names',value:['Example','Voorbeeld'],source:'KVK'});
  data.verdict.reasons=['  padded  ',42,null,''];
  data.verdict.coverage_gaps='not a list';
  data.verdict.subject=null;data.limitations=null;
  const before=JSON.stringify(data);
  const view=preKybVerdictView(data);
  assert.equal(JSON.stringify(data),before);
  assert.deepEqual(view.checks.map(c=>c.status),['unknown','warn','unknown','not_selected','fail']);
  assert.equal(view.checks.at(-1).label,'IBAN');assert.equal(view.checks.at(-1).detail,'invalid');assert.equal(view.checks.at(-1).source,'IBAN check');assert.deepEqual(view.checks.at(-1).evidence,[]);
  assert.deepEqual(view.identity.map(i=>i.value),['Example B.V.','12345678','Active','Example, Voorbeeld']);
  assert.deepEqual(view.reasons,['padded']);
  assert.deepEqual(view.coverage_gaps,[]);
  assert.deepEqual(view.limitations,[]);
  assert.deepEqual(view.subject,{name:null,country:null,screening_level:null,registration:null,vat:null,domain:null,iban:null});
  assert.equal(view.partial,false);
  assert.equal(preKybVerdictView({...analysis(),status:'partial'}).partial,true);
});

test('saved turn pre-KYB analysis is used only when the current turn has no analysis', () => {
  const saved={context_view:{conversation:[{question:'q1',output:{analysis:analysis('review')}},{question:'q2',output:null}]}};
  assert.equal(preKybVerdictView(preKybVerdictAnalysis(saved)).decision,'review');
  const current={context_view:{...saved.context_view,analysis:{status:'completed',observations:[]}}};
  assert.equal(preKybVerdictView(preKybVerdictAnalysis(current)),null);
});

test('the card prefers the pre-KYB view and renders headline, identity, checks, gaps and the fixed sentence', async () => {
  const h=harness(APIO_V2_CARD_HTML);
  await h.show(done({results:[{subject:{label:'Example B.V.'},source:{name:'KVK'},data:{statutaireNaam:'Example B.V.'}}],analysis:analysis('pass')}));
  const [banner]=h.find('.verdict-banner');
  assert.equal(banner.className,'verdict-banner pass');
  assert.deepEqual(banner.children.map(n=>n.textContent),['✅','PASS']);
  assert.equal(h.find('.verdict-headline')[0].textContent,'✅ PASS: no red flags in the completed checks');
  assert.equal(h.find('.verdict-supplier')[0].textContent,'Example B.V. · NL · Registration 12345678 · example.nl · Standard screening');
  const rows=h.find('.identity-line');
  assert.deepEqual(rows.map(r=>r.children.map(c=>c.textContent)),[['Legal name','Example B.V.','KVK'],['Registration number','12345678','KVK'],['Status','Active','KVK']]);
  assert.deepEqual(h.find('.verdict-check').map(n=>n.className),['verdict-check pass','verdict-check pass','verdict-check unknown','verdict-check not_selected']);
  assert.deepEqual(h.find('.check-icon').map(n=>n.textContent),['✓','✓','?','–']);
  const texts=h.texts();
  assert.ok(texts.includes('Identity'));assert.ok(texts.includes('Checks'));assert.ok(texts.includes('Not covered'));assert.ok(texts.includes('Next step'));
  assert.ok(texts.includes('Enhanced only'));assert.ok(texts.includes('Not verified'));assert.ok(texts.includes('Source: OpenSanctions'));
  assert.ok(texts.includes('Ultimate beneficial ownership was not established.'));
  assert.ok(texts.includes('Proceed to full KYB. This pre-screen complements it and does not replace it.'));
  assert.ok(texts.includes('Preliminary screening before full KYB, not a replacement for it.'));
  assert.ok(texts.includes('Register data as returned on the retrieval date.'));
  assert.ok(!texts.includes('Why'),'a pass has no reasons list');
  assert.ok(!texts.some(t=>t.includes('LEGACY OBSERVATION TEXT')));
  assert.ok(!texts.includes('Supplier payment check'));
  assert.equal(h.nodes.get('title').textContent,'Pre-KYB check');
  assert.equal(h.sent.filter(m=>m.method==='tools/call').length,0);
});

test('review and reject cards carry their own banner class, reasons under Why, and a partial notice', async () => {
  for(const [decision,icon,label] of [['review','🔎','REVIEW'],['reject','⛔','REJECT']]){
    const h=harness(APIO_V2_CARD_HTML);
    await h.show(done({analysis:{...analysis(decision),status:'partial'}},{status:'partial'}));
    const [banner]=h.find('.verdict-banner');
    assert.equal(banner.className,'verdict-banner '+decision);
    assert.deepEqual(banner.children.map(n=>n.textContent),[icon,label]);
    assert.deepEqual(h.find('.verdict-reasons')[0].children.map(n=>n.textContent),['Company status is in liquidation.','Sanctions screen returned one unconfirmed candidate.']);
    const texts=h.texts();
    assert.ok(texts.includes('Why'));assert.ok(texts.includes('Not every check could be completed.'));
  }
});

test('gateway text in a pre-KYB verdict is rendered as text, never as markup', async () => {
  const hostile='<img src=x onerror="alert(1)">';
  const data=analysis('review');
  data.verdict.headline=hostile;data.verdict.reasons=[hostile];data.verdict.subject.name=hostile;data.verdict.identity[0].value=hostile;data.verdict.identity[0].source=hostile;data.verdict.checks[0].detail=hostile;data.verdict.coverage_gaps=[hostile];data.verdict.next_action=hostile;
  const h=harness(APIO_V2_CARD_HTML);await h.show(done({analysis:data}));
  assert.equal(h.find('.verdict-headline')[0].textContent,hostile);
  assert.equal(h.find('.verdict-reasons')[0].children[0].textContent,hostile);
  assert.ok(h.find('.verdict-supplier')[0].textContent.startsWith(hostile+' · '));
  assert.deepEqual(h.find('.identity-line')[0].children.slice(1).map(c=>c.textContent),[hostile,hostile]);
  assert.equal(h.find('.check-detail')[0].textContent,hostile);
  assert.equal(h.find('.verdict-gaps')[0].children[0].textContent,hostile);
  assert.equal(h.find('.verdict-next')[0].textContent,hostile);
  assert.equal(h.find('img').length,0);
  const source=readFileSync(new URL('../src/gateway-v2-card-verdict.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('a saved pre-KYB turn renders its verdict when the card is recovered', async () => {
  const h=harness(APIO_V2_CARD_HTML);
  await h.show(done({conversation:[{question:'Who is Example B.V. really?',output:{status:'succeeded',analysis:analysis('reject')}},{question:'And the address?',reply:null,output:null}]}));
  assert.equal(h.find('.verdict-banner')[0].className,'verdict-banner reject');
  assert.ok(h.texts().includes('Company status is in liquidation.'));
});
