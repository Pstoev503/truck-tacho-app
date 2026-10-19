/** TI-02 pure contract validation. No IO, clock, or mutation. */
export function validateTrafficExchange(request, response, {activeRequest} = {}) {
  const errors=[], warnings=[];
  const fail=(code,path)=>errors.push({code,path});
  const warn=(code,path)=>warnings.push({code,path});
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const id=x=>typeof x==='string'&&x.trim().length>0;
  const secs=(x,p)=>{if(x!==null&&(!Number.isSafeInteger(x)||x<0))fail('DURATION',p);};
  const source=(x,p)=>{if(!object(x)){fail('SOURCE',p);return;}for(const k of ['sourceId','recordId','recordVersion','licenseRef'])if(!id(x[k]))fail('SOURCE_FIELD',p+'.'+k);};
  const utc=(x,p)=>{if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(x)||!Number.isFinite(Date.parse(x)))fail('UTC',p);};
  const en=(x,values,p)=>{if(!values.includes(x))fail('ENUM',p);};
  const statuses=['fresh','stale','unavailable','unknown'];
  if(!object(request)){fail('REQUEST','request');request={};}
  if(!object(response)){fail('RESPONSE','response');response={};}
  for(const [name,v] of [['request',request],['response',response]])if(v.contractVersion!=='0.1')fail('VERSION',name+'.contractVersion');
  for(const k of ['requestId','routeRevision','evaluationCycle','inputRevision']){
    if(!id(request[k]))fail('ID','request.'+k);
    if(response[k]!==request[k])fail('ECHO','response.'+k);
    if(activeRequest!==undefined&&(!object(activeRequest)||activeRequest[k]!==request[k]))fail('STALE_REQUEST','request.'+k);
  }
  if(!Number.isSafeInteger(request.attempt)||request.attempt<1||request.attempt>3)fail('ATTEMPT','request.attempt');
  if(response.attempt!==request.attempt)fail('ECHO','response.attempt');
  if(activeRequest!==undefined&&activeRequest?.attempt!==request.attempt)fail('STALE_REQUEST','request.attempt');
  utc(request.departureAt,'request.departureAt');utc(response.evaluatedAt,'response.evaluatedAt');
  if(!id(request.vehicleProfileRef))fail('VEHICLE_PROFILE','request.vehicleProfileRef');
  en(response.summaryStatus,statuses,'response.summaryStatus');
  const rs=Array.isArray(request.segments)?request.segments:[];
  const ss=Array.isArray(response.segments)?response.segments:[];
  if(!rs.length||!Array.isArray(request.segments))fail('SEGMENTS','request.segments');
  if(!Array.isArray(response.segments)||rs.length!==ss.length)fail('SEGMENTS','response.segments');
  const refs=new Set();
  rs.forEach((a,i)=>{
    const p='request.segments['+i+']',t='response.segments['+i+']',b=ss[i];
    if(!object(a)){fail('SEGMENT',p);return;}
    if(!id(a.segmentRef)||refs.has(a.segmentRef))fail('DUPLICATE_REF',p+'.segmentRef');
    refs.add(a.segmentRef);
    if(a.sequence!==i)fail('ORDER',p+'.sequence');
    utc(a.expectedEntryAt,p+'.expectedEntryAt');secs(a.baseDurationSeconds,p+'.baseDurationSeconds');
    if(a.geometry!==null&&(!object(a.geometry)||a.geometry.type!=='LineString'||!Array.isArray(a.geometry.coordinates)||a.geometry.coordinates.length<2))fail('GEOMETRY',p+'.geometry');
    en(a.direction,['forward','reverse','unknown'],p+'.direction');
    if(!object(b)){fail('SEGMENT',t);return;}
    if(b.segmentRef!==a.segmentRef||b.sequence!==i)fail('SEGMENT_ECHO',t);
    if(b.expectedEntryAt!==a.expectedEntryAt)fail('ENTRY_ECHO',t+'.expectedEntryAt');
    en(b.status,statuses,t+'.status');
    en(b.matching,['matched','ambiguous','unmatched'],t+'.matching');
    en(b.vehicleApplicability,['covered','not_covered','unknown'],t+'.vehicleApplicability');
    en(b.passability,['open','closed','unknown'],t+'.passability');
    const candidates=new Map();
    for(const k of ['routingBase','measured','historical','forecast']){
      const x=b[k],cp=t+'.'+k;
      if(x==null)continue;
      if(!object(x)){fail('CANDIDATE',cp);continue;}
      if(!id(x.candidateRef)||candidates.has(x.candidateRef))fail('CANDIDATE_REF',cp+'.candidateRef');
      else candidates.set(x.candidateRef,x);
      secs(x.durationSeconds,cp+'.durationSeconds');
      if(x.unit!==undefined&&x.unit!=='seconds')fail('UNIT',cp+'.unit');
      if(x.durationSeconds!==null)source(x.source,cp+'.source');
      if(x.durationSeconds!==null&&x.kind!==({routingBase:'routing_base',measured:'measured',historical:'historical',forecast:'forecast'}[k]))fail('CANDIDATE_KIND',cp+'.kind');
      else if(x.kind!==undefined)en(x.kind,['routing_base','measured','historical','forecast'],cp+'.kind');
      if(k==='measured'&&x.kind==='count')fail('COUNT_ONLY',cp+'.kind');
      if(x.status!==undefined)en(x.status,statuses,cp+'.status');
      for(const k2 of ['observedAt','publishedAt','receivedAt','validFrom','validTo','generatedAt'])if(x[k2]!=null)utc(x[k2],cp+'.'+k2);
      if(x.validFrom&&x.validTo&&Date.parse(x.validFrom)>=Date.parse(x.validTo))fail('RANGE',cp);
      if(x.validFrom&&Date.parse(a.expectedEntryAt)<Date.parse(x.validFrom)||x.validTo&&Date.parse(a.expectedEntryAt)>=Date.parse(x.validTo))warn('OUTSIDE_WINDOW',cp);
      if(k==='forecast'&&x.status!=='unavailable'&&(!x.generatedAt||!Number.isSafeInteger(x.horizonSeconds)))fail('FORECAST',cp);
    }
    const incidents=Array.isArray(b.incidents)?b.incidents:[];
    if(!Array.isArray(b.incidents))fail('INCIDENTS',t+'.incidents');
    const ev=new Map();
    incidents.forEach((e,j)=>{
      const ep=t+'.incidents['+j+']';
      if(!object(e)){fail('INCIDENT',ep);return;}
      if(!id(e.eventRef)||ev.has(e.eventRef))fail('DUPLICATE_EVENT',ep+'.eventRef');
      ev.set(e.eventRef,e);
      en(e.effectKind,['none','replacement','adjustment'],ep+'.effectKind');
      en(e.closure,['open','closed','unknown'],ep+'.closure');
      source(e.source,ep+'.source');
      if(e.validFrom)utc(e.validFrom,ep+'.validFrom');
      if(e.validTo)utc(e.validTo,ep+'.validTo');
      if(e.validFrom&&e.validTo&&Date.parse(e.validFrom)>=Date.parse(e.validTo))fail('RANGE',ep);
      if(e.alreadyIncludedIn!==undefined&&!Array.isArray(e.alreadyIncludedIn))fail('INCLUDED_ARRAY',ep+'.alreadyIncludedIn');
      if(e.closure==='closed'&&(e.effectKind!=='none'||e.adjustmentSeconds!==null||e.replacementDurationSeconds!==null))fail('CLOSURE_EFFECT',ep);
      if(e.effectKind==='none'&&(e.adjustmentSeconds!==null||e.replacementDurationSeconds!==null))fail('NONE_EFFECT',ep);
      if(e.effectKind==='replacement'){
        if(!Number.isSafeInteger(e.replacementDurationSeconds)||e.replacementDurationSeconds<0||e.adjustmentSeconds!==null||e.baseCandidateRef!==null)fail('REPLACEMENT',ep);
      }
      if(e.effectKind==='adjustment'){
        if(!Number.isSafeInteger(e.adjustmentSeconds)||e.replacementDurationSeconds!==null)fail('ADJUSTMENT',ep);
        if(!candidates.has(e.baseCandidateRef))fail('BASE_REF',ep+'.baseCandidateRef');
      }
    });
    const x=b.selected,sp=t+'.selected';
    if(!object(x)){fail('SELECTED',sp);return;}
    secs(x.durationSeconds,sp+'.durationSeconds');
    if(x.unit!==undefined&&x.unit!=='seconds')fail('UNIT',sp+'.unit');
    en(x.status,statuses,sp+'.status');
    if(x.durationSeconds!==null&&!['routing_base','measured','historical','forecast','replacement','derived_adjustment'].includes(x.kind))fail('SELECTED_KIND',sp+'.kind');
    if(x.durationSeconds!==null)source(x.source,sp+'.source');
    const applied=Array.isArray(x.appliedEventRefs)?x.appliedEventRefs:[];
    if(!Array.isArray(x.appliedEventRefs))fail('APPLIED',sp+'.appliedEventRefs');
    if(new Set(applied).size!==applied.length)fail('DUPLICATE_APPLIED',sp);
    const provenance=Array.isArray(b.provenance)?b.provenance:[];
    if(!Array.isArray(b.provenance))fail('PROVENANCE',t+'.provenance');
    provenance.forEach((v,j)=>source(v,t+'.provenance['+j+']'));
    const lineage=(candidate,path)=>{if(candidate&&!provenance.some(p=>p?.candidateRef===candidate.candidateRef&&p.sourceId===candidate.source?.sourceId&&p.recordId===candidate.source?.recordId&&p.recordVersion===candidate.source?.recordVersion&&p.licenseRef===candidate.source?.licenseRef))fail('CANDIDATE_LINEAGE',path);};
    const sameSource=(a,b)=>object(a)&&object(b)&&['sourceId','recordId','recordVersion','licenseRef'].every(k=>a[k]===b[k]);
    if(b.passability==='open'&&!provenance.some(v=>v?.kind==='passability_open'&&v.direction===a.direction&&v.vehicleProfileRef===request.vehicleProfileRef&&Date.parse(v.validFrom)<=Date.parse(a.expectedEntryAt)&&Date.parse(a.expectedEntryAt)<Date.parse(v.validTo)))fail('OPEN_UNPROVEN',t+'.passability');
    if(b.passability==='closed'&&(x.durationSeconds!==null||!incidents.some(e=>e?.closure==='closed'&&e.effectKind==='none')))fail('CLOSED_ETA',sp);
    if(x.candidateRef!==null&&!candidates.has(x.candidateRef)&&!applied.some(ref=>{const e=ev.get(ref);return e?.effectKind==='replacement'&&x.candidateRef==='replacement:'+e.eventRef+':'+e.eventVersion||e?.effectKind==='adjustment'&&x.candidateRef==='derived:'+e.baseCandidateRef+':'+e.eventRef;}))fail('SELECTED_REF',sp+'.candidateRef');
    if(x.durationSeconds!==null&&x.candidateRef===null)fail('SELECTED_REF',sp+'.candidateRef');
    if(candidates.has(x.candidateRef)){
      const chosen=candidates.get(x.candidateRef),kind=x.kind;
      if(chosen.kind!==undefined&&chosen.kind!==kind)fail('SELECTED_KIND',sp+'.kind');
      if(!sameSource(x.source,chosen.source))fail('SELECTED_SOURCE',sp+'.source');
      lineage(chosen,sp+'.candidateRef');
      if(chosen.status==='stale'&&x.status==='fresh')fail('STALE_SELECTED_FRESH',sp+'.status');
      if(chosen.validFrom&&Date.parse(a.expectedEntryAt)<Date.parse(chosen.validFrom)||chosen.validTo&&Date.parse(a.expectedEntryAt)>=Date.parse(chosen.validTo))fail('SELECTED_OUTSIDE_WINDOW',sp+'.candidateRef');
    }
    if(x.kind==='measured'&&b.measured?.status==='stale'&&x.status==='fresh')fail('STALE_SELECTED_FRESH',sp+'.status');
    if(x.baseCandidateRef!==null&&!candidates.has(x.baseCandidateRef))fail('BASE_REF',sp+'.baseCandidateRef');
    applied.forEach((ref,j)=>{
      const ep=sp+'.appliedEventRefs['+j+']',e=ev.get(ref);
      if(!e){fail('EVENT_REF',ep);return;}
      if(!provenance.some(v=>v?.eventRef===ref&&v.eventVersion===e.eventVersion&&sameSource(v,e.source)))fail('EVENT_LINEAGE',ep);
      if(e.lifecycle==='cancelled'||e.lifecycle==='cleared'||e.lifecycle==='expired')fail('APPLIED_LIFECYCLE',ep);
      if(e.validFrom&&Date.parse(a.expectedEntryAt)<Date.parse(e.validFrom)||e.validTo&&Date.parse(a.expectedEntryAt)>=Date.parse(e.validTo))fail('APPLIED_OUTSIDE_WINDOW',ep);
      if(e.effectKind==='none')fail('NONE_APPLIED',ep);
      if(e.effectKind==='replacement'&&(x.durationSeconds!==e.replacementDurationSeconds||x.candidateRef!=='replacement:'+e.eventRef+':'+e.eventVersion))fail('REPLACEMENT_DURATION',ep);
      if(e.effectKind==='adjustment'){
        if(x.baseCandidateRef!==e.baseCandidateRef)fail('ADJUSTMENT_BASE',ep);
        const derivedBase=candidates.get(e.baseCandidateRef);
        lineage(derivedBase,sp+'.baseCandidateRef');
        if(derivedBase?.status==='stale'&&x.status==='fresh')fail('DERIVED_BASE_STALE',sp+'.status');
        if(derivedBase?.validFrom&&Date.parse(a.expectedEntryAt)<Date.parse(derivedBase.validFrom)||derivedBase?.validTo&&Date.parse(a.expectedEntryAt)>=Date.parse(derivedBase.validTo))fail('DERIVED_BASE_EXPIRED',sp+'.baseCandidateRef');
        if(!id(e.independenceEvidenceRef)||!provenance.some(v=>v?.independenceEvidenceRef===e.independenceEvidenceRef&&id(v.recordId)&&id(v.recordVersion)&&id(v.licenseRef)&&id(v.sourceId)))fail('EVIDENCE',ep);
        if(Array.isArray(e.alreadyIncludedIn)&&e.alreadyIncludedIn.includes(e.baseCandidateRef))fail('DOUBLE_COUNT',ep);
        const base=candidates.get(e.baseCandidateRef);
        if(base&&Number.isSafeInteger(base.durationSeconds)&&Number.isSafeInteger(e.adjustmentSeconds)&&x.durationSeconds!==base.durationSeconds+e.adjustmentSeconds)fail('ADJUSTMENT_SUM',ep);
      }
    });
    if(!applied.length&&candidates.has(x.candidateRef)&&x.durationSeconds!==candidates.get(x.candidateRef).durationSeconds)fail('SELECTED_DURATION',sp);
    if(b.status==='stale'&&x.status==='fresh'&&x.kind==='measured')warn('STALE_SELECTION',sp);
    if(b.vehicleApplicability!=='covered'&&x.kind==='forecast')warn('TRUCK_UNCOVERED',sp);
  });
  return {valid:errors.length===0,errors,warnings};
}
