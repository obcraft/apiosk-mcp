// Local selection and input editing are free. Only the gateway creates a
// combined quote; the existing approval button owns purchase consent.
export const V2_CARD_SELECTION = `
let sourceSelectionSession=null,sourceSearchSnapshot=null,sourceSelectionQuestion='',sourcePrepareIdentity=null,sourcePreparedTask=null;
const selectedSources=new Map(),sourceChoices=new Map(),sourceDrafts=new Map();let sourceReviewButton=null,sourceSelectionCount=null;
function sourceQuestion(data){return data.question||output?.context_view?.conversation?.at(-1)?.question||input.question||''}
function sourceChoiceKey(candidate,match){return JSON.stringify([candidate.endpoint_id||candidate.endpoint?.endpoint_id,candidate.capability||candidate.endpoint?.capability,candidate.subject_id||match?.subject_id||null])}
function offeredSourceOption(candidate,match,data=sourceSearchSnapshot){return (data?.source_options||[]).find(option=>sourceChoiceKey(option.source||{},option)===sourceChoiceKey(candidate,match))}
function sourceOptionCandidate(option,existing={}){
 const candidate={...existing,...option.source,subject_id:option.subject_id},endpoint=option.endpoint||existing.endpoint||option.source?.endpoint;
 if(endpoint)candidate.endpoint={...endpoint,input_values:{...endpoint.input_values,...option.input_values},missing_inputs:option.missing_inputs||endpoint.missing_inputs};
 return candidate;
}
function sourceSearchGroups(data){
 const seen=new Set(),key=(candidate,match)=>(candidate.endpoint_id||candidate.endpoint?.endpoint_id)?sourceChoiceKey(candidate,match):JSON.stringify([candidate.origin,candidate.url||candidate.source_slug||candidate.name,candidate.capability,candidate.subject_id||match.subject_id]);
 const groups=(data.matches||[]).map(match=>{
  const group={...match};
  for(const origin of ['apiosk','coinbase'])group[origin]=(match[origin]||[]).flatMap(candidate=>{
   const option=offeredSourceOption(candidate,match,data);if(option)candidate=sourceOptionCandidate(option,candidate);
   const identity=key(candidate,match);if(seen.has(identity))return [];seen.add(identity);return [candidate];
  });
  group.duplicates_only=(match.apiosk?.length||0)+(match.coinbase?.length||0)>0&&!group.apiosk.length&&!group.coinbase.length;
  return group;
 });
 const related=[];
 for(const option of data.source_options||[]){
  if(!(data.parsed_request?.subjects||[]).some(subject=>subject.id===option.subject_id))continue;
  const candidate=sourceOptionCandidate(option),identity=key(candidate,option);if(seen.has(identity))continue;seen.add(identity);
  related.push({...candidate,selection_reason:option.reason});
 }
 if(related.length)groups.push({slug:'related_sources',related:true,apiosk:related,coinbase:[],coinbase_status:'complete'});
 return groups;
}
function sourceSearchNeedsRefresh(data){
 if(!data?.search_id||!Array.isArray(data.source_options)||!Array.isArray(data.matches))return true;
 return sourceSearchGroups(data).some(match=>[...match.apiosk,...match.coinbase].some(candidate=>candidate.availability==='supported'&&offeredSourceOption(candidate,match,data)&&!Array.isArray(candidate.endpoint?.inputs)));
}
function sourceSubjectIdentity(subject){const label=String(subject?.label||'').trim().toLowerCase(),identifiers=Object.entries(subject?.identifiers||{}).sort(([a],[b])=>a.localeCompare(b));return label||identifiers.length?JSON.stringify([subject?.type||null,label,identifiers]):null}
function restoreSourceSelections(selections,original,refreshed){
 const before=original?.subjects||[],after=refreshed?.parsed_request?.subjects||[];
 return selections.flatMap(saved=>{
  const subject=before.find(subject=>subject.id===saved.subject_id),identity=sourceSubjectIdentity(subject);
  if(!identity||before.filter(subject=>sourceSubjectIdentity(subject)===identity).length!==1)return [];
  const matches=after.filter(subject=>sourceSubjectIdentity(subject)===identity);
  if(matches.length!==1)return [];
  const selection={...saved,subject_id:matches[0].id};
  const candidate=sourceSearchGroups(refreshed).flatMap(match=>[...match.apiosk,...match.coinbase].map(candidate=>({candidate,match}))).find(({candidate,match})=>sourceChoiceKey(candidate,match)===sourceChoiceKey(selection,selection))?.candidate;
  if(!Array.isArray(candidate?.endpoint?.inputs))return [];
  const fields=new Set(candidate.endpoint.inputs.map(definition=>definition.field));
  selection.input=Object.fromEntries(Object.entries({...candidate.endpoint.input_values,...saved.input}).filter(([field])=>fields.has(field)));
  return [selection];
 });
}
function selectableSource(candidate,match){return candidate.availability==='supported'&&typeof(candidate.endpoint_id||candidate.endpoint?.endpoint_id)==='string'&&typeof(candidate.capability||candidate.endpoint?.capability)==='string'&&Array.isArray(candidate.endpoint?.inputs)&&!!offeredSourceOption(candidate,match)}
function beginSourceSelection(data,matches){
 const question=sourceQuestion(data),session=JSON.stringify([question,data.catalog_version||'',data.parsed_request?.meta?.text_sha256||'']);
 const changed=session!==sourceSelectionSession;
 if(changed){selectedSources.clear();sourceDrafts.clear();sourcePrepareIdentity=null;sourcePreparedTask=null;sourceSelectionSession=session}
 sourceChoices.clear();sourceReviewButton=null;sourceSelectionCount=null;sourceSelectionQuestion=question;
 if(!question)return false;
 sourceSearchSnapshot={...data,question,view:'source_search'};
 const available=new Set();for(const match of matches)for(const candidate of [...(match.apiosk||[]),...(match.coinbase||[])])if(selectableSource(candidate,match))available.add(sourceChoiceKey(candidate,match));
 for(const key of selectedSources.keys())if(!available.has(key))selectedSources.delete(key);
 if(changed)for(const saved of data.selected_sources||[])for(const match of matches)for(const candidate of match.apiosk||[]){
  const key=sourceChoiceKey(candidate,match);
  if(selectableSource(candidate,match)&&candidate.endpoint_id===saved.endpoint_id&&(candidate.capability||candidate.endpoint?.capability)===saved.capability&&(candidate.subject_id||match.subject_id||null)===(saved.subject_id||null)){
   const draft={candidate,match,input:{...(saved.input||{})},controls:new Map()};selectedSources.set(key,draft);sourceDrafts.set(key,draft);
  }
 }
 return true;
}
function syncSourceSelection(){
 for(const [key,entries] of sourceChoices)for(const entry of entries){const selected=selectedSources.has(key);entry.checkbox.checked=selected;entry.checkbox.disabled=busy||(!selected&&selectedSources.size>=10);entry.editor.classList.toggle('hidden',!selected);entry.row.classList.toggle('source-selected',selected);for(const control of entry.editor.querySelectorAll('input,select,textarea'))control.disabled=busy}
 const count=selectedSources.size;
 if(sourceSelectionCount)sourceSelectionCount.textContent=count?count+(count===1?' source selected':' sources selected'):'Choose the sources you want to use.';
 if(sourceReviewButton){sourceReviewButton.textContent=count?'Review '+count+' selected '+(count===1?'source':'sources'):'Review selected sources';sourceReviewButton.disabled=busy||!count||!window.apiosk.can.callTool}
 window.apiosk.resize();
}
function sourceValue(control,definition){
 const schema=definition.schema||{},value=control.value;
 if(value===''){if(definition.required)throw new Error('Enter '+searchInputLabel(definition)+'.');return undefined}
 if(Array.isArray(schema.enum)){const chosen=schema.enum.find(option=>String(option)===value);if(chosen===undefined)throw new Error('Choose '+searchInputLabel(definition)+'.');return chosen}
 if(schema.type==='boolean'){if(value!=='true'&&value!=='false')throw new Error('Choose '+searchInputLabel(definition)+'.');return value==='true'}
 if(schema.type==='integer'||schema.type==='number'){const number=Number(value);if(!Number.isFinite(number)||(schema.type==='integer'&&!Number.isInteger(number)))throw new Error('Enter a valid number for '+searchInputLabel(definition)+'.');return number}
 if(schema.type==='object'||schema.type==='array'){let parsed;try{parsed=JSON.parse(value)}catch{throw new Error('Enter valid JSON for '+searchInputLabel(definition)+'.')}if((schema.type==='array'&&!Array.isArray(parsed))||(schema.type==='object'&&(!parsed||Array.isArray(parsed)||typeof parsed!=='object')))throw new Error('Review '+searchInputLabel(definition)+'.');return parsed}
 return value;
}
function sourceInputEditor(candidate,draft){
 const editor=el('div','source-input-editor hidden');
 for(const definition of candidate.endpoint.inputs){
  const schema=definition.schema||{},label=el('label','source-input-label'),title=searchInputLabel(definition),choices=Array.isArray(schema.enum)?schema.enum:schema.type==='boolean'?[true,false]:null;
  const control=el(choices?'select':['object','array'].includes(schema.type)?'textarea':'input','source-input');
  label.append(el('span','',title+(definition.required?'':' (optional)')));control.setAttribute('aria-label',title);control.dataset.field=definition.field;control.name=definition.field;control.required=!!definition.required;
  if(choices){const empty=el('option','','Choose…');empty.value='';control.append(empty);for(const value of choices){const option=el('option','',String(value));option.value=String(value);control.append(option)}}
  else if(['integer','number'].includes(schema.type)){control.type='number';control.step=schema.type==='integer'?'1':'any';if(schema.minimum!=null)control.min=schema.minimum;if(schema.maximum!=null)control.max=schema.maximum}
  else if(control.tagName==='INPUT'){control.type='text';if(schema.pattern)control.pattern=schema.pattern;if(Number.isInteger(schema.maxLength))control.maxLength=schema.maxLength}
  const supplied=draft.input[definition.field];control.value=supplied==null?'':typeof supplied==='object'?JSON.stringify(supplied):String(supplied);
  control.oninput=()=>{draft.controls.set(definition.field,{control,definition});sourcePrepareIdentity=null};control.onchange=control.oninput;
  draft.controls.set(definition.field,{control,definition});label.append(control);editor.append(label);
 }
 return editor;
}
function attachSourceChoice(row,copy,side,candidate,match){
 if(!sourceSelectionQuestion||!sourceSearchSnapshot?.search_id||!selectableSource(candidate,match))return;
 const key=sourceChoiceKey(candidate,match),existing=selectedSources.get(key),draft=sourceDrafts.get(key)||{candidate,match,input:{...(candidate.endpoint.input_values||{})},controls:new Map()};sourceDrafts.set(key,draft);
 draft.candidate=candidate;draft.match=match;
 const editor=sourceInputEditor(candidate,draft),label=el('label','source-choice-label'),checkbox=el('input','source-choice');checkbox.type='checkbox';checkbox.checked=!!existing;
 const subject=sourceSearchSnapshot?.parsed_request?.subjects?.find(subject=>subject.id===(candidate.subject_id||match?.subject_id));
 checkbox.setAttribute('aria-label','Select '+(candidate.name||candidate.endpoint.source?.name||'source')+(subject?.label?' for '+subject.label:''));
 label.append(checkbox,el('span','','Select'));side.append(label);copy.append(editor);
 if(!sourceChoices.has(key))sourceChoices.set(key,[]);sourceChoices.get(key).push({checkbox,editor,row,draft});
 checkbox.onchange=()=>{if(busy||checkbox.checked&&!selectedSources.has(key)&&selectedSources.size>=10){syncSourceSelection();return}checkbox.checked?selectedSources.set(key,draft):selectedSources.delete(key);sourcePrepareIdentity=null;syncSourceSelection()};
}
function selectedSourceInputs(){
 return [...selectedSources.values()].map(draft=>{
  const values={...draft.input};
  for(const {control,definition} of draft.controls.values()){
   if(control.reportValidity&&!control.reportValidity())throw new Error('Review '+searchInputLabel(definition)+'.');
   const value=sourceValue(control,definition);if(value===undefined)delete values[definition.field];else values[definition.field]=value;
  }
  draft.input=values;
  const subject=draft.candidate.subject_id||draft.match?.subject_id;
  return {endpoint_id:draft.candidate.endpoint_id||draft.candidate.endpoint.endpoint_id,capability:draft.candidate.capability||draft.candidate.endpoint.capability,input:values,...(subject?{subject_id:subject}:{})};
 });
}
function sourceRequestId(){return globalThis.crypto?.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16)})}
async function reviewSelectedSources(){
 if(busy||!selectedSources.size)return;
 let selections;try{selections=selectedSourceInputs()}catch(error){showFeedback(error.message,'error');return}
 const question=sourceSelectionQuestion,parsed_request=sourceSearchSnapshot?.parsed_request,search_id=sourceSearchSnapshot?.search_id,fingerprint=JSON.stringify({question,parsed_request,search_id,selections});
 if(!search_id){showFeedback('Refresh sources before reviewing your selection.','error');return}
 if(sourcePrepareIdentity?.fingerprint!==fingerprint)sourcePrepareIdentity={fingerprint,request_id:sourceRequestId()};
 const request_id=sourcePrepareIdentity.request_id;
 busy=true;syncSourceSelection();showFeedback('Preparing one total price for your selected sources…');
 try{const next=await window.apiosk.callTool('apiosk_ask',{question,request_id,input:{apiosk_source_selection_v1:{parsed_request,search_id,selections}}});if(next?.state?.state_ref)sourcePreparedTask=next.state.state_ref;acceptResponse(next);if(['source_refresh_required','search_refresh_required'].includes(next?.error_code)||(next?.errors||[]).some(error=>['source_refresh_required','search_refresh_required'].includes(error.code)))showSourceRefresh()}
 catch(error){showFeedback(error?.message||'The quote could not be confirmed. Your selections are kept; try again.','error')}
 finally{busy=false;syncSourceSelection()}
}
function renderSourceReview(){
 if(!sourceSelectionQuestion)return;
 if(!sourceSearchSnapshot?.search_id||!Array.isArray(sourceSearchSnapshot?.source_options)||!sourceChoices.size&&sourceSearchNeedsRefresh(sourceSearchSnapshot)){const s=section('Choose sources');s.append(el('p','meta','Refresh this source list to choose one or more sources. Nothing is bought.'));appendSourceRefresh(s);return}
 if(!sourceChoices.size)return;
 const s=section('Selected sources');sourceSelectionCount=el('p','meta');s.append(sourceSelectionCount,el('p','meta','Selecting sources is free. Review one total price, then approve once.'));
 const actions=el('div','actions');sourceReviewButton=el('button','primary review-sources','Review selected sources');sourceReviewButton.type='button';sourceReviewButton.onclick=reviewSelectedSources;actions.append(sourceReviewButton);s.append(actions);if(sourceSearchNeedsRefresh(sourceSearchSnapshot)){s.append(el('p','meta','Refresh to load the inputs for the remaining offered sources.'));appendSourceRefresh(s)}syncSourceSelection();
}
async function refreshSourceSearch(button,question,selections,original){
 if(busy)return;busy=true;button.disabled=true;showFeedback('Refreshing available sources…');
 try{
  const next=await window.apiosk.callTool('apiosk_ask',{question});
  if(next?.view!=='source_search'||sourceSearchNeedsRefresh(next)){showFeedback(next?.message||'Sources could not be refreshed. Try again.','error');return}
  const restored=Array.isArray(selections)?restoreSourceSelections(selections,original,next):null;
  const refreshed={...next,question,...(restored?{selected_sources:restored}:{})};
  if(Array.isArray(selections))sourceSelectionSession=null;
  render(refreshed);void window.apiosk.context(refreshed).catch(()=>{});
 }catch(error){showFeedback(error?.message||'Sources could not be refreshed. Try again.','error')}
 finally{busy=false;button.disabled=false;syncSourceSelection()}
}
function appendSourceRefresh(target){const button=el('button','quiet','Refresh sources');button.type='button';button.onclick=()=>refreshSourceSearch(button,sourceSelectionQuestion);target.append(button)}
function showSourceRefresh(){appendSourceRefresh(byId('feedback-actions'));window.apiosk.resize()}
function renderSourceSelectionChange(data){
 if(!planSurface||data.context_view?.source_selection?.can_choose===false||data.billing?.authorization_active||data.context_view?.worker_active||['running','succeeded','partial','cancelled'].includes(data.status))return;
 const configured=data.context_view?.source_selection,question=configured?.question||sourceQuestion(data),intake=configured?.original_intake||data.context_view?.capability_intake;
 const same=sourcePreparedTask===data.state?.state_ref||(question&&question===sourceSearchSnapshot?.question);
 const snapshot=same&&sourceSearchSnapshot?sourceSearchSnapshot:intake?.matches&&question?{...intake,question,view:'source_search',search_id:configured?.search_id,source_options:configured?.options||intake.source_options,parsed_request:configured?.parsed_request||intake.parsed_request,selected_sources:data.context_view?.selected_sources||configured?.selections}:null;
 if(!snapshot?.question)return;
 const actions=el('div','actions source-change'),button=el('button','quiet','Change sources');button.type='button';button.onclick=async()=>{if(busy)return;if(sourceSearchNeedsRefresh(snapshot)){await refreshSourceSearch(button,snapshot.question,snapshot.selected_sources||data.context_view?.selected_sources||configured?.selections,snapshot.parsed_request);return}render(snapshot)};actions.append(button);planSurface.append(actions);
}
`;
