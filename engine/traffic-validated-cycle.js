import {createTrafficCycle} from './traffic-cycle.js';
import {validateTrafficExchangeWithSourceHealth} from './traffic-source-gate.js';

/**
 * TI-07 composition entry point. Caller owns time, TTL, source declarations and IDs.
 * The accepted cycle and contract/source/temporal gate are never bypassed.
 */
export function createValidatedTrafficCycle(config) {
  if(config===null||typeof config!=='object'||Array.isArray(config)||
     !['evaluate','plan','createRequest','getEvaluationContext'].every(k=>typeof config[k]==='function'))
    throw new TypeError('four callbacks required');
  const {evaluate,plan,createRequest,getEvaluationContext}=config;
  const clone=value=>structuredClone(value);
  const invalid=code=>({valid:false,errors:[{code,path:'options.getEvaluationContext'}]});
  const validate=(request,response,{activeRequest})=>{
    let context;
    try{
      context=getEvaluationContext({request:clone(request),response:clone(response)});
    }catch{
      return invalid('EVALUATION_CONTEXT_ERROR');
    }
    if(context!==null&&typeof context==='object'&&typeof context.then==='function'){
      // Consume a rejecting accidental Promise, without accepting async context.
      try{Promise.resolve(context).catch(()=>{});}catch{}
      return invalid('EVALUATION_CONTEXT_ASYNC');
    }
    if(context===null||typeof context!=='object'||Array.isArray(context))
      return invalid('EVALUATION_CONTEXT_INVALID');
    // Never allow context to override the current cycle's activeRequest.
    try{
      const result=validateTrafficExchangeWithSourceHealth(request,response,{
        evaluatedAt:context.evaluatedAt,
        maxExchangeAgeMs:context.maxExchangeAgeMs,
        sources:context.sources,
        activeRequest
      });
      if(result.errors.some(e=>e.code==='SOURCE_HEALTH_INVALID_INPUT'||
        e.code==='EXCHANGE_INVALID_MAX_AGE'||e.code==='EXCHANGE_INVALID_EVALUATED_AT'))
        return {...result,valid:false,errors:[...result.errors,{code:'EVALUATION_CONTEXT_INVALID',path:'options.getEvaluationContext'}]};
      return result;
    }catch{
      return invalid('EVALUATION_CONTEXT_ERROR');
    }
  };
  const cycle=createTrafficCycle({evaluate,plan,createRequest,validate});
  return {run:cycle.run,cancel:cycle.cancel,snapshot:cycle.snapshot};
}
