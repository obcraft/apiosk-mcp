// The App components own presentation; the saved MCP journal still owns every
// operation. Selecting/editing only asks for metadata and a quote, never buys.
export const ASK_PAGE_BRIDGE = String.raw`
let askPageMount=null,askPageMountNode=null,askPageReuse=false,askPageData=null,askPageRows=[],askPageInputs=[],askPagePurchase=null,askPageSaved=[];
let askPageExternalSession=null;const askPageExternal=new Map();
const askPageDescriptors=new Map();
const askPageOldRender=render,askPageOldSearch=renderSourceSearch,askPageOldSync=syncSourceSelection;
const askPageOldSelectable=selectableSource;
selectableSource=function(candidate,match){return candidate?._ask_page_matched
 ? candidate.origin==='apiosk'&&['supported','unverified'].includes(candidate.availability)&&typeof(candidate.endpoint_id||candidate.endpoint?.endpoint_id)==='string'&&typeof(candidate.capability||candidate.endpoint?.capability)==='string'&&Array.isArray(candidate.endpoint?.inputs)
 : askPageOldSelectable(candidate,match)};
const askPageOldInputs=selectedSourceInputs;
selectedSourceInputs=function(quiet=false){
 if([...selectedSources.values()].some(draft=>draft.askPageValid===false))throw new Error('Review the required source details.');
 return askPageOldInputs(quiet);
};
const askPageKey=source=>JSON.stringify([source.origin,source.endpoint_id||source.endpoint?.endpoint_id||source.api_id||source.url,source.capability,source.subject_id||null,source.endpoint?.input_values||null]);
function askPageEdit(){if(askPagePurchase){askPagePurchase=null;output=askPageData;feedback.classList.add('hidden')}}
function askPageRemoveExternal(api_id){for(const [key,item] of externalBasketSources)if(item.api_id===api_id)externalBasketSources.delete(key)}
function askPageCandidate(source){
 const saved=askPageDescriptors.get(source.id||source.source_id);
 return {...source,_ask_page_matched:true,...(saved?{endpoint:{...saved.descriptor,input_values:{...saved.descriptor.input_values,...source.endpoint?.input_values,...saved.suggested_input}}}:{})};
}
async function askPageInspectNative(row,select=true,savedInput=null){
 if(busy)return;const source_id=row.source.id||row.source.source_id;
 if(!source_id){showFeedback('Refresh sources to load this source’s inputs.','error');showSourceRefresh();return}
 busy=true;syncSourceSelection();
 try{
  const response=await window.apiosk.callTool('inspect_source',{source_id});
  if(response?.view!=='source_metadata'||!Array.isArray(response.descriptor?.inputs))throw new Error('This source’s input details are unavailable.');
  askPageDescriptors.set(source_id,response);row.source=askPageCandidate(row.source);
  const source=row.source,key=sourceChoiceKey(source,row.match);
  attachSourceChoice(el('div'),el('div'),el('div'),source,row.match);
  if(select){const entry=sourceChoices.get(key)?.[0];if(entry){if(select!=='restore')askPageEdit();if(savedInput){entry.draft.input={...source.endpoint.input_values,...savedInput};entry.draft.controls.clear()}selectedSources.set(key,entry.draft)}}
 }catch(error){showFeedback(error?.message||'This source’s input details are unavailable.','error')}
 finally{busy=false;sourceSelectionEdited()}
}
async function askPageToggleExternal(candidate){
 if(busy)return;askPageEdit();
 if(askPageExternal.has(candidate.api_id)){askPageExternal.delete(candidate.api_id);askPageRemoveExternal(candidate.api_id);sourceSelectionEdited();return}
 if(selectedSources.size+askPageExternal.size>=10){showFeedback('Select at most 10 sources at a time.','error');return}
 busy=true;syncSourceSelection();
 try{
  const next=await window.apiosk.callTool('apiosk_external',{action:'source',api_id:candidate.api_id});
  if(next?.view!=='external_source'||next.api_id!==candidate.api_id||!Array.isArray(next.source?.inputs))throw new Error('The source inputs could not be loaded. Try again.');
  askPageExternal.set(candidate.api_id,{source:{...candidate,endpoint:next.source},descriptor:next.source,values:{...next.source.input_values}});
 }catch(error){showFeedback(error?.message||'The source inputs could not be loaded.','error')}
 finally{busy=false;sourceSelectionEdited()}
}
async function askPageAction(run){try{const pending=run();syncSourceSelection();await pending}catch(error){showFeedback(error?.message||'This request could not finish. Try again.','error')}finally{syncSourceSelection()}}
function askPageNewPurchase(mode){return askPageAction(async()=>{
 if(busy)return;busy=true;
 try{acceptResponse(await window.apiosk.callTool('new_purchase',{mode}))}finally{busy=false}
})}
function askPageQuote(){
 if(!askPagePurchase)return null;
 const data=askPagePurchase,entries=data.view==='source_basket'?data.entries:[{kind:data.view==='external_purchase'?'external':'local',response:data}];
 const responses=entries.flatMap(entry=>entry.response?[entry.response]:[]),quotes=entries.map(basketQuote);
 const expiry=quotes.filter(Boolean).map(quote=>Date.parse(quote.expires_at));
 const expired=expiry.some(time=>time<=Date.now()),unconfirmed=entries.some(entry=>entry.uncertain||entry.error||!entry.response)
  ||responses.some(response=>response.context_view?.approval_outcome_unconfirmed||response.billing?.status==='pending_reconciliation');
 const total=data._mcp2?.approval?.max_total_atomic||null;
 return {total,expired,proposal:data.proposal||null,executionEnabled:responses.every(response=>response.context_view?.execution_enabled!==false),steps:responses.flatMap(response=>response.proposal?.step_details||[]),
  notices:responses.flatMap(response=>response.context_view?.coverage_notices||[]),
  errors:entries.flatMap(entry=>[...(entry.error?[entry.error]:[]),...(entry.response?.errors||[]).map(error=>error.message||error.code)]),
  incomplete:entries.some(entry=>!entry.response&&!entry.approval_submitted),
  onRetry:()=>askPageAction(()=>retrySourceBasket(data)),
  canApprove:!!total&&!expired&&!unconfirmed&&responses.every(response=>['ready','requires_approval'].includes(response.status)&&response.context_view?.execution_enabled!==false)&&!approvalRecoveryTask&&externalApprovalRecovery!==data.purchase_id,
  needsRecovery:unconfirmed||!!approvalRecoveryTask||!!data.purchase_id&&externalApprovalRecovery===data.purchase_id,
  onApprove:()=>askPageAction(()=>data.view==='source_basket'?approveSourceBasket(data):data.view==='external_purchase'?approveExternalPurchase(data,el('button')):approvePlan(data,el('button'))),
  onRefresh:()=>askPageAction(()=>data.view==='source_basket'||data.view==='external_purchase'?refreshSourceBasketQuotes(data):refreshPrice(data,el('button'))),
  onStatus:()=>askPageAction(()=>data.view==='source_basket'?refreshSourceBasket(data):data.view==='external_purchase'?refreshExternalPurchase(data,el('button')):refreshTask()),
 };
}
function askPageProps(){
 const inputs=[],selectedKeys=[];
 for(const item of askPageRows){
  const match=item.match,candidate=item.source,key=sourceChoiceKey(candidate,match);
  if(selectedSources.has(key)){
   selectedKeys.push(item.key);
   const entry=sourceChoices.get(key)?.[0];
   if(entry)inputs.push({key:item.key,element:entry.editor,source:candidate,values:entry.draft.input,byName:!!entry.draft.byName,
    onValues:(values,byName)=>{
     const changed=values!==null&&JSON.stringify(basketStable(values))!==JSON.stringify(basketStable(entry.draft.input))||byName!==entry.draft.byName;
     if(changed)askPageEdit();
     entry.draft.askPageValid=values!==null;entry.draft.byName=byName;
     if(values!==null){entry.draft.input=values;entry.draft.controls.clear()}
     sourceSelectionEdited();
    },
   });
  }else if(candidate.api_id&&askPageExternal.has(candidate.api_id)){
   const draft=askPageExternal.get(candidate.api_id);selectedKeys.push(item.key);
   inputs.push({key:item.key,element:draft,source:draft.source,values:draft.values,byName:false,
    onValues:values=>{
     const changed=values!==null&&JSON.stringify(basketStable(values))!==JSON.stringify(basketStable(draft.values));
     if(changed)askPageEdit();askPageRemoveExternal(candidate.api_id);
     if(values!==null){draft.values=values;const saved={api_id:candidate.api_id,source:draft.descriptor,input:values};externalBasketSources.set(basketExternalKey(saved),saved)}
     sourceSelectionEdited();
    },
   });
  }
 }
 if(inputs.length!==askPageInputs.length||inputs.some((item,index)=>item.key!==askPageInputs[index]?.key||item.element!==askPageInputs[index]?.element))askPageInputs=inputs;
 return {data:askPageData,rows:askPageRows,selectedKeys,inputs:askPageInputs,busy:busy||!window.apiosk.can.callTool,
  purchase:askPageQuote(),
  onNewPurchase:()=>askPageNewPurchase('repeat'),
  saved:askPageSaved.map(data=>({output:data,gatewayUrl:window.apioskAskPageGatewayUrl,grouped:askPageRows.length>0,
   source:selectedKeys.length===1?askPageRows.find(row=>row.key===selectedKeys[0])?.source:undefined,
   readResultPage:data.state?.state_ref?async(result_ref,offset,signal)=>{
    signal?.throwIfAborted?.();const response=await window.apiosk.callTool('read_result_page',{task_ref:data.state.state_ref,result_ref,offset});
    signal?.throwIfAborted?.();if(!response?.page)throw new Error('The saved result page is unavailable.');return response.page;
   }:undefined,
   onPrepareQuestion:question=>askPageAction(async()=>{
    if(busy)return;busy=true;
    try{const next=await window.apiosk.callTool('apiosk_discover',{question});acceptResponse(next)}finally{busy=false}
   }),
  })),
  decisions:(askPagePurchase?.view==='source_basket'?askPagePurchase.entries.flatMap(entry=>entry.response?[entry.response]:[]):askPagePurchase?[askPagePurchase]:askPageSaved).map(data=>({output:data,
   onAction:(action,value)=>askPageAction(async()=>{
    if(busy)return;const grouped=output?.view==='source_basket';busy=true;
    try{const next=await window.apiosk.callTool('apiosk_execute',{state:data.state,action_id:action.action_id,input:value,quote_ref:data.proposal?.quote_ref||null,idempotency_key:action.action_id});
     acceptResponse(grouped?await window.apiosk.callTool('status_basket',{}):next)
    }finally{busy=false}
   }),
   onStatus:()=>askPageAction(async()=>{if(busy)return;busy=true;try{acceptResponse(await window.apiosk.callTool('apiosk_status',{task_ref:data.state?.state_ref}))}finally{busy=false}}),
  })),
  quoteError:!feedback.classList.contains('hidden')&&feedbackText.classList.contains('error'),
  onToggle:item=>{
   if(busy)return;
   const row=askPageRows.find(row=>row.key===item.key),candidate=row?.source;if(!candidate)return;
   const entry=sourceChoices.get(sourceChoiceKey(candidate,row.match))?.[0];
   if(entry){askPageEdit();entry.checkbox.checked=!selectedSources.has(sourceChoiceKey(candidate,row.match));entry.checkbox.onchange();return}
   if(candidate.origin==='coinbase'){void askPageToggleExternal(candidate);return}
   void askPageInspectNative(row);
  },
  onClear:()=>{if(busy)return;if(askPageSaved.length){void askPageNewPurchase('sources');return}askPageEdit();clearTimeout(sourceAutoTimer);selectedSources.clear();externalBasketSources.clear();askPageExternal.clear();sourceAutoAttempt=null;sourcePrepareIdentity=null;syncSourceSelection()},
  onReview:()=>reviewSelectedSources(),
 };
}
syncSourceSelection=function(){askPageOldSync();if(askPageMount&&(output?.view==='source_search'||askPagePurchase||askPageSaved.length))askPageMount.update(askPageProps())};
render=function(data){
 const quoteView=data?.view==='source_basket'?(data.entries||[]).every(entry=>!basketIsStarted(entry)):!!(data?.proposal||data?.quote)&&!data.billing?.authorization_active&&['ready','requires_approval'].includes(data.status);
 const views=data?.view==='source_basket'?(data.entries||[]).flatMap(entry=>entry.response?[entry.response]:[]):[data];
 const saved=views.filter(view=>view?.result!=null||view?.context_view?.analysis||view?.context_view?.results?.length||['needs_input','needs_selection','running','succeeded','partial','failed','cancelled','unsupported'].includes(view?.status));
 const embedded=quoteView||saved.length;
 const snapshot=embedded?(data.search||data.basket_search||data.context_view?.source_selection?.original_intake||basketSearchSnapshot()||{view:'source_search',question:sourceQuestion(data),source_rows:[],matches:[],company_context:data.context_view?.companies}):null;
 askPageReuse=!!askPageMount&&!!data?._mcp2?.request_id&&data._mcp2.request_id===askPageData?._mcp2?.request_id&&(embedded||data.view==='source_search');
 if(askPageMount&&!askPageReuse){askPageMount.unmount();askPageMount=null;askPageMountNode=null}
 askPageData=null;askPageRows=[];askPageInputs=[];askPagePurchase=null;askPageSaved=[];
 const card=byId('card');card.classList.toggle('ask-page-discovery',data?.view==='source_search');
 askPageOldRender(data);
 if(embedded&&snapshot&&window.mountApioskAskPage&&el('div').attachShadow){
  sections.replaceChildren();card.classList.add('ask-page-discovery');askPagePurchase=quoteView?data:null;askPageSaved=quoteView?[]:saved;
  renderSourceSearch({...snapshot,_mcp2:data._mcp2,context_view:{...snapshot.context_view,money_display:data.context_view?.money_display||snapshot.context_view?.money_display}});
 }
};
renderSourceSearch=function(data){
 // The old DOM-only test/legacy host stays usable when Shadow DOM is absent.
 // Modern MCP Apps hosts always take the literal App-component renderer.
 const mount=askPageReuse&&askPageMountNode?askPageMountNode:el('div','ask-page-mount');
 if(!mount.attachShadow||!window.mountApioskAskPage)return askPageOldSearch(data);
 const externalSession=JSON.stringify([data._mcp2?.request_id,data.question]);
 if(externalSession!==askPageExternalSession){askPageExternal.clear();askPageDescriptors.clear();askPageExternalSession=externalSession}
 const matches=(data.matches||[]).map(match=>({...match,apiosk:(match.apiosk||[]).map(askPageCandidate),coinbase:match.coinbase||[]}));
 beginSourceSelection(data,matches);askPageData=data;
 if(Array.isArray(data.selected_external_sources)){
  askPageExternal.clear();
  for(const saved of data.selected_external_sources){
   const candidate=(data.source_rows||[]).find(source=>source.api_id===saved.api_id);
   if(candidate&&Array.isArray(saved.source?.inputs))askPageExternal.set(saved.api_id,{source:{...candidate,endpoint:saved.source},descriptor:saved.source,values:saved.input||{}});
  }
 }
 const matched=matches.flatMap(match=>[...match.apiosk,...match.coinbase].map(source=>({source,match})));
 const sources=(Array.isArray(data.source_rows)?data.source_rows:matched.map(item=>item.source)).map(askPageCandidate);
 askPageRows=sources.map(source=>{
  const entry=matched.find(item=>item.source.source_id&&item.source.source_id===source.source_id||askPageKey(item.source)===askPageKey(source));
  const match=entry?.match||{subject_id:source.subject_id,slug:source.capability};
  const subject=data.parsed_request?.subjects?.find(subject=>subject.id===(source.subject_id||match.subject_id));
  const candidate={...source,origin:source.origin||'apiosk',subject_id:source.subject_id||match.subject_id,subject_label:source.subject_label||subject?.label,
    logo_url:source.logo_url||source.endpoint?.source?.logo_url};
  const row={key:askPageKey(candidate),source:candidate,match};
  if(selectableSource(candidate,match))attachSourceChoice(el('div'),el('div'),el('div'),candidate,match);
  return row;
 });
 byId('title').textContent='';byId('subtitle').textContent='';sections.append(mount);
 if(askPageReuse&&askPageMount)askPageMount.update(askPageProps());
 else{askPageMountNode=mount;askPageMount=window.mountApioskAskPage(mount,askPageProps())}
 syncSourceSelection();
 const missing=(data.selected_sources||[]).flatMap(saved=>{
  const row=askPageRows.find(row=>row.source.endpoint_id===saved.endpoint_id&&row.source.capability===saved.capability&&(row.source.subject_id||null)===(saved.subject_id||null));
  return row&&!Array.isArray(row.source.endpoint?.inputs)?[{row,saved}]:[];
 });
 if(missing.length)setTimeout(async()=>{for(const {row,saved} of missing){if(askPageData!==data||busy)return;await askPageInspectNative(row,'restore',saved.input)}},0);
};
`;
