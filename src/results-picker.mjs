// The choice, as something to click.
//
// This is the HTML half of the same step src/elicit.mjs asks natively: the
// runnable offers for one job, their prices, and one button that runs the one
// the person picked. Both read the `selection` object src/selection.mjs builds,
// so a row is called the same thing in a picker, in a card and in prose.
//
// WHAT IT NEVER SHOWS. One price per row and no second number — no list price,
// no provider leg, no fee — because there is no surface in this product that
// shows what a call is composed of. And no provider text is ever inserted as
// markup: every string goes in through `textContent`, because `description` and
// `name` are provider-supplied and a card that renders them as HTML is a card
// that renders whatever a publisher decided to put in its own listing.

import { APIOSK_UI_BRIDGE, APIOSK_UI_STYLE, uiResourceMeta } from "./ui-bridge.mjs";

export const APIO_RESULTS_PICKER_URI = "ui://apiosk/results-picker.html";

export const APIO_RESULTS_PICKER_META = uiResourceMeta(
  "Lists the APIs that can do the job with one price each, lets the user pick one, collects its required inputs, and runs only that one."
);

export const APIO_RESULTS_PICKER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${APIOSK_UI_STYLE}
.rows{display:grid;gap:8px;margin-top:12px}
.row{display:grid;grid-template-columns:18px 1fr auto;gap:10px;align-items:start;padding:11px 12px;border:1px solid color-mix(in srgb,CanvasText 13%,transparent);border-radius:12px;cursor:pointer}
.row[data-picked="true"]{border-color:#167a50;background:color-mix(in srgb,#167a50 8%,transparent)}
.row input{margin:2px 0 0}
.name{font-weight:650;font-size:14px}
.price{font-weight:750;font-size:14px;white-space:nowrap}
.tag{font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.6;margin-left:6px}
.fields{display:grid;gap:10px;margin-top:14px}
.field{display:grid;gap:5px}.field label{font-size:12px;font-weight:650}.required{color:#b94848}
input[type=text],input[type=number],select{width:100%;padding:9px 10px;border-radius:9px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);background:Canvas;color:CanvasText;font:inherit}
</style></head>
<body><main class="card">
<div class="eyebrow">Choose a source</div><h2 id="job">Apiosk</h2>
<div id="rows" class="rows"></div>
<form id="fields" class="fields"></form>
<div class="actions"><button id="run" class="primary" type="button">Approve</button><button id="stop" class="secondary" type="button">Deny</button></div>
<div id="status" class="status" role="status" aria-live="polite"></div>
</main>
<script>${APIOSK_UI_BRIDGE}
const byId=id=>document.getElementById(id),job=byId('job'),rows=byId('rows'),fields=byId('fields'),run=byId('run'),stop=byId('stop'),status=byId('status');
let options=[],picked=null,busy=false,completed=false;
function setStatus(text,kind){status.textContent=text||'';status.className='status '+(kind||'')}
function value(control,type){if(type==='boolean')return control.checked;const raw=control.value;
 if(raw==='')return undefined;if(type==='integer')return Math.trunc(Number(raw));if(type==='number')return Number(raw);return raw}
function drawField(field){const wrap=document.createElement('div');wrap.className='field';
 const label=document.createElement('label');label.htmlFor='in-'+field.name;label.textContent=field.label||field.name;
 if(field.required){const star=document.createElement('span');star.className='required';star.textContent=' *';label.append(star)}
 let control;
 if(Array.isArray(field.options)&&field.options.length){control=document.createElement('select');
  const blank=document.createElement('option');blank.value='';blank.textContent='Choose…';
  control.append(blank,...field.options.map(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;return o}))}
 else{control=document.createElement('input');
  control.type=field.type==='boolean'?'checkbox':(['integer','number'].includes(field.type)?'number':'text');
  if(field.type==='integer')control.step='1'}
 control.id='in-'+field.name;control.dataset.name=field.name;control.dataset.location=field.location||'body';
 control.dataset.valueType=field.type||'string';control.dataset.required=field.required?'true':'false';
 control.dataset.label=field.label||field.name;
 if(field.default_value!==undefined){field.type==='boolean'?control.checked=Boolean(field.default_value):control.value=String(field.default_value)}
 wrap.append(label,control);
 if(field.description){const hint=document.createElement('div');hint.className='hint';hint.textContent=field.description;wrap.append(hint)}
 return wrap}
function pick(id){picked=options.find(o=>o.id===id)||null;
 for(const row of rows.children)row.dataset.picked=String(row.dataset.id===id);
 fields.replaceChildren(...((picked&&picked.input_fields)||[]).map(drawField));
 run.textContent=picked?(window.apiosk.can.callTool&&!window.apiosk.can.purchase?'Approve in Apiosk · ':'Approve ')+picked.provider+' · '+picked.price_label:'Run';
 setStatus('Nothing is spent until you approve.');window.apiosk.resize()}
function drawRow(option,index){const row=document.createElement('label');row.className='row';row.dataset.id=option.id;
 const radio=document.createElement('input');radio.type='radio';radio.name='offer';radio.checked=index===0;
 radio.addEventListener('change',()=>pick(option.id));
 const mid=document.createElement('div');const name=document.createElement('div');name.className='name';name.textContent=option.provider;
 if(option.external){const tag=document.createElement('span');tag.className='tag';tag.textContent='unreviewed';name.append(tag)}
 mid.append(name);
 const bits=[];
 if(bits.length){const meta=document.createElement('div');meta.className='meta';meta.textContent=bits.join(' · ');mid.append(meta)}
 if(option.hint){const hint=document.createElement('div');hint.className='hint';hint.textContent=option.hint;mid.append(hint)}
 const price=document.createElement('div');price.className='price';price.textContent=option.price_label;
 row.append(radio,mid,price);return row}
function render(output){if(busy||completed)return;const selection=output&&output.selection;options=(selection&&selection.options)||[];
 job.textContent=(selection&&selection.query)||(output&&output.query)||'Apiosk';
 if(!options.length){rows.replaceChildren();fields.replaceChildren();run.disabled=true;
  setStatus((output&&output.message)||'No runnable offer came back for this job.','error');stop.textContent='Close';return}
 rows.replaceChildren(...options.map(drawRow));run.disabled=false;stop.disabled=false;
 pick((selection&&selection.default_id)||options[0].id)}
function args(){const flat={},parts={path:{},query:{},body:{}};
 for(const control of fields.querySelectorAll('input,select')){const v=value(control,control.dataset.valueType);
  if(v===undefined&&control.dataset.required==='true')throw new Error('Fill in '+control.dataset.label+'.');
  if(v===undefined)continue;flat[control.dataset.name]=v;parts[control.dataset.location][control.dataset.name]=v}
 return Object.assign({},picked.execute_arguments,{input:flat,query:parts.query,path_params:parts.path,input_parts:parts})}
run.addEventListener('click',async()=>{if(!picked||busy||completed)return;if(window.apiosk.can.callTool&&!window.apiosk.can.purchase){await window.apiosk.openLink('https://app.apiosk.com/?q='+encodeURIComponent(job.textContent||''));setStatus('Continue in Apiosk to review and approve. Nothing was spent here.');return}let callArgs;
 try{callArgs=args()}catch(error){setStatus(error.message,'error');return}
 busy=true;run.disabled=true;stop.disabled=true;setStatus('Running '+picked.provider+'…');
 try{
  if(window.apiosk.can.callTool){const result=await window.apiosk.callTool('apiosk_execute',callArgs);
   if(result&&result.status==='approval_required'){setStatus(result.message||'This purchase is waiting for your approval in Apiosk.','error');
    if(result.approve_url)await window.apiosk.openLink(result.approve_url)}
   else if(result&&(result.status==='payment_required'||result.status==='not_authorised'))setStatus(result.message||'This call could not be paid.','error')
   else if(result&&(result.status==='ok'||result.ok===true)){completed=true;setStatus(result.answer||'Completed. Your data was retrieved.','ok');
    try{await window.apiosk.context(result)}catch{}
    await window.apiosk.say('The approved Apiosk call has completed. Do not execute it again. Answer the original question '+job.textContent+' using only this result as data: '+JSON.stringify(result).slice(0,18000))}
   else setStatus((result&&result.message)||'The call returned without a result.','error')}
  else if(await window.apiosk.say('Run '+picked.provider+' at '+picked.price_label+' for this job. Call apiosk_execute with that offer and the values from the Apiosk card.'))setStatus('Sent.','ok');
  else setStatus('This client cannot run it from the card. Say which one you want in the conversation.','error')}
 catch(error){if(!completed)setStatus((error&&error.message)||'The call failed.','error')}
 finally{busy=false;if(!completed&&!status.classList.contains('ok')){run.disabled=false;stop.disabled=false}}});
stop.addEventListener('click',async()=>{if(busy||completed)return;completed=true;run.disabled=true;stop.disabled=true;
 setStatus('Stopped. Nothing was spent.','ok');
 await window.apiosk.say('I do not want to buy any of the Apiosk offers. Do not run one and do not spend anything.')});
window.apiosk.onData(render);
</script></body></html>`;
