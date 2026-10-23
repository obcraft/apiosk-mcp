// External directory choices use the gateway's pinned offer and saved purchase.
// Only the private approval tool can authorize the displayed ceiling.
export const V2_CARD_EXTERNAL = `
let externalPreparation=null,externalApprovalRecovery=null;
function externalMessage(value,fallback){return value?.error?.message||value?.message||fallback}
function acceptExternalResponse(next,expected){
 if(!next||next.view!=='external_purchase'||!next.purchase_id||expected&&next.purchase_id!==expected)throw new Error(externalMessage(next,'The saved external purchase could not be confirmed. Check status before continuing.'));
 if(acceptBasketChild(next))return next;render(next);void window.apiosk.context(next).catch(()=>{});return next;
}
async function inspectExternalSource(candidate,button){
 if(busy||typeof candidate.api_id!=='string')return;const basket_search=basketSearchSnapshot();busy=true;button.disabled=true;showFeedback('Loading the source inputs and price…');
 try{const next=await window.apiosk.callTool('apiosk_external',{action:'source',api_id:candidate.api_id});if(next?.view!=='external_source'||next.api_id!==candidate.api_id||!Array.isArray(next.source?.inputs))throw new Error(externalMessage(next,'This source could not be loaded. Try again.'));const view={...next,...(basket_search?{basket_search}:{})};render(view);void window.apiosk.context(view).catch(()=>{})}
 catch(error){showFeedback(error?.message||'This source could not be loaded. Try again.','error')}
 finally{busy=false;button.disabled=false}
}
function attachExternalChoice(side,candidate,match){
 if(selectableSource(candidate,match)||candidate.origin!=='coinbase'||typeof candidate.api_id!=='string'||!candidate.api_id.startsWith('bazaar:'))return;
 const button=el('button','quiet external-source','Review source');button.type='button';button.disabled=!window.apiosk.can.callTool;button.onclick=()=>inspectExternalSource(candidate,button);side.append(button);
}
function renderExternalSource(data){
 byId('title').textContent=data.source?.name||'External source';byId('subtitle').textContent='Review the declared inputs and price. Nothing has been bought.';
 const source=data.source||{},s=section('Source inputs'),form=el('form','source-input-editor'),controls=[];
 for(const definition of source.inputs||[]){const label=el('label','source-input-label'),control=sourceInputControl(definition,data.basket_search?.selected_external_sources?.find(item=>item.api_id===data.api_id)?.input?.[definition.field]);label.append(el('span','',searchInputLabel(definition)+(definition.required?'':' (optional)')),control);form.append(label);controls.push({definition,control})}
 const amount=money(String(source.total_atomic),'USD');if(amount)s.append(el('p','meta','Quoted source price: '+amount));
 const button=el('button','primary',data.basket_search?'Add to selection':'Review price');button.type='submit';form.append(button);s.append(form);
 form.onsubmit=async event=>{
  event.preventDefault();if(busy||output!==data)return;const values={};try{for(const {control,definition} of controls){if(control.reportValidity&&!control.reportValidity())throw new Error('Review '+searchInputLabel(definition)+'.');const value=sourceValue(control,definition);if(value!==undefined)values[definition.field]=value}}catch(error){showFeedback(error.message,'error');return}
  if(data.basket_search){addExternalBasketSource(data,values);return}
  const fingerprint=JSON.stringify({api_id:data.api_id,input:values});if(externalPreparation?.fingerprint!==fingerprint)externalPreparation={fingerprint,request_id:sourceRequestId()};
  busy=true;button.disabled=true;showFeedback('Preparing the exact source and total price…');
  try{acceptExternalResponse(await window.apiosk.callTool('apiosk_external',{action:'prepare',api_id:data.api_id,input:values,request_id:externalPreparation.request_id}))}
  catch(error){showFeedback(error?.message||'The quote could not be confirmed. Try again to recover the same request.','error')}
  finally{busy=false;button.disabled=false}
 };
 if(data.notice)section('About this source').append(el('p','meta',data.notice));
}
async function refreshExternalPurchase(data,button){
 if(busy||!data.purchase_id)return;busy=true;if(button)button.disabled=true;
 try{const next=await window.apiosk.callTool('apiosk_external',{action:'status',purchase_id:data.purchase_id});if(next?.view==='external_purchase'&&next.purchase_id===data.purchase_id)externalApprovalRecovery=null;acceptExternalResponse(next,data.purchase_id)}
 catch(error){showFeedback(error?.message||'The saved purchase could not be read. Try Check status again.','error')}
 finally{busy=false;if(button)button.disabled=false}
}
async function approveExternalPurchase(data,button){
 if(busy||output!==data||externalApprovalRecovery===data.purchase_id)return;
 if(Date.parse(data.quote?.expires_at)<=Date.now()){showFeedback('This quote expired. Review a new source price before approving.','error');return}
 busy=true;button.disabled=true;showFeedback('Saving your approval…');
 try{
  const next=await window.apiosk.callTool('apiosk_external_approve',{purchase_id:data.purchase_id,quote_ref:data.quote.quote_ref,max_total_atomic:data.quote.max_total_atomic});
  acceptExternalResponse(next,data.purchase_id);
  if(next.status==='requires_approval')showFeedback(externalMessage(next,'Approval was not confirmed. Check status before continuing.'),'error');
 }catch(error){externalApprovalRecovery=data.purchase_id;render(data);showFeedback(error?.message||'Approval could not be confirmed. Check status before trying again.','error')}
 finally{busy=false;button.disabled=externalApprovalRecovery===data.purchase_id}
}
function renderExternalPurchase(data){
 const source=data.source||{};byId('title').textContent=source.name||'External source';byId('subtitle').textContent=({requires_approval:'Review the exact total before approving.',running:'The source request is running.',succeeded:'Your saved source result is ready.',failed:'The source request could not be completed.'})[data.status]||'Read the saved purchase status.';
 const s=section('External source'),amount=money(data.quote?.max_total_atomic,data.quote?.currency||'USD');if(amount)s.append(el('p','notice','Maximum total: '+amount));
 if(data.billing?.charged_micro_usd!=null)s.append(el('p','meta','Actual charge: '+money(String(data.billing.charged_micro_usd),'USD')));
 const actions=el('div','actions');
 if(data.status==='requires_approval'&&data.quote&&!data.basket_parent){const approve=el('button','primary','Approve up to '+amount);approve.disabled=externalApprovalRecovery===data.purchase_id||Date.parse(data.quote.expires_at)<=Date.now();approve.onclick=()=>approveExternalPurchase(data,approve);actions.append(approve);if(approve.disabled)s.append(el('p','meta',externalApprovalRecovery===data.purchase_id?'Check status before approving again.':'This quote expired. Review a new source price before approving.'))}
 const check=el('button','quiet','Check status');check.onclick=()=>refreshExternalPurchase(data,check);actions.append(check);s.append(actions);
 if(data.result_present&&data.result!=null){const result=section('Saved result');result.append(answerBody(data.result));if(data.result_truncated)result.append(el('p','notice','This saved result is truncated; it does not contain every source record.'));const details=el('details','full-result');details.append(el('summary','','Full saved source data'),el('pre','',JSON.stringify(data.result,null,2)));details.ontoggle=()=>window.apiosk.resize();result.append(details)}
 else if(data.status==='succeeded')s.append(el('p','notice','The request completed, but the saved result is not available in this response. Check status to recover it.'));
 if(data.error?.message)s.append(el('p','notice error',data.error.message));
 if(data.notice)section('About this purchase').append(el('p','meta',data.notice));
}
`;
