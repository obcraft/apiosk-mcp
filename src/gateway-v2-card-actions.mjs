// Runs inside the card: observe consent, then use only gateway-issued actions.
export const V2_CARD_ACTIONS = `
async function refreshTask(){if(busy||!output?.state?.state_ref)return;busy=true;try{const next=await window.apiosk.callTool('apiosk_execute',{recover_task_ref:output.state.state_ref});render(next);void window.apiosk.context(next).catch(()=>{})}catch(e){showFeedback(e&&e.message||'Could not refresh this request. Use Check status to try again.','error')}finally{busy=false}}
function renderActions(data){
 const actions=data.next_actions||[],run=actions.find(a=>a.kind==='execute_quoted_step'),poll=actions.find(a=>a.kind==='poll'),read=actions.filter(a=>a.kind==='read_result'),cancel=actions.find(a=>a.kind==='cancel');
 const approved=data.billing&&data.billing.authorization_active&&data.billing.quote_ref===(data.proposal&&data.proposal.quote_ref),enabled=data.context_view?.execution_enabled!==false;
 if(run&&planSurface){
  const wrap=el('div','actions plan-actions');
  if(!approved&&enabled&&data.proposal?.approval_url){
   const b=el('button','primary','Approve up to '+money(data.proposal.max_total_atomic,data.proposal.currency));
   b.onclick=async()=>{watchUntil=Date.now()+300000;const opened=await window.apiosk.openLink(data.proposal.approval_url);showFeedback(opened?'Approve in Apiosk. This card will continue automatically.':'Open Apiosk to approve this request.',opened?'':'error');if(opened)await refreshTask()};wrap.append(b);
  }else if(approved&&enabled){
   wrap.append(el('span','notice','Approved. Continuing your request…'));
   if(!attempted.has(run.action_id)&&!(data.errors||[]).length){pollTimer=setTimeout(()=>{pollTimer=null;if(busy)return;attempted.add(run.action_id);callAction(run)},350)}
  }
  if(data.state?.state_ref){const refresh=el('button','quiet','Check status');refresh.onclick=()=>{watchUntil=Date.now()+300000;return refreshTask()};wrap.append(refresh)}
  if(wrap.children.length)planSurface.append(wrap);
  if(!approved&&enabled&&Date.now()<watchUntil&&Date.parse(data.proposal?.expires_at)>Date.now())pollTimer=setTimeout(()=>{pollTimer=null;refreshTask()},2000);
 }
 if(poll){const wait=Math.max(350,Number(data.retry_after_ms)||900);pollTimer=setTimeout(()=>{pollTimer=null;callAction(poll)},wait)}
 if(read.length||cancel){const s=el('section','section controls'),wrap=el('div','actions');sections.append(s);for(const a of read.slice(0,2))wrap.append(actionButton(a,a.label||'View result'));if(cancel&&(run||poll))wrap.append(actionButton(cancel,'Stop remaining steps'));s.append(wrap)}
}

`;
