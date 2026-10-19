import {validateTrafficExchange} from './traffic-contract.js';
import {evaluateTrafficSourceHealth} from './traffic-source-health.js';

/**
 * Fail-closed, read-only TI-05 gate. Every explicit citation is audited, including
 * non-selected candidates and independence-evidence provenance.
 * License references are caller declarations, NOT verified legal permissions.
 */
export function validateTrafficExchangeWithSourceHealth(request,response,options) {
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const id=x=>typeof x==='string'&&x.trim().length>0;
  const envelope=object(options);
  const activeRequest=envelope?options.activeRequest:undefined;
  const contract=validateTrafficExchange(request,response,{activeRequest});
  const sourceHealth=evaluateTrafficSourceHealth(envelope?{evaluatedAt:options.evaluatedAt,sources:options.sources}:null);
  const errors=[...contract.errors];
  const citations=[];
  const cite=(source,path)=>{
    if(!object(source))return;
    // Even malformed explicit citations remain visible to the contract validator.
    if(source.sourceId!==undefined||source.licenseRef!==undefined)
      citations.push({path,sourceId:source.sourceId??null,licenseRef:source.licenseRef??null});
  };
  if(object(response)&&Array.isArray(response.segments))response.segments.forEach((segment,i)=>{
    if(!object(segment))return;
    const p='response.segments['+i+']';
    for(const key of ['routingBase','measured','historical','forecast']){
      const candidate=segment[key];
      if(object(candidate)&&candidate.source!==null&&candidate.source!==undefined)
        cite(candidate.source,p+'.'+key+'.source');
    }
    if(Array.isArray(segment.incidents))segment.incidents.forEach((event,j)=>{
      if(object(event)&&event.source!==null&&event.source!==undefined)
        cite(event.source,p+'.incidents['+j+'].source');
    });
    if(object(segment.selected)&&segment.selected.source!==null&&segment.selected.source!==undefined)
      cite(segment.selected.source,p+'.selected.source');
    if(Array.isArray(segment.provenance))segment.provenance.forEach((record,j)=>
      cite(record,p+'.provenance['+j+']'));
  });
  const healthById=new Map();
  if(sourceHealth.status!=='invalid-input')for(const record of sourceHealth.sources){
    if(id(record.sourceId)){
      const items=healthById.get(record.sourceId)??[];
      items.push(record);
      healthById.set(record.sourceId,items);
    }
  }
  const sourceDiagnostics=[];
  for(const citation of citations){
    const records=id(citation.sourceId)?healthById.get(citation.sourceId)??[]:[];
    let reason=null;
    if(sourceHealth.status==='invalid-input')reason='INVALID_HEALTH_INPUT';
    else if(!id(citation.sourceId))reason='INVALID_CITATION_SOURCE_ID';
    else if(records.length===0)reason='MISSING_PROVIDER';
    else if(records.length!==1||records[0].errors.includes('DUPLICATE_SOURCE_ID'))reason='DUPLICATE_PROVIDER';
    else if(records[0].transportState==='invalid')reason='INVALID_PROVIDER';
    else if(!records[0].usableForEvaluation)reason='PROVIDER_NOT_USABLE';
    else {
      const provider=options.sources[records[0].index];
      if(!id(citation.licenseRef)||provider.licenseRef!==citation.licenseRef)reason='LICENSE_MISMATCH';
    }
    const diagnostic={...citation,reason,transportState:records.length===1?records[0].transportState:null,permissionState:records.length===1?records[0].permissionState:null};
    sourceDiagnostics.push(diagnostic);
    if(reason)errors.push({code:'SOURCE_HEALTH_'+reason,path:citation.path});
  }
  if(sourceHealth.status==='invalid-input')errors.push({code:'SOURCE_HEALTH_INVALID_INPUT',path:'options'});
  return {valid:errors.length===0,errors,warnings:contract.warnings,sourceHealth,sourceDiagnostics,sourceIds:[...new Set(citations.map(x=>x.sourceId).filter(id))]};
}
