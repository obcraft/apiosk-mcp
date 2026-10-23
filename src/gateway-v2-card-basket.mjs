// Like Ask's grouped purchase, one displayed total and one human click cover
// separately saved local and Bazaar quotes. Recovery only reads those quotes.
export const V2_CARD_BASKET = `
const externalBasketSources=new Map(),basketVerified=new Set();let externalBasketSession=null,sourceBasketPreparation=null;
function basketStable(value){return Array.isArray(value)?value.map(basketStable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,basketStable(item)])):value}
function basketExternalKey(item){return JSON.stringify([item.api_id,basketStable(item.input||{})])}
function externalBasketCount(){return externalBasketSources.size}
function hasExternalBasket(){return externalBasketCount()>0}
function basketNativeDrafts(){return [...selectedSources.values()].map(draft=>{const values={...draft.input};for(const {control,definition} of draft.controls.values()){try{const value=sourceValue(control,{...definition,required:false});if(value===undefined)delete values[definition.field];else values[definition.field]=value}catch{values[definition.field]=control.value}}const subject=draft.candidate.subject_id||draft.match?.subject_id;return {endpoint_id:draft.candidate.endpoint_id||draft.candidate.endpoint.endpoint_id,capability:draft.candidate.capability||draft.candidate.endpoint.capability,input:values,...(subject?{subject_id:subject}:{})}})}
function basketSearchSnapshot(){return sourceSearchSnapshot?{...sourceSearchSnapshot,selected_sources:basketNativeDrafts(),selected_external_sources:[...externalBasketSources.values()]}:null}
function restoreExternalBasket(data){
 const session=JSON.stringify([data.question||'',data.parsed_request?.meta?.text_sha256||'']);
 if(externalBasketSession!==session||Array.isArray(data.selected_external_sources)){externalBasketSources.clear();for(const item of data.selected_external_sources||[])if(typeof item.api_id==='string'&&item.api_id.startsWith('bazaar:')&&item.source&&item.input&&typeof item.input==='object')externalBasketSources.set(basketExternalKey(item),item)}
 externalBasketSession=session;
}
function addExternalBasketSource(data,values){
 const snapshot=data.basket_search||basketSearchSnapshot();if(!snapshot?.question){showFeedback('Reopen the source search to add this source.','error');return}
 restoreExternalBasket(snapshot);const item={api_id:data.api_id,source:data.source,input:values},key=basketExternalKey(item);
 if(!externalBasketSources.has(key)&&externalBasketSources.size+(snapshot.selected_sources||[]).length>=10){showFeedback('Select at most 10 sources at a time.','error');return}
 externalBasketSources.set(key,item);sourceBasketPreparation=null;
 const next={...snapshot,selected_external_sources:[...externalBasketSources.values()]};render(next);void window.apiosk.context(next).catch(()=>{});
}
function renderExternalBasketSelection(target){for(const [key,item] of externalBasketSources){const row=el('div','actions'),remove=el('button','quiet','Remove');remove.type='button';remove.disabled=busy;remove.onclick=()=>{if(busy)return;externalBasketSources.delete(key);sourceBasketPreparation=null;const next=basketSearchSnapshot();render(next);void window.apiosk.context(next).catch(()=>{})};row.append(el('span','',item.source.name||'Bazaar source'),remove);target.append(row)}}
function basketRef(entry){return entry.kind==='external'?entry.response?.purchase_id:entry.response?.state?.state_ref}
function basketQuote(entry){return entry.kind==='external'?entry.response?.quote:entry.response?.proposal}
function basketProof(entry){const q=basketQuote(entry);return JSON.stringify([entry.kind,basketRef(entry),entry.response?.state?.revision,q?.quote_ref,q?.max_total_atomic,q?.currency])}
function basketIsStarted(entry){return entry.approval_submitted||entry.response?.billing?.authorization_active===true||['running','succeeded','partial','cancelled'].includes(entry.response?.status)}
function basketQuoteAmount(entry){const q=basketQuote(entry);return q&&['USD','USDC'].includes(q.currency)&&typeof q.max_total_atomic==='string'&&/^\\d+$/.test(q.max_total_atomic)?BigInt(q.max_total_atomic):null}
function basketReady(entry){const q=basketQuote(entry);return !entry.error&&!entry.uncertain&&!basketIsStarted(entry)&&['ready','requires_approval'].includes(entry.response?.status)&&!(entry.response?.errors||[]).length&&basketQuoteAmount(entry)!==null&&Date.parse(q.expires_at)>Date.now()&&basketVerified.has(basketProof(entry))}
function basketAcceptEntry(entry,next){
 const expected=basketRef(entry)||(entry.kind==='external'?entry.request_id:null);
 const reference=entry.kind==='external'?next?.purchase_id:next?.state?.state_ref;
 if(!reference||expected&&reference!==expected||entry.kind==='external'&&next.view!=='external_purchase')throw new Error(next?.message||next?.error?.message||(next?.errors||[]).map(error=>error.message).join(' ')||'The saved source could not be confirmed. Check status before continuing.');
 const {basket_parent,...saved}=next;entry.response=saved;entry.error=null;entry.uncertain=false;
 entry.approval_submitted=next.billing?.authorization_active===true||['running','succeeded','partial','cancelled'].includes(next.status);
 basketVerified.add(basketProof(entry));
}
async function basketSave(data){if(await window.apiosk.context(data)!==true)throw new Error('The host could not save these purchase references. No new approval was sent. Retry after saving is available.')}
async function basketPrepareEntry(data,entry){
 try{const next=entry.kind==='external'?await window.apiosk.callTool('apiosk_external',{action:'prepare',api_id:entry.api_id,input:entry.input,request_id:entry.request_id}):await window.apiosk.callTool('apiosk_ask',{question:data.question,request_id:entry.request_id,input:{apiosk_source_selection_v1:{parsed_request:data.search.parsed_request,search_id:data.search.search_id,selections:entry.selections}}});basketAcceptEntry(entry,next)}
 catch(error){entry.error=error?.message||'The quote could not be confirmed. Retry to recover the same request.'}
}
async function prepareSourceBasket(selections){
 if(busy)return;const search=basketSearchSnapshot(),external=[...externalBasketSources.values()];if(!search?.question||!external.length)return;
 if(selections.length&&!search.search_id){showFeedback('Refresh the source search before reviewing these sources.','error');return}
 const fingerprint=JSON.stringify(basketStable({question:search.question,search_id:search.search_id,selections,external}));
 if(sourceBasketPreparation?.fingerprint!==fingerprint){const entries=[...(selections.length?[{kind:'local',label:'Apiosk sources',request_id:sourceRequestId(),selections}]:[]),...external.map(item=>({kind:'external',label:item.source.name||'Bazaar source',request_id:sourceRequestId(),...item}))];sourceBasketPreparation={protocol_version:'2',view:'source_basket',fingerprint,question:search.question,search,entries}}
 const data=sourceBasketPreparation;busy=true;
 try{await basketSave(data);await Promise.all(data.entries.filter(entry=>!entry.response).map(entry=>basketPrepareEntry(data,entry)));await basketSave(data);busy=false;render(data)}catch(error){busy=false;render(data);showFeedback(error?.message||'The source selection could not be saved. No approval was sent.','error')}finally{busy=false}
}
async function retrySourceBasket(data){if(busy)return;busy=true;try{await basketSave(data);await Promise.all(data.entries.filter(entry=>!entry.response&&!entry.uncertain&&!entry.approval_submitted).map(entry=>basketPrepareEntry(data,entry)));await basketSave(data);busy=false;render(data)}catch(error){busy=false;render(data);showFeedback(error.message,'error')}finally{busy=false}}
async function refreshSourceBasket(data){
 if(busy)return;busy=true;
 try{await Promise.all(data.entries.map(async entry=>{const ref=basketRef(entry)||(entry.kind==='external'?entry.request_id:null);if(!ref)return;try{const next=await window.apiosk.callTool(entry.kind==='external'?'apiosk_external':'apiosk_status',entry.kind==='external'?{action:'status',purchase_id:ref}:{task_ref:ref});basketAcceptEntry(entry,next)}catch(error){entry.error=error?.message||'The saved status could not be confirmed.';basketVerified.delete(basketProof(entry))}}));await basketSave(data);busy=false;render(data)}catch(error){busy=false;render(data);showFeedback(error.message,'error')}finally{busy=false}
}
async function approveSourceBasket(data){
 if(busy||output!==data)return;const pending=data.entries.filter(entry=>!basketIsStarted(entry));if(!pending.length||!pending.every(basketReady)||!data.entries.every(entry=>entry.response&&!entry.uncertain)){showFeedback('Check every saved price and status before approving.','error');return}
 busy=true;
 try{
  // Persist every exact purchase reference before the first approval can run.
  for(const entry of pending){entry.uncertain=true;entry.approval_submitted=true}await basketSave(data);
  await Promise.all(pending.map(async entry=>{const q=basketQuote(entry);try{const next=entry.kind==='external'?await window.apiosk.callTool('apiosk_external_approve',{purchase_id:basketRef(entry),quote_ref:q.quote_ref,max_total_atomic:q.max_total_atomic}):await window.apiosk.callTool('apiosk_approve',{state:entry.response.state,quote_ref:q.quote_ref,max_total_atomic:q.max_total_atomic});basketAcceptEntry(entry,next)}catch(error){entry.error=error?.message||'Approval could not be confirmed. Check the saved status before continuing.';basketVerified.delete(basketProof(entry))}}));await basketSave(data);busy=false;render(data);
 }catch(error){busy=false;render(data);showFeedback(error?.message||'The selection could not be saved. Check status before continuing.','error')}finally{busy=false}
}
function openBasketEntry(data,entry){if(busy||!entry.response)return;const next={...entry.response,basket_parent:data};render(next);void window.apiosk.context(next).catch(()=>{})}
function acceptBasketChild(next){const data=output?.basket_parent;if(!data?.entries)return false;const ref=next?.purchase_id||next?.state?.state_ref;const entry=data.entries.find(entry=>basketRef(entry)===ref);if(!entry)return false;try{basketAcceptEntry(entry,next);const shown={...next,basket_parent:data};render(shown);void window.apiosk.context(shown).catch(()=>{});return true}catch{return false}}
function renderBasketReturn(data){if(!data?.basket_parent)return;const s=section('Selected sources'),back=el('button','quiet','Back to all selected sources');back.onclick=()=>{if(busy)return;render(data.basket_parent);void window.apiosk.context(data.basket_parent).catch(()=>{})};s.append(back)}
async function refreshSourceBasketQuotes(data){
 if(busy)return;const entries=data.entries.filter(entry=>!basketIsStarted(entry)&&!entry.uncertain&&basketVerified.has(basketProof(entry))&&basketQuote(entry)&&Date.parse(basketQuote(entry).expires_at)<=Date.now());if(!entries.length)return;busy=true;
 try{for(const entry of entries){if(entry.kind==='external'){entry.request_id=sourceRequestId();delete entry.response;entry.error=null}}await basketSave(data);await Promise.all(entries.map(async entry=>{if(entry.kind==='external')return basketPrepareEntry(data,entry);try{const next=await window.apiosk.callTool('apiosk_requote',{state:entry.response.state,quote_ref:entry.response.proposal.quote_ref});basketAcceptEntry(entry,next)}catch(error){entry.error=error.message}}));await basketSave(data);busy=false;render(data)}catch(error){busy=false;render(data);showFeedback(error.message,'error')}finally{busy=false}
}
function renderSourceBasket(data){
 byId('title').textContent='Your selected sources';byId('subtitle').textContent='Review one total, then approve once. Each source keeps its own saved result.';
 if(!Array.isArray(data.entries)||!data.entries.length)return;const display=data.entries.find(entry=>entry.kind==='local')?.response?.context_view?.money_display;if(display)data.context_view={...data.context_view,money_display:display};const amounts=data.entries.map(basketQuoteAmount),total=amounts.every(amount=>amount!==null)?amounts.reduce((sum,amount)=>sum+amount,0n):null;
 const summary=section('Total price');summary.append(el('p','notice',total===null?'Every selected source must have a price before approval.':'Maximum total: '+money(total.toString(),'USD')));
 for(const entry of data.entries){const s=section(entry.label||'Selected source'),response=entry.response,q=basketQuote(entry);s.append(el('p','meta',entry.uncertain?'Approval outcome not confirmed. Check status.':response?invokeLabel(response.status):'Quote not confirmed.'));if(q)s.append(el('p','meta','Maximum: '+money(q.max_total_atomic,q.currency)));const charged=entry.kind==='external'?response?.billing?.charged_micro_usd:response?.billing?.total_charged;if(charged!=null)s.append(el('p','meta','Actual charge: '+money(String(charged),entry.kind==='external'?'USD':response.billing.currency)));if(entry.error)s.append(el('p','notice error',entry.error));if(response?.errors?.length)for(const error of response.errors)s.append(el('p','notice error',error.message||error.code));if(response){const open=el('button','quiet',['succeeded','partial'].includes(response.status)?'Open saved result':'Review source details');open.onclick=()=>openBasketEntry(data,entry);s.append(open)}}
 const actions=el('div','actions'),pending=data.entries.filter(entry=>!basketIsStarted(entry)),ready=pending.length&&pending.every(basketReady)&&data.entries.every(entry=>!!entry.response&&!entry.uncertain);
 if(pending.length){const remaining=pending.map(basketQuoteAmount),amount=remaining.every(value=>value!==null)?remaining.reduce((sum,value)=>sum+value,0n):null;const approve=el('button','primary',amount===null?'Approve selected sources':'Approve '+money(amount.toString(),'USD'));approve.disabled=busy||!ready;approve.onclick=()=>approveSourceBasket(data);actions.append(approve)}
 const check=el('button','quiet','Check all statuses');check.disabled=busy;check.onclick=()=>refreshSourceBasket(data);actions.append(check);
 if(data.entries.some(entry=>!entry.response&&!entry.approval_submitted)){const retry=el('button','quiet','Retry price preparation');retry.onclick=()=>retrySourceBasket(data);actions.append(retry)}
 if(data.entries.some(entry=>!basketIsStarted(entry)&&basketQuote(entry)&&Date.parse(basketQuote(entry).expires_at)<=Date.now())){const refresh=el('button','quiet','Refresh expired prices');refresh.disabled=busy||data.entries.some(entry=>entry.uncertain)||!data.entries.every(entry=>!entry.response||basketVerified.has(basketProof(entry)));refresh.onclick=()=>refreshSourceBasketQuotes(data);actions.append(refresh)}
 if(data.entries.every(entry=>!basketIsStarted(entry)&&!entry.uncertain)){const change=el('button','quiet','Change sources');change.onclick=()=>{if(busy)return;sourceBasketPreparation=null;render(data.search);void window.apiosk.context(data.search).catch(()=>{})};actions.append(change)}
 summary.append(actions);if(!ready&&pending.length)summary.append(el('p','meta','Resolve missing inputs or check the saved statuses to review current prices. Restoring this card never approves again.'));
}
`;
