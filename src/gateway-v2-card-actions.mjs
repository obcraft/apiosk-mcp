// Runs inside the card: observe consent, then use only gateway-issued actions.
export const V2_CARD_ACTIONS = `
async function refreshTask(publish=true){if(busy||!output?.state?.state_ref)return;const before=output;if(publish)busy=true;try{const next=await window.apiosk.callTool('apiosk_status',{task_ref:before.state.state_ref});if(publish)acceptResponse(next);else if(!busy&&output===before&&next?.state?.state_ref===before.state.state_ref&&Number(next.state.revision)>=Number(before.state.revision)){render(next);void window.apiosk.context(next).catch(()=>{})}}catch(e){if(publish)showFeedback(e&&e.message||'Could not refresh this request. Use Check status to try again.','error')}finally{if(publish)busy=false}}
async function approvePlan(data,button){if(busy||output!==data||Date.parse(data.proposal.expires_at)<=Date.now())return;busy=true;button.disabled=true;showFeedback('Saving your approval…');try{const next=await window.apiosk.callTool('apiosk_approve',{state:data.state,quote_ref:data.proposal.quote_ref,max_total_atomic:data.proposal.max_total_atomic});if(!next?.state||next.state.state_ref!==data.state.state_ref||!next.billing?.authorization_active||next.billing.quote_ref!==data.proposal.quote_ref||next.proposal?.max_total_atomic!==data.proposal.max_total_atomic)throw new Error(next?.message||'Approval was not confirmed. Check status before continuing.');watchUntil=Date.now()+300000;acceptResponse(next)}catch(e){watchUntil=0;showFeedback(e&&e.message||'Approval could not be confirmed. Check status before continuing.','error')}finally{busy=false;button.disabled=false}}
function renderActions(data){
 const actions=data.next_actions||[],run=actions.find(a=>a.kind==='execute_quoted_step'),poll=actions.find(a=>a.kind==='poll'),read=actions.filter(a=>a.kind==='read_result'),cancel=actions.find(a=>a.kind==='cancel');
 const approved=data.billing&&data.billing.authorization_active&&data.billing.quote_ref===(data.proposal&&data.proposal.quote_ref),enabled=data.context_view?.execution_enabled!==false;
 if(run&&planSurface){
  const wrap=el('div','actions plan-actions');
  if(!approved&&enabled&&data.proposal?.approval_url){
   const b=el('button','primary','Approve up to '+money(data.proposal.max_total_atomic,data.proposal.currency));
   if(Date.parse(data.proposal.expires_at)<=Date.now()){b.disabled=true;b.textContent='Quote expired — request a new price';}
   b.onclick=data.context_view?.approval_mode==='chatbot'?()=>approvePlan(data,b):async()=>{if(busy)return;watchUntil=Date.now()+300000;const opened=await window.apiosk.openLink(data.proposal.approval_url);showFeedback(opened?'Approve in Apiosk. This card will continue automatically.':'Open Apiosk to approve this request.',opened?'':'error');if(opened)await refreshTask()};wrap.append(b);
  }else if(approved&&enabled&&Date.now()<watchUntil){
   if(attempted.has(run.action_id)||(data.errors||[]).length)wrap.append(actionButton(run,'Retry approved step',true));else wrap.append(el('span','notice','Approved. Continuing your request…'));
   if(!attempted.has(run.action_id)&&!(data.errors||[]).length){pollTimer=setTimeout(()=>{pollTimer=null;if(busy)return;attempted.add(run.action_id);callAction(run)},350)}
  }else if(approved&&enabled){
   const b=el('button','primary','Continue approved request');b.onclick=()=>{watchUntil=Date.now()+300000;return refreshTask()};wrap.append(b);
  }
  if(data.state?.state_ref){const refresh=el('button','quiet','Check status');refresh.onclick=()=>{watchUntil=Date.now()+300000;return refreshTask()};wrap.append(refresh)}
  if(wrap.children.length)planSurface.append(wrap);
  if(!approved&&enabled&&Date.now()<watchUntil&&Date.parse(data.proposal?.expires_at)>Date.now())pollTimer=setTimeout(()=>{pollTimer=null;refreshTask()},2000);
 }
 if(poll){const wait=Math.max(350,Number(data.retry_after_ms)||900);pollTimer=setTimeout(()=>{pollTimer=null;callAction(poll)},wait)}
 if(read.length||cancel||poll){const s=el('section','section controls'),wrap=el('div','actions');sections.append(s);if(poll){const check=el('button','quiet','Check status');check.onclick=refreshTask;wrap.append(check)}if(read.length){const view=el('button','quiet','View saved result');view.onclick=()=>refreshTask();wrap.append(view)}if(cancel&&(run||poll))wrap.append(actionButton(cancel,'Stop remaining steps'));s.append(wrap)}
}

`;
