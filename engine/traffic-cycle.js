import { validateTrafficExchange } from './traffic-contract.js';

/**
 * TI-03. Caller owns IDs, time and the initial planner state.
 * evaluate(request) and plan({request,response,previousPlan,attempt}) are injected async functions.
 * Planner returns {etaMs,segments:[{segmentRef,expectedEntryAt,...}], ...}.
 * createRequest({cycle,attempt,plan,inputRevision,requestId}) must supply full TI-01 request.
 */
export function createTrafficCycle({ evaluate, plan, createRequest, validate = validateTrafficExchange } = {}) {
  if (![evaluate,plan,createRequest,validate].every(fn=>typeof fn==='function')) throw new TypeError('callbacks required');
  let generation=0, active=null;
  const snapshot=()=>active&&({cycle:active.cycle,routeRevision:active.routeRevision,attempt:active.attempt,status:active.status,etaMs:active.etaMs});
  const cancel=()=>{generation++;if(active)active.status='cancelled';active=null;return {status:'cancelled'};};
  const run=async ({cycle,routeRevision,initialPlan,requestIds,inputRevisions}={})=>{
    if(typeof cycle!=='string'||!cycle||typeof routeRevision!=='string'||!routeRevision||!Array.isArray(requestIds)||requestIds.length<3||new Set(requestIds.slice(0,3)).size!==3||!Array.isArray(inputRevisions)||inputRevisions.length<3||!initialPlan||!Number.isFinite(initialPlan.etaMs))return {status:'invalid_input',attempts:0};
    const token=++generation;
    const state={cycle,routeRevision,attempt:0,status:'running',etaMs:initialPlan.etaMs};active=state;
    const current=()=>token===generation&&active===state;
    let previous=initialPlan, lastPassability=null, lastAccepted=null;
    for(let attempt=1;attempt<=3;attempt++){
      if(!current())return {status:'cancelled',attempts:attempt-1};
      state.attempt=attempt;
      let request,response,next;
      try{
        request=await createRequest({cycle,routeRevision,attempt,plan:previous,inputRevision:inputRevisions[attempt-1],requestId:requestIds[attempt-1]});
        if(!current())return {status:'cancelled',attempts:attempt-1};
        if(!request||request.routeRevision!==routeRevision||request.evaluationCycle!==cycle||request.attempt!==attempt||request.requestId!==requestIds[attempt-1]||request.inputRevision!==inputRevisions[attempt-1])return {status:'invalid_request',attempts:attempt};
        response=await evaluate(request);
        if(!current())return {status:'cancelled',attempts:attempt-1};
        const result=validate(request,response,{activeRequest:request});
        if(!result?.valid)return {status:'invalid_exchange',attempts:attempt,errors:result?.errors??[]};
        // Do not silently accept stale IDs even if an injected validator is permissive.
        for(const field of ['requestId','routeRevision','evaluationCycle','inputRevision','attempt'])if(response?.[field]!==request[field])return {status:'stale_exchange',attempts:attempt,field};
        if(response.segments?.some(s=>s.passability==='closed'||s.selected?.durationSeconds===null))return {status:'unavailable',attempts:attempt,reason:'closed_or_null_duration'};
        if(response.segments?.some(s=>s.passability==='unknown'||s.vehicleApplicability!=='covered'||s.selected?.status!=='fresh'))return {status:'limited',attempts:attempt,reason:'unknown_or_uncovered'};
        next=await plan({request,response,previousPlan:previous,attempt});
        if(!current())return {status:'cancelled',attempts:attempt-1};
      }catch(error){return {status:'callback_error',attempts:attempt,stage:!request?'createRequest':!response?'evaluate':'plan',message:String(error?.message??error)};}
      if(!next||!Number.isFinite(next.etaMs)||!Array.isArray(next.segments))return {status:'invalid_plan',attempts:attempt};
      const passability=response.segments.map(s=>s.passability);
      const deltaSeconds=Math.abs(next.etaMs-previous.etaMs)/1000;
      state.etaMs=next.etaMs;lastAccepted={request,response,plan:next};
      const unchanged=lastPassability===null||JSON.stringify(passability)===JSON.stringify(lastPassability);
      // First iteration may converge against caller's initial plan only when baseline passability was supplied.
      const baseline=lastPassability??previous.passability;
      const same=Array.isArray(baseline)&&JSON.stringify(passability)===JSON.stringify(baseline);
      if(deltaSeconds<=60&&same){state.status='converged';return {status:'converged',attempts:attempt,etaMs:next.etaMs,plan:next};}
      lastPassability=passability;previous=next;
    }
    state.status='unstable_estimate';
    return {status:'unstable_estimate',attempts:3,etaMs:previous.etaMs,plan:previous,reason:'max_attempts_without_convergence'};
  };
  return {run,cancel,snapshot};
}
