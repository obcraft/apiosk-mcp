import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { APIO_V2_CARD_HTML } from '../src/gateway-v2-card.mjs';
import { supplierVerdictAnalysis, supplierVerdictView } from '../src/gateway-v2-card-verdict.mjs';

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

const evidence=[{result_ref:'r1',pointer:'/data/iban_changed',value:true}];
function analysis(decision='hold',language='nl',extra={}){
  return {status:'completed',kind:'supplier_payment_check',
    verdict:{decision,language,
      label:{hold:{nl:'BETALING TEGENHOUDEN',en:'HOLD PAYMENT'},review:{nl:'EERST CONTROLEREN',en:'REVIEW BEFORE PAYING'},ok:{nl:'GEEN RODE VLAGGEN GEVONDEN',en:'NO RED FLAGS FOUND'}}[decision][language],
      headline:'⚠️ HOLD PAYMENT',
      reasons:['IBAN is gewijzigd.','Domein geregistreerd 12 dagen geleden.'],
      supplier:{name:'Acme B.V.',kvk_number:'12345678',vat_number:'NL123456789B01',iban_masked:'NL91 •••• 4300',domain:'acme.nl'},
      checks:[
        {id:'company_exists',label:'Bedrijf bestaat',status:'pass',detail:'Ingeschreven bij KVK.',source:'KVK Handelsregister',evidence},
        {id:'recent_changes',label:'Recente wijzigingen',status:'fail',detail:'IBAN is gewijzigd.',source:'Bankverificatie',evidence:[]},
        {id:'domain_age',label:'Domeinleeftijd',status:'warn',detail:'12 dagen oud.',source:null,evidence:[]},
        {id:'sanctions_pep',label:'Sancties en PEP',status:'unknown',detail:'Geen bron beschikbaar.',source:null,evidence:[]},
      ],...extra},
    observations:[{text:'LEGACY OBSERVATION TEXT',evidence}],
    limitations:['Factuurhistorie is niet gecontroleerd.']};
}
const done=(context_view,extra={})=>({status:'succeeded',state:{state_ref:'supplier-task',revision:3},next_actions:[],context_view,...extra});

test('detector accepts only a supplier verdict and never shows a label from another decision', () => {
  assert.equal(supplierVerdictView({status:'completed',observations:[]}),null);
  assert.equal(supplierVerdictView({...analysis(),kind:'research'}),null);
  const unknownDecision=analysis();unknownDecision.verdict.decision='maybe';
  assert.equal(supplierVerdictView(unknownDecision),null);
  const mismatched=analysis('hold','en');mismatched.verdict.label='NO RED FLAGS FOUND';mismatched.verdict.checks[0].status='bogus';
  const view=supplierVerdictView(mismatched);
  assert.equal(view.label,'HOLD PAYMENT');assert.equal(view.icon,'⚠️');
  assert.equal(view.checks[0].status,'unknown');
  const input=analysis(),before=JSON.stringify(input);supplierVerdictView(input);assert.equal(JSON.stringify(input),before);
});

test('saved turn verdict is used only when the current turn has no analysis', () => {
  const saved={context_view:{conversation:[{question:'q1',output:{analysis:analysis('ok','en')}},{question:'q2',output:null}]}};
  assert.equal(supplierVerdictAnalysis(saved).verdict.decision,'ok');
  const current={context_view:{...saved.context_view,analysis:{status:'completed',observations:[]}}};
  assert.equal(supplierVerdictView(supplierVerdictAnalysis(current)),null);
});

test('hold verdict renders banner, reasons, supplier, checks and limitations instead of observations', async () => {
  const h=harness(APIO_V2_CARD_HTML);
  await h.show(done({results:[{subject:{label:'Acme B.V.'},source:{name:'KVK'},data:{naam:'Acme B.V.'}}],analysis:analysis('hold','nl')}));
  const [banner]=h.find('.verdict-banner');
  assert.equal(banner.className,'verdict-banner hold');
  assert.deepEqual(banner.children.map(n=>n.textContent),['⚠️','BETALING TEGENHOUDEN']);
  assert.deepEqual(h.find('.verdict-reasons')[0].children.map(n=>n.textContent),['IBAN is gewijzigd.','Domein geregistreerd 12 dagen geleden.']);
  assert.equal(h.find('.verdict-supplier')[0].textContent,'Acme B.V. · KVK 12345678 · Btw NL123456789B01 · IBAN NL91 •••• 4300 · acme.nl');
  assert.deepEqual(h.find('.verdict-check').map(n=>n.className),['verdict-check pass','verdict-check fail','verdict-check warn','verdict-check unknown']);
  assert.deepEqual(h.find('.check-icon').map(n=>n.textContent),['✓','✕','!','?']);
  const texts=h.texts();
  assert.ok(texts.includes('Bron: KVK Handelsregister'));
  assert.ok(texts.includes('Niet geverifieerd'));
  assert.ok(texts.includes('Factuurhistorie is niet gecontroleerd.'));
  assert.ok(!texts.some(t=>t.includes('LEGACY OBSERVATION TEXT')));
  assert.ok(!texts.includes('Analysis'));
  const proof=h.find('.evidence-details');assert.equal(proof.length,1);assert.ok(!proof[0].open);
  assert.ok(texts.includes('true · /data/iban_changed'));
  assert.ok(h.find('details').some(n=>n.className==='full-result'&&!n.open),'source result details stay collapsed');
  assert.equal(h.nodes.get('title').textContent,'Leverancierscontrole');
  assert.equal(h.sent.filter(m=>m.method==='tools/call').length,0);
});

test('review and ok verdicts use their own colour class, icon and English copy', async () => {
  for(const [decision,icon,label] of [['review','🔎','REVIEW BEFORE PAYING'],['ok','✅','NO RED FLAGS FOUND']]){
    const h=harness(APIO_V2_CARD_HTML);
    await h.show(done({analysis:analysis(decision,'en')}));
    const [banner]=h.find('.verdict-banner');
    assert.equal(banner.className,'verdict-banner '+decision);
    assert.deepEqual(banner.children.map(n=>n.textContent),[icon,label]);
    const texts=h.texts();
    assert.ok(texts.includes('Supplier payment check'));assert.ok(texts.includes('Not verified'));assert.ok(texts.includes('Checks'));
  }
});

test('gateway and invoice text is rendered as text, never as markup', async () => {
  const hostile='<img src=x onerror="alert(1)">';
  const data=analysis('review','en');data.verdict.reasons=[hostile];data.verdict.supplier.name=hostile;data.verdict.checks[0].detail=hostile;data.limitations=[hostile];
  const h=harness(APIO_V2_CARD_HTML);await h.show(done({analysis:data}));
  assert.equal(h.find('.verdict-reasons')[0].children[0].textContent,hostile);
  assert.ok(h.find('.verdict-supplier')[0].textContent.startsWith(hostile+' · '));
  assert.equal(h.find('.check-detail')[0].textContent,hostile);
  assert.equal(h.find('.img').length+h.find('img').length,0);
  const source=readFileSync(new URL('../src/gateway-v2-card-verdict.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('a partial supplier check shows its limitations once and says checks are incomplete', async () => {
  const h=harness(APIO_V2_CARD_HTML);
  await h.show(done({analysis:{...analysis('review','nl'),status:'partial'},report:{format:'pdf',url:'https://api.apiosk.com/r.pdf'}},{status:'partial'}));
  const texts=h.texts();
  assert.equal(texts.filter(t=>t==='Factuurhistorie is niet gecontroleerd.').length,1);
  assert.ok(texts.includes('Niet alle controles zijn afgerond.'));
  assert.ok(!texts.some(t=>t.includes('LEGACY OBSERVATION TEXT')));
  assert.ok(h.find('button').some(n=>n.textContent==='Download PDF'));
});

test('a saved supplier turn renders its verdict when the card is recovered', async () => {
  const h=harness(APIO_V2_CARD_HTML);
  await h.show(done({conversation:[{question:'Kan ik deze leverancier veilig betalen?',output:{status:'succeeded',analysis:analysis('hold','nl')}},{question:'En het adres?',reply:null,output:null}]}));
  const [banner]=h.find('.verdict-banner');
  assert.equal(banner.className,'verdict-banner hold');
  assert.ok(h.texts().includes('IBAN is gewijzigd.'));
});
