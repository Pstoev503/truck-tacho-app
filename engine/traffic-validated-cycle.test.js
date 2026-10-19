import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createValidatedTrafficCycle} from './traffic-validated-cycle.js';
const examples=[...readFileSync(fileURLToPath(new URL('../docs/traffic-intelligence/SCENARIOS-v0.1.md',import.meta.url)),'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)].map(m=>JSON.parse(m[1]));
const copy=x=>structuredClone(x);
const templateRequest=examples[0],templateResponse=examples[1];
const clock=Date.parse(templateResponse.evaluatedAt);
const sources=()=>{
 const ids=new Set();
 const add=x=>{if(x?.sourceId)ids.add(x.sourceId)};
 for(const s of templateResponse.segments){for(const k of ['routingBase','measured','historical','forecast'])add(s[k]?.source);for(const e of s.incidents)add(e.source);add(s.selected.source);for(const p of s.provenance)add(p)}
 return [...ids].map(sourceId=>({sourceId,licenseRef:'synthetic-only',expectedIntervalMs:10000,maxAgeMs:50000,lastSuccessAt:clock-1000,lastAttemptAt:clock-1000,consecutiveFailures:0,permissionState:'declared-allowed'}));
};
const args=(cycle='cycle-1')=>({cycle,routeRevision:'route-1',initialPlan:{etaMs:1000000,passability:['open'],segments:copy(templateRequest.segments)},requestIds:['req-1','req-2','req-3'],inputRevisions:['input-1','input-2','input-3']});
const setup=(options={})=>{
 const pending=options.pending;
 const stats={plan:0,evaluate:0,context:0};
 const sourceList=sources();
 const createRequest=async ({cycle,routeRevision,attempt,inputRevision,requestId,plan})=>({...copy(templateRequest),requestId,routeRevision,evaluationCycle:cycle,attempt,inputRevision,segments:copy(plan.segments)});
 const evaluate=async request=>{
  stats.evaluate++;
  if(pending)return pending(request,stats.evaluate);
  const response=copy(templateResponse);
  for(const key of ['requestId','routeRevision','evaluationCycle','inputRevision','attempt'])response[key]=request[key];
  response.segments.forEach((s,i)=>{s.expectedEntryAt=request.segments[i].expectedEntryAt;s.passability='open';s.provenance.push({...s.selected.source,kind:'passability_open',direction:request.segments[i].direction,vehicleProfileRef:request.vehicleProfileRef,validFrom:'2026-10-19T08:00:00Z',validTo:'2026-10-19T10:00:00Z'});});
  return response;
 };
 const plan=async ({previousPlan})=>{stats.plan++;return {...copy(previousPlan),etaMs:previousPlan.etaMs+(options.delta??120000)}};
 const getEvaluationContext=({request,response})=>{
  stats.context++;
  if(options.context)return options.context({request,response,stats,sourceList});
  return {evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sourceList};
 };
 const ctrl=createValidatedTrafficCycle({evaluate,plan,createRequest,getEvaluationContext});
 return {ctrl,stats,sourceList};
};
test('validated cycle converges using complete contract',async()=>{const x=setup({delta:30000});const r=await x.ctrl.run(args());assert.equal(r.status,'converged',JSON.stringify(r));assert.equal(x.stats.plan,1)});
test('validated cycle unstable after 3 valid evaluations',async()=>{const x=setup();const r=await x.ctrl.run(args());assert.equal(r.status,'unstable_estimate',JSON.stringify(r));assert.equal(x.stats.plan,3);assert.equal(x.stats.context,3)});
test('missing cited provider prevents planner',async()=>{const x=setup({context:({sourceList})=>({evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sourceList.filter(s=>s.sourceId!=='synthetic-live')})});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange');assert.equal(x.stats.plan,0)});
test('denied provider prevents planner',async()=>{const x=setup({context:({sourceList})=>({evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sourceList.map(s=>({...s,permissionState:'denied'}))})});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange');assert.equal(x.stats.plan,0)});
test('license mismatch prevents planner',async()=>{const x=setup({context:({sourceList})=>({evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sourceList.map(s=>({...s,licenseRef:'different'}))})});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange');assert.equal(x.stats.plan,0)});
test('stale exchange prevents planner',async()=>{const x=setup({context:({sourceList})=>({evaluatedAt:clock+1,maxExchangeAgeMs:1,sources:sourceList.map(s=>({...s,lastSuccessAt:clock,lastAttemptAt:clock}))})});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange');assert.equal(x.stats.plan,0)});
test('future exchange prevents planner',async()=>{const x=setup({context:({sourceList})=>({evaluatedAt:clock-1,maxExchangeAgeMs:60000,sources:sourceList})});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange');assert.equal(x.stats.plan,0)});
test('context throws without leaking secret',async()=>{const x=setup({context:()=>{throw Error('SECRET_CREDENTIAL')}});const r=await x.ctrl.run(args());assert.equal(r.status,'invalid_exchange');assert.deepEqual(r.errors,[{code:'EVALUATION_CONTEXT_ERROR',path:'options.getEvaluationContext'}]);assert.equal(x.stats.plan,0)});
test('context null fail-closed',async()=>{const x=setup({context:()=>null});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange');assert.equal(x.stats.plan,0)});
test('context string fail-closed',async()=>{const x=setup({context:()=> 'bad'});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange')});
test('context array fail-closed',async()=>{const x=setup({context:()=>[]});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange')});
test('context missing TTL fail-closed',async()=>{const x=setup({context:({sourceList})=>({evaluatedAt:clock,sources:sourceList})});const r=await x.ctrl.run(args());assert.equal(r.status,'invalid_exchange');assert.ok(r.errors.some(e=>e.code==='EVALUATION_CONTEXT_INVALID'))});
test('context invalid clock fail-closed',async()=>{const x=setup({context:({sourceList})=>({evaluatedAt:'bad',maxExchangeAgeMs:60000,sources:sourceList})});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange')});
test('context rejected Promise consumed and rejected',async()=>{const x=setup({context:()=>Promise.reject(Error('SECRET_PROMISE'))});const r=await x.ctrl.run(args());assert.equal(r.status,'invalid_exchange');assert.deepEqual(r.errors,[{code:'EVALUATION_CONTEXT_ASYNC',path:'options.getEvaluationContext'}])});
test('context resolved Promise rejected synchronously',async()=>{const x=setup({context:()=>Promise.resolve({evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sources()})});assert.equal((await x.ctrl.run(args())).status,'invalid_exchange')});
test('activeRequest override cannot bypass lineage',async()=>{const x=setup({context:({sourceList})=>({activeRequest:{requestId:'fake'},evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sourceList})});assert.equal((await x.ctrl.run(args())).status,'unstable_estimate')});
test('context receives read-only copies not engine-owned references',async()=>{const x=setup({context:({request,response,sourceList})=>{assert.throws(()=>{request.requestId='fake'},TypeError);assert.throws(()=>{response.requestId='fake'},TypeError);return {evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sourceList}}});assert.equal((await x.ctrl.run(args())).status,'unstable_estimate')});
test('frozen callback originals accepted without mutation',async()=>{const x=setup({context:({request,response,sourceList})=>{Object.freeze(request);Object.freeze(response);return Object.freeze({evaluatedAt:clock,maxExchangeAgeMs:60000,sources:Object.freeze(sourceList)})}});assert.equal((await x.ctrl.run(args())).status,'unstable_estimate')});
test('reuse cycle refused',async()=>{const x=setup();await x.ctrl.run(args());assert.equal((await x.ctrl.run(args())).status,'cycle_reused');assert.equal(x.stats.context,3)});
test('different cycle resets budget',async()=>{const x=setup();await x.ctrl.run(args());const r=await x.ctrl.run(args('cycle-2'));assert.equal(r.status,'unstable_estimate');assert.equal(x.stats.plan,6)});
test('cancel invalidates pending evaluation',async()=>{let release;const wait=new Promise(resolve=>release=resolve);const x=setup({pending:()=>wait});const run=x.ctrl.run(args());for(let i=0;i<20&&x.stats.evaluate===0;i++)await Promise.resolve();x.ctrl.cancel();release({});assert.equal((await run).status,'cancelled');assert.equal(x.stats.plan,0);assert.equal(x.ctrl.snapshot(),null)});
test('superseded old evaluation cannot poison new snapshot',async()=>{let release;const wait=new Promise(resolve=>release=resolve);const x=setup({pending:(_request,n)=>n===1?wait:Promise.resolve({})});const old=x.ctrl.run(args());for(let i=0;i<20&&x.stats.evaluate===0;i++)await Promise.resolve();const newer=await x.ctrl.run(args('cycle-2'));assert.equal(newer.status,'invalid_exchange');release({});assert.equal((await old).status,'cancelled');assert.deepEqual([x.ctrl.snapshot().cycle,x.ctrl.snapshot().status],['cycle-2','invalid_exchange'])});
test('superseded old rejection cannot poison new snapshot',async()=>{let reject;const wait=new Promise((_,fail)=>reject=fail);const x=setup({pending:(_request,n)=>n===1?wait:Promise.resolve({})});const old=x.ctrl.run(args());for(let i=0;i<20&&x.stats.evaluate===0;i++)await Promise.resolve();const newer=await x.ctrl.run(args('cycle-2'));assert.equal(newer.status,'invalid_exchange');reject(Error('old SECRET'));assert.equal((await old).status,'cancelled');assert.equal(x.ctrl.snapshot().status,'invalid_exchange')});
test('callback requirements reject missing context',()=>assert.throws(()=>createValidatedTrafficCycle({evaluate:()=>{},plan:()=>{},createRequest:()=>{}}),TypeError));
test('cannot install validate override',async()=>{const x=setup();const r=await x.ctrl.run(args());assert.equal(r.status,'unstable_estimate');assert.equal(typeof x.ctrl.validate,'undefined')});
test('no ambient clock',async()=>{const now=Date.now;Date.now=()=>{throw Error('ambient clock')};try{const x=setup({delta:30000});assert.equal((await x.ctrl.run(args())).status,'converged')}finally{Date.now=now}});
test('snapshot exposes accepted cycle fields',async()=>{const x=setup({delta:30000});await x.ctrl.run(args());assert.deepEqual([x.ctrl.snapshot().cycle,x.ctrl.snapshot().status],['cycle-1','converged'])});

test('throwing then accessor is a generic invalid exchange without exception leakage',async()=>{
 const x=setup({context:()=>Object.defineProperty({},'then',{get(){throw Error('SYNTHETIC_SECRET')}})});
 const result=await x.ctrl.run(args());
 assert.equal(result.status,'invalid_exchange');
 assert.deepEqual(result.errors,[{code:'EVALUATION_CONTEXT_ERROR',path:'options.getEvaluationContext'}]);
 assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'),false);
 assert.equal(x.stats.plan,0);
});
test('throwing source context accessor never reaches cycle callback_error',async()=>{
 const x=setup({context:()=>Object.defineProperty({evaluatedAt:clock,maxExchangeAgeMs:60000},'sources',{get(){throw Error('SYNTHETIC_SOURCE_SECRET')}})});
 const result=await x.ctrl.run(args());
 assert.equal(result.status,'invalid_exchange');assert.equal(result.errors[0].code,'EVALUATION_CONTEXT_ERROR');
 assert.equal(JSON.stringify(result).includes('SYNTHETIC_SOURCE_SECRET'),false);assert.equal(x.stats.plan,0);
});
test('native rejected Promise with poisoned then is consumed through intrinsic',async()=>{
 const x=setup({context:()=>{const p=Promise.reject(Error('SYNTHETIC_PROMISE_SECRET'));Object.defineProperty(p,'then',{get(){throw Error('POISONED_THEN')}});return p;}});
 const result=await x.ctrl.run(args());
 assert.equal(result.status,'invalid_exchange');assert.equal(result.errors[0].code,'EVALUATION_CONTEXT_ASYNC');assert.equal(x.stats.plan,0);
 await new Promise(resolve=>setImmediate(resolve));
});
test('function thenable rejection is consumed and never accepted as context',async()=>{
 const x=setup({context:()=>{const fn=()=>{};fn.then=(_resolve,reject)=>reject(Error('SYNTHETIC_THENABLE_SECRET'));return fn;}});
 const result=await x.ctrl.run(args());
 assert.equal(result.status,'invalid_exchange');assert.equal(result.errors[0].code,'EVALUATION_CONTEXT_ASYNC');assert.equal(x.stats.plan,0);
 await new Promise(resolve=>setImmediate(resolve));
});
test('nested request and response copies are deeply frozen without freezing sources',async()=>{
 const x=setup({delta:30000,context:({request,response,sourceList})=>{
  for(const value of [request,response,request.segments,response.segments,request.segments[0],response.segments[0],response.segments[0].selected]){
   assert.equal(Object.isFrozen(value),true);
  }
  assert.throws(()=>request.segments.push({}),TypeError);
  assert.throws(()=>{response.segments[0].passability='closed'},TypeError);
  assert.equal(Object.isFrozen(sourceList),false);assert.equal(Object.isFrozen(sourceList[0]),false);
  return{evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sourceList};
 }});
 assert.equal((await x.ctrl.run(args())).status,'converged');
 assert.equal(Object.isFrozen(templateRequest),false);assert.equal(Object.isFrozen(templateResponse),false);
});
test('context cancellation prevents any actual planner call',async()=>{
 const x=setup({delta:30000,context:()=>{x.ctrl.cancel();return{evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sources()};}});
 const result=await x.ctrl.run(args());assert.equal(result.status,'cancelled');assert.equal(x.stats.plan,0);assert.equal(x.ctrl.snapshot(),null);
});
test('context supersession never invokes old planner or overwrites new snapshot',async()=>{
 let newer;
 const x=setup({delta:30000,context:({stats})=>{if(stats.context===1)newer=x.ctrl.run(args('cycle-2'));return{evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sources()};}});
 const old=await x.ctrl.run(args());assert.equal(old.status,'cancelled');
 const result=await newer;assert.equal(result.status,'converged');assert.equal(x.stats.plan,1);assert.equal(x.ctrl.snapshot().cycle,'cycle-2');
});
test('invalid nested run preserves the valid currently running cycle',async()=>{
 let nested;
 const x=setup({delta:30000,context:()=>{nested=x.ctrl.run({});return{evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sources()};}});
 assert.equal((await x.ctrl.run(args())).status,'converged');assert.equal((await nested).status,'invalid_input');assert.equal(x.stats.plan,1);
});
test('reused nested run preserves the valid currently running cycle',async()=>{
 let nested;
 const x=setup({delta:30000,context:()=>{nested=x.ctrl.run(args());return{evaluatedAt:clock,maxExchangeAgeMs:60000,sources:sources()};}});
 assert.equal((await x.ctrl.run(args())).status,'converged');assert.equal((await nested).status,'cycle_reused');assert.equal(x.stats.plan,1);
});
test('cancellation during a context property getter still prevents planner',async()=>{
 const x=setup({delta:30000,context:()=>({get evaluatedAt(){x.ctrl.cancel();return clock;},maxExchangeAgeMs:60000,sources:sources()})});
 assert.equal((await x.ctrl.run(args())).status,'cancelled');assert.equal(x.stats.plan,0);assert.equal(x.ctrl.snapshot(),null);
});



