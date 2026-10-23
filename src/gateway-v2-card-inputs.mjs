// Shared declared-schema controls for source selection and task clarification.
export const V2_CARD_INPUTS = `
function sourceSchemaValid(value,schema={}){
 if(Array.isArray(schema.enum)&&!schema.enum.some(option=>JSON.stringify(option)===JSON.stringify(value)))return false;
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 if(schema.type&&!types.some(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===type))return false;
 if(typeof value==='number'&&(!Number.isFinite(value)||schema.minimum!=null&&value<schema.minimum||schema.maximum!=null&&value>schema.maximum||schema.exclusiveMinimum!=null&&value<=schema.exclusiveMinimum||schema.exclusiveMaximum!=null&&value>=schema.exclusiveMaximum))return false;
 if(typeof value==='string'){if(schema.minLength!=null&&value.length<schema.minLength||schema.maxLength!=null&&value.length>schema.maxLength)return false;if(schema.pattern){try{if(!new RegExp(schema.pattern).test(value))return false}catch{return false}}}
 if(Array.isArray(value)){if(schema.minItems!=null&&value.length<schema.minItems||schema.maxItems!=null&&value.length>schema.maxItems)return false;if(schema.items&&value.some(item=>!sourceSchemaValid(item,schema.items)))return false}
 if(value&&typeof value==='object'&&!Array.isArray(value)){if((schema.required||[]).some(key=>!Object.hasOwn(value,key)))return false;for(const [key,item] of Object.entries(value)){const definition=schema.properties?.[key];if(definition&&!sourceSchemaValid(item,definition)||!definition&&schema.additionalProperties===false)return false}}
 return true;
}
function sourceValue(control,definition){
 const schema=definition.schema||{},value=control.value,title=searchInputLabel(definition);let parsed=value;
 if(value===''){if(definition.required)throw new Error('Enter '+title+'.');return undefined}
 if(Array.isArray(schema.enum)){parsed=schema.enum.find(option=>(typeof option==='object'?JSON.stringify(option):String(option))===value);if(parsed===undefined)throw new Error('Choose '+title+'.')}
 else if(schema.type==='boolean'){if(value!=='true'&&value!=='false')throw new Error('Choose '+title+'.');parsed=value==='true'}
 else if(schema.type==='integer'||schema.type==='number'){if(!value.trim())throw new Error('Enter a valid number for '+title+'.');parsed=Number(value)}
 else if(schema.type==='object'||schema.type==='array'){try{parsed=JSON.parse(value)}catch{throw new Error('Enter valid JSON for '+title+'.')}}
 if(!sourceSchemaValid(parsed,schema))throw new Error('Review '+title+'.');
 return parsed;
}
function sourceInputControl(definition,value){
 const schema=definition.schema||{},choices=Array.isArray(schema.enum)?schema.enum:schema.type==='boolean'?[true,false]:null;
 const control=el(choices?'select':['object','array'].includes(schema.type)?'textarea':'input','source-input');
 control.setAttribute('aria-label',searchInputLabel(definition));control.dataset.field=definition.field;control.name=definition.field;control.required=!!definition.required;
 if(choices){const empty=el('option','','Choose…');empty.value='';control.append(empty);for(const value of choices){const option=el('option','',typeof value==='object'?JSON.stringify(value):String(value));option.value=typeof value==='object'?JSON.stringify(value):String(value);control.append(option)}}
 else if(['integer','number'].includes(schema.type)){control.type='number';control.step=schema.type==='integer'?'1':'any';if(schema.minimum!=null)control.min=schema.minimum;if(schema.maximum!=null)control.max=schema.maximum}
 else if(control.tagName==='INPUT'){control.type='text';if(schema.pattern)control.pattern=schema.pattern;if(Number.isInteger(schema.minLength))control.minLength=schema.minLength;if(Number.isInteger(schema.maxLength))control.maxLength=schema.maxLength}
 control.value=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);return control;
}
function sourceInputDefinitions(candidate,byName){
 const endpoint=candidate.endpoint,lookup=endpoint.lookup;
 return byName&&lookup?[...endpoint.inputs.filter(definition=>!lookup.resolves.includes(definition.field)&&definition.field!==lookup.field),{field:lookup.field,required:true,schema:lookup.schema||{type:'string'}}]:endpoint.inputs;
}
function sourceInputEditor(candidate,draft){
 const editor=el('div','source-input-editor hidden'),lookup=candidate.endpoint.lookup;
 if(draft.byName===undefined)draft.byName=!!(lookup?.field&&Array.isArray(lookup.resolves)&&lookup.resolves.some(field=>draft.input[field]==null||draft.input[field]===''));
 const fields=el('div','source-input-fields');
 function draw(){
  fields.replaceChildren();draft.controls.clear();
  for(const definition of sourceInputDefinitions(candidate,draft.byName)){
   const label=el('label','source-input-label'),title=searchInputLabel(definition),control=sourceInputControl(definition,draft.input[definition.field]);
   label.append(el('span','',title+(definition.required?'':' (optional)')));
   control.oninput=()=>{draft.controls.set(definition.field,{control,definition});sourcePrepareIdentity=null};control.onchange=control.oninput;
   draft.controls.set(definition.field,{control,definition});label.append(control);fields.append(label);
  }
 }
 if(lookup?.field&&Array.isArray(lookup.resolves)){
  const label=el('label','source-input-label'),toggle=el('input','source-lookup');toggle.type='checkbox';toggle.checked=draft.byName;toggle.setAttribute('aria-label','Look up using '+searchInputLabel(lookup));
  label.append(toggle,el('span','','Look up using '+searchInputLabel(lookup)));editor.append(label);
  toggle.onchange=()=>{for(const {control,definition} of draft.controls.values()){try{const value=sourceValue(control,{...definition,required:false});if(value===undefined)delete draft.input[definition.field];else draft.input[definition.field]=value}catch{}}
   draft.byName=toggle.checked;sourcePrepareIdentity=null;draw();window.apiosk.resize()};
 }
 draw();editor.append(fields);return editor;
}
`;
