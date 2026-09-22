export const V2_CARD_CLARIFICATION = `
function renderInput(data){
 const action=(data.next_actions||[]).find(a=>a.kind==='supply_input');
 if(!action){renderClarification(data);return}
 const schema=action.input_schema?.properties?.value||{},raw=text(action.label).replace(/^Provide\\s+/i,'').trim();
 const names={'web.query':'Search query','web.source_search_query':'Search query','domain.name':'Website domain','company_registry.kvknummer':'KVK number','company.registration.lei':'LEI code','company.name':'Company name'};
 const title=schema.title||names[raw]||(raw?pretty(raw):'');
 if(!title){section('Request details unavailable').append(el('p','notice','The request did not identify the missing detail. Use Check status to reload the saved request.'));return}
 const s=section(title),form=el('form','field actions'),field=el('input'),b=el('button','quiet','Continue');
 const message=data.context_view?.clarification?.message||schema.description||(names[raw]==='Search query'?'What should the web search look for?':'Enter the '+title.toLowerCase()+' to continue.');
 s.append(el('p','meta',message));field.id='requested-input';field.required=true;field.autocomplete='off';field.setAttribute('aria-label',title);
 field.placeholder=Array.isArray(schema.examples)&&schema.examples.length?'For example: '+text(schema.examples[0]):title;
 form.append(field,b);form.onsubmit=e=>{e.preventDefault();if(output!==data||busy||!field.value.trim())return;let value=field.value.trim();const type=schema.type;if(type==='integer'||type==='number')value=Number(value);else if(type==='boolean')value=value==='true';return callAction(action,{value})};s.append(form);
}
function renderClarification(data){
 if(data.status!=='needs_input')return;
 const turn=data.context_view?.conversation?.at(-1),message=data.context_view?.clarification?.message||turn?.reply;
 const s=section('One detail is needed');s.append(el('p','notice',message||'Add the missing detail in your chat, or check the saved request status.'));
 if(!message||!turn?.question||!data.state)return;
 const form=el('form','field actions'),field=el('input'),b=el('button','quiet','Send answer');
 field.required=true;field.autocomplete='off';field.placeholder='Your answer';field.setAttribute('aria-label','Your answer to the clarification');form.append(field,b);
 form.onsubmit=async e=>{e.preventDefault();const answer=field.value.trim();if(!answer||busy||output!==data)return;busy=true;b.disabled=true;showFeedback('Updating your request…');try{const next=await window.apiosk.callTool('apiosk_discover',{question:turn.question+'\\n\\nUser clarification: '+answer,state:data.state});acceptResponse(next)}catch(error){showFeedback(error?.message||'Could not send your answer. Check status and try again.','error')}finally{busy=false;b.disabled=false}};
 s.append(form);
}
`;
