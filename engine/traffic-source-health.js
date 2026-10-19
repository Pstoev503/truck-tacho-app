/**
 * TI-04: pure source-health evaluation. All timestamps and durations are UTC milliseconds.
 * No ambient time, I/O or license verification.
 * @param {{evaluatedAt:number,sources:Array<object>}} input
 * @returns {{status:string,reason:string,evaluatedAt:number|null,sources:Array<object>,counts:object}}
 */
export function evaluateTrafficSourceHealth(input) {
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const envelopeValid = input !== null && typeof input === 'object' && !Array.isArray(input);
  const evaluatedAt = envelopeValid ? input.evaluatedAt : undefined;
  const sources = envelopeValid ? input.sources : undefined;
  const invalid = reason => ({status:'invalid-input',reason,evaluatedAt:integer(evaluatedAt)?evaluatedAt:null,sources:[],counts:{total:0,usable:0,invalid:0}});
  if (!envelopeValid) return invalid('INVALID_ENVELOPE');
  if (!integer(evaluatedAt)) return invalid('INVALID_EVALUATED_AT');
  if (!Array.isArray(sources) || sources.length > 1000) return invalid('INVALID_SOURCES');
  const ids = new Map();
  for (const item of sources) if (item && typeof item.sourceId === 'string' && item.sourceId.trim()) ids.set(item.sourceId,(ids.get(item.sourceId)??0)+1);
  const diagnostics = sources.map((source,index)=>{
    const errors=[],warnings=[];
    const id = source && typeof source.sourceId==='string' ? source.sourceId : null;
    if (!id || !id.trim()) errors.push('INVALID_SOURCE_ID');
    else if(ids.get(id)>1) errors.push('DUPLICATE_SOURCE_ID');
    if(!source || typeof source!=='object'||Array.isArray(source)) errors.push('INVALID_SOURCE');
    const interval=source?.expectedIntervalMs, maxAge=source?.maxAgeMs;
    if(!Number.isSafeInteger(interval)||interval<=0)errors.push('INVALID_EXPECTED_INTERVAL');
    if(!Number.isSafeInteger(maxAge)||maxAge<=0)errors.push('INVALID_MAX_AGE');
    const success=source?.lastSuccessAt, attempt=source?.lastAttemptAt;
    if(success!==null&&!integer(success))errors.push('INVALID_LAST_SUCCESS');
    if(attempt!==null&&!integer(attempt))errors.push('INVALID_LAST_ATTEMPT');
    if(integer(success)&&success>evaluatedAt)errors.push('FUTURE_SUCCESS');
    if(integer(attempt)&&attempt>evaluatedAt)errors.push('FUTURE_ATTEMPT');
    if(integer(success)&&integer(attempt)&&attempt<success)errors.push('REVERSED_TIMESTAMPS');
    const failures=source?.consecutiveFailures;
    if(!integer(failures))errors.push('INVALID_FAILURE_COUNT');
    const permission=source?.permissionState;
    if(!['declared-allowed','unknown','denied'].includes(permission))errors.push('INVALID_PERMISSION');
    const license=source?.licenseRef;
    if(license!==null&&(typeof license!=='string'||!license.trim()))errors.push('INVALID_LICENSE_REF');
    if(errors.length)return {index,sourceId:id,transportState:'invalid',permissionState:['declared-allowed','unknown','denied'].includes(permission)?permission:'unknown',usableForEvaluation:false,degraded:true,errors,warnings};
    const transportState=success===null?'no-data':evaluatedAt-success>=maxAge?'stale':'fresh';
    if(transportState==='fresh'&&evaluatedAt-success>=interval)warnings.push('LATE_UPDATE');
    if(failures>0 && (attempt===null || success===null || attempt>=success))warnings.push('RECENT_FAILURES');
    if(permission==='unknown')warnings.push('PERMISSION_UNKNOWN');
    if(permission==='denied')warnings.push('PERMISSION_DENIED');
    if(permission==='declared-allowed'&&license===null)warnings.push('MISSING_LICENSE_REF');
    const usableForEvaluation=transportState==='fresh'&&permission==='declared-allowed'&&license!==null;
    return {index,sourceId:id,transportState,permissionState:permission,usableForEvaluation,degraded:warnings.length>0||!usableForEvaluation,errors,warnings,ageMs:success===null?null:evaluatedAt-success};
  });
  const usable=diagnostics.filter(x=>x.usableForEvaluation).length;
  const invalidCount=diagnostics.filter(x=>x.transportState==='invalid').length;
  const degraded=diagnostics.some(x=>x.degraded);
  const status=usable===0?'unavailable':degraded?'degraded':'usable';
  const reason=usable===0?'NO_USABLE_SOURCES':degraded?'PARTIAL_OR_DEGRADED_SOURCES':'ALL_SOURCES_USABLE';
  return {status,reason,evaluatedAt,sources:diagnostics,counts:{total:sources.length,usable,invalid:invalidCount}};
}
