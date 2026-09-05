// ui://apiosk/plan-card.html — the plan, and the one question about it.
//
// The widget-host leg of the same threefold approval src/elicit.mjs draws
// natively and src/presentation prints as prose. It renders what apiosk_plan
// returned: the readable steps, ONE amount, and Approve/Deny. Approve calls
// apiosk_execute_plan with the plan_token exactly as it arrived — the card
// cannot edit a plan any more than the tool can, because there is nothing in
// here that could construct one.
//
// No per-step prices. See the header of src/plans.mjs.

export const APIO_PLAN_CARD_URI = "ui://apiosk/plan-card.html";

export const APIO_PLAN_CARD_META = {
  ui: {
    prefersBorder: true,
    domain: "https://mcp.apiosk.com",
    csp: { connectDomains: [], resourceDomains: [] },
  },
  "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
  "openai/widgetDomain": "https://mcp.apiosk.com",
  "openai/widgetPrefersBorder": true,
  "openai/widgetDescription":
    "Shows an Apiosk research plan: its steps, what it cannot reach, the single price ceiling, and explicit Approve and Deny actions.",
};

// Self-contained and dependency-free, like the other three cards, so a host can
// render the decision without fetching a script, a style or a font.
export const APIO_PLAN_CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;padding:12px;background:transparent;color:CanvasText}.card{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:16px;padding:16px;background:color-mix(in srgb,Canvas 96%,transparent)}.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.58}.row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-top:6px}h2{font-size:17px;line-height:1.3;margin:0}.price{font-weight:750;font-size:18px;white-space:nowrap}.meta,.note,.status{font-size:12px;line-height:1.45;opacity:.72}.steps{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:8px}.steps li{border-left:2px solid color-mix(in srgb,CanvasText 18%,transparent);padding-left:10px}.step-name{font-weight:650;font-size:13px}.warn{color:#b94848;opacity:1}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}button{border:0;border-radius:10px;padding:10px 12px;font:inherit;font-weight:700;cursor:pointer}.approve{background:#167a50;color:white}.deny{background:color-mix(in srgb,CanvasText 9%,transparent);color:CanvasText}.approve:disabled,.deny:disabled{opacity:.5;cursor:default}.status{margin-top:12px;min-height:18px}.status.error{color:#b94848;opacity:1}.status.ok{color:#167a50;opacity:1}.link{display:inline-block;margin-top:8px;color:inherit}
</style></head>
<body><main class="card"><div class="eyebrow">Research plan</div><div class="row"><div><h2 id="question">Plan</h2><div id="meta" class="meta"></div></div><div id="price" class="price"></div></div><ul id="steps" class="steps"></ul><p id="note" class="note"></p><div class="actions"><button id="approve" class="approve" type="button">Approve</button><button id="deny" class="deny" type="button">Deny</button></div><div id="status" class="status" role="status" aria-live="polite"></div></main>
<script>
const byId=id=>document.getElementById(id),question=byId('question'),meta=byId('meta'),price=byId('price'),steps=byId('steps'),note=byId('note'),approve=byId('approve'),deny=byId('deny'),status=byId('status');
let output=null,plan=null,busy=false;
const money=v=>typeof v==='number'&&Number.isFinite(v)?'$'+v.toFixed(6).replace(/0+$/,'').replace(/\\.$/,''):'Price unavailable';
const euro=c=>typeof c==='number'&&Number.isFinite(c)?' (€'+(c/100).toFixed(2)+')':'';
function toolOutput(){return window.openai?.toolOutput??window.openai?.structuredContent??null}
function setStatus(text,kind=''){status.textContent=text||'';status.className='status '+kind}
function drawStep(step){const li=document.createElement('li');const name=document.createElement('div');name.className='step-name';name.textContent=step.capability||step.id||'step';const detail=document.createElement('div');detail.className='meta';const bits=[];if(step.api)bits.push('via '+step.api);if(Array.isArray(step.needs)&&step.needs.length)bits.push('after '+step.needs.join(', '));if(step.may_ask)bits.push('may pause to ask you which one is meant');detail.textContent=bits.join(' · ');li.append(name,detail);return li}
function render(value){output=value&&typeof value==='object'?value:null;plan=output?.plan||null;if(!plan||!plan.plan_token){question.textContent='No plan';meta.textContent='';price.textContent='';steps.replaceChildren();note.textContent=output?.message||'Nothing was planned, so there is nothing to approve.';approve.disabled=true;deny.textContent='Close';return}question.textContent=plan.question||'This job';price.textContent=money(plan.total_usdc)+euro(plan.total_eur_cents);meta.textContent=[(plan.paid_calls??'?')+' paid calls',(plan.steps_deep??'?')+' steps deep','answered as '+(plan.format||'json')].join(' · ');steps.replaceChildren(...(plan.steps||[]).map(drawStep));const missing=(plan.missing_inputs||[]).map(m=>m.fact_type+(m.required?' (required)':' (optional)'));note.textContent=missing.length?'Not reachable: '+missing.join(', ')+'.':'';note.className=missing.length?'note warn':'note';approve.textContent='Approve · at most '+money(plan.total_usdc);deny.textContent='Deny';approve.disabled=false;deny.disabled=false;setStatus('Nothing is spent until you approve.')}
function structured(result){if(result?.structuredContent)return result.structuredContent;if(result?.content?.[0]?.text){try{return JSON.parse(result.content[0].text)}catch{}}return result}
approve.addEventListener('click',async()=>{if(!plan||busy)return;busy=true;approve.disabled=true;deny.disabled=true;setStatus('Starting the job…');try{if(window.openai?.callTool){const result=structured(await window.openai.callTool('apiosk_execute_plan',{plan_token:plan.plan_token}));if(result?.status==='started'){setStatus('Approved. The job is running; ask for its status any time.','ok');if(window.openai?.sendFollowUpMessage)await window.openai.sendFollowUpMessage({prompt:'The Apiosk plan is approved and the job has started. Watch it with apiosk_job_status and answer my original question when it finishes.',scrollToBottom:true})}else if(result?.status==='plan_stale'){setStatus(result.message||'This plan moved on. Run apiosk_plan again.','error')}else{setStatus(result?.message||'The job could not be started.','error')}}else if(window.openai?.sendFollowUpMessage){await window.openai.sendFollowUpMessage({prompt:'I approve this Apiosk plan at at most '+money(plan.total_usdc)+'. Call apiosk_execute_plan with the plan_token from this card.',scrollToBottom:true});setStatus('Approval sent.','ok')}else setStatus('Approval is unavailable in this client. Say “approve” in the conversation.','error')}catch(error){setStatus(error?.message||'The plan could not be started.','error')}finally{busy=false;if(!status.classList.contains('ok')){approve.disabled=false;deny.disabled=false}}});
deny.addEventListener('click',async()=>{if(busy)return;approve.disabled=true;deny.disabled=true;setStatus('Denied. Nothing was spent.','ok');window.openai?.setWidgetState?.({decision:'denied',plan_hash:plan?.plan_hash||null});if(window.openai?.sendFollowUpMessage)await window.openai.sendFollowUpMessage({prompt:'I deny the proposed Apiosk plan. Do not start it and do not spend anything.',scrollToBottom:false})});
render(toolOutput());window.addEventListener('openai:set_globals',event=>render(event.detail?.globals?.toolOutput??event.detail?.toolOutput));
</script></body></html>`;
