export const V2_CARD_CLARIFICATION = `
function renderClarification(data){
 if(data.status!=='needs_input')return;
 const turn=data.context_view?.conversation?.at(-1),message=data.context_view?.clarification?.message||turn?.reply;
 const s=section('One detail is needed');s.append(el('p','notice',message||'Add the missing detail in your chat, or check the saved request status.'));
 if(!message||!turn?.question||!data.state)return;
 const form=el('form','field'),field=el('input'),b=el('button','primary','Send answer');
 field.required=true;field.autocomplete='off';field.placeholder='Your answer';field.setAttribute('aria-label','Your answer to the clarification');form.append(field,b);
 form.onsubmit=async e=>{e.preventDefault();const answer=field.value.trim();if(!answer||busy||output!==data)return;busy=true;b.disabled=true;showFeedback('Updating your request…');try{const next=await window.apiosk.callTool('apiosk_discover',{question:turn.question+'\\n\\nUser clarification: '+answer,state:data.state});acceptResponse(next)}catch(error){showFeedback(error?.message||'Could not send your answer. Check status and try again.','error')}finally{busy=false;b.disabled=false}};
 s.append(form);
}
`;
