import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrafficCycle} from './traffic-cycle.js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const scenarioText=readFileSync(fileURLToPath(new URL('../docs/traffic-intelligence/SCENARIOS-v0.1.md',import.meta.url)),'utf8');
const fullExamples=[...scenarioText.matchAll(/```json\\n([\\s\\S]*?)\\n```/g)].slice(0,12).map(m=>JSON.parse(m[1]));
const clone=x=>structuredClone(x);
const setup=(opts={})=>{
 const requests=[],plans=[],responses=[];
 const initial={etaMs:1000000,passability:opts.initialPassability??['open'],segments:[{segmentRef:'s',expectedEntryAt:'2026-10-19T08:30:00Z'}]};
 let revision=0;
 const evaluate=async r=>{requests.push(clone(r));const x={requestId:r.requestId,routeRevision:r.routeRevision,evaluationCycle:r.evaluationCycle,inputRevision:r.inputRevision,attempt:r.attempt,segments:[{passability:'open',vehicleApplicability:'covered',selected:{durationSeconds:300,status:'fresh'}}]};opts.mutate?.(x,r);responses.push(x);return x;};
 const plan=async ({previousPlan,attempt})=>{const x={etaMs:previousPlan.etaMs+(opts.deltas?.[attempt-1]??120000),passability:['open'],segments:[{segmentRef:'s',expectedEntryAt:'2026-10-19T09:15:00Z'}]};plans.push(x);return x;};
 const createRequest=async ({cycle,routeRevision,attempt,inputRevision,requestId,plan})=>({contractVersion:'0.1',evaluationCycle:cycle,routeRevision,attempt,inputRevision,requestId,segments:clone(plan.segments)});
 const validate=opts.validate??(()=>({valid:true,errors:[]}));
 const ctrl=createTrafficCycle({evaluate:opts.evaluate??evaluate,plan:opts.plan??plan,createRequest:opts.createRequest??createRequest,validate});
 const args={cycle:'c1',routeRevision:'r1',initialPlan:initial,requestIds:['id1','id2','id3'],inputRevisions:['in1','in2','in3']};
 return {ctrl,args,requests,plans,responses};
};
test('one attempt converges at 0 seconds',async()=>{const x=setup({deltas:[0]});assert.equal((await x.ctrl.run(x.args)).attempts,1)});
test('60 seconds inclusive',async()=>{const x=setup({deltas:[60000]});assert.equal((await x.ctrl.run(x.args)).status,'converged')});
test('61 seconds does not converge',async()=>{const x=setup({deltas:[61000,0]});assert.equal((await x.ctrl.run(x.args)).attempts,2)});
test('two attempts converge',async()=>{const x=setup({deltas:[120000,0]});assert.equal((await x.ctrl.run(x.args)).attempts,2)});
test('three attempts converge',async()=>{const x=setup({deltas:[120000,120000,0]});assert.equal((await x.ctrl.run(x.args)).attempts,3)});
test('no fourth attempt',async()=>{const x=setup();assert.equal((await x.ctrl.run(x.args)).status,'unstable_estimate');assert.equal(x.requests.length,3)});
test('attempts numbered 1 to 3',async()=>{const x=setup();await x.ctrl.run(x.args);assert.deepEqual(x.requests.map(r=>r.attempt),[1,2,3])});
test('distinct request ids',async()=>{const x=setup();await x.ctrl.run(x.args);assert.deepEqual(x.requests.map(r=>r.requestId),['id1','id2','id3'])});
test('input revisions preserved',async()=>{const x=setup();await x.ctrl.run(x.args);assert.deepEqual(x.requests.map(r=>r.inputRevision),['in1','in2','in3'])});
for(const field of ['requestId','routeRevision','evaluationCycle','inputRevision','attempt'])test('stale '+field+' rejected',async()=>{const x=setup({mutate:(b)=>{b[field]='stale'}});const out=await x.ctrl.run(x.args);assert.equal(out.status,'stale_exchange');assert.equal(out.field,field)});
test('invalid validator rejects exchange',async()=>{const x=setup({validate:()=>({valid:false,errors:[{code:'X',path:'response'}]})});assert.equal((await x.ctrl.run(x.args)).status,'invalid_exchange')});
test('closed is unavailable',async()=>{const x=setup({mutate:b=>{b.segments[0].passability='closed'}});assert.equal((await x.ctrl.run(x.args)).status,'unavailable')});
test('null duration not zero',async()=>{const x=setup({mutate:b=>{b.segments[0].selected.durationSeconds=null}});assert.equal((await x.ctrl.run(x.args)).status,'unavailable')});
test('unknown passability limited',async()=>{const x=setup({mutate:b=>{b.segments[0].passability='unknown'}});assert.equal((await x.ctrl.run(x.args)).status,'limited')});
test('uncovered truck limited',async()=>{const x=setup({mutate:b=>{b.segments[0].vehicleApplicability='unknown'}});assert.equal((await x.ctrl.run(x.args)).status,'limited')});
test('planner owns expected entry including 45 minute pause',async()=>{const x=setup({deltas:[120000,0]});await x.ctrl.run(x.args);assert.equal(x.requests[1].segments[0].expectedEntryAt,'2026-10-19T09:15:00Z')});
test('milliseconds ETA and seconds traffic never summed',async()=>{const x=setup({deltas:[120000,0]});const out=await x.ctrl.run(x.args);assert.equal(out.etaMs,1120000)});
test('passability change prevents convergence',async()=>{let n=0;const x=setup({initialPassability:['unknown'],deltas:[0,0,0],mutate:b=>{b.segments[0].passability=++n===1?'open':'closed'}});const out=await x.ctrl.run(x.args);assert.equal(out.attempts,2);assert.equal(out.status,'unavailable')});
test('oscillation unstable',async()=>{const x=setup({deltas:[120000,-120000,120000]});assert.equal((await x.ctrl.run(x.args)).status,'unstable_estimate')});
test('same route new cycle resets budget',async()=>{const x=setup();await x.ctrl.run(x.args);const y=await x.ctrl.run({...x.args,cycle:'c2'});assert.equal(y.attempts,3);assert.equal(x.requests.length,6)});
test('cancel pending evaluation invalidates result',async()=>{let release;const x=setup({evaluate:()=>new Promise(r=>{release=r})});const p=x.ctrl.run(x.args);await Promise.resolve();x.ctrl.cancel();release({});assert.equal((await p).status,'cancelled')});
test('new cycle supersedes pending result',async()=>{let release;let count=0;const x=setup({evaluate:r=>++count===1?new Promise(resolve=>{release=resolve}):Promise.resolve({requestId:r.requestId,routeRevision:r.routeRevision,evaluationCycle:r.evaluationCycle,inputRevision:r.inputRevision,attempt:r.attempt,segments:[{passability:'open',vehicleApplicability:'covered',selected:{durationSeconds:300,status:'fresh'}}]})});const p=x.ctrl.run(x.args);await Promise.resolve();const newer=x.ctrl.run({...x.args,cycle:'c2'});release({});assert.equal((await p).status,'cancelled');assert.equal((await newer).status,'unstable_estimate')});
test('request inputs not mutated',async()=>{const x=setup({deltas:[0]});const before=clone(x.args);await x.ctrl.run(x.args);assert.deepEqual(x.args,before)});
test('evaluation rejection is callback error without retry',async()=>{let n=0;const x=setup({evaluate:()=>{n++;throw Error('offline')}});assert.equal((await x.ctrl.run(x.args)).status,'callback_error');assert.equal(n,1)});
test('planner rejection is callback error without retry',async()=>{const x=setup({plan:()=>{throw Error('planner')}});assert.equal((await x.ctrl.run(x.args)).status,'callback_error')});
test('duplicate request ids rejected',async()=>{const x=setup();assert.equal((await x.ctrl.run({...x.args,requestIds:['same','same','same']})).status,'invalid_input')});
test('callback dependencies required',()=>assert.throws(()=>createTrafficCycle({}),TypeError));

test('same cycle cannot consume another three attempts',async()=>{const x=setup();await x.ctrl.run(x.args);assert.equal((await x.ctrl.run(x.args)).status,'cycle_reused');assert.equal(x.requests.length,3)});
test('cancel does not reset cycle budget',async()=>{const x=setup();await x.ctrl.run(x.args);x.ctrl.cancel();assert.equal((await x.ctrl.run(x.args)).status,'cycle_reused');assert.equal(x.requests.length,3)});
for(const [name,opts,status] of [
 ['unavailable',{mutate:b=>b.segments[0].passability='closed'},'unavailable'],
 ['limited',{mutate:b=>b.segments[0].passability='unknown'},'limited'],
 ['invalid_exchange',{validate:()=>({valid:false,errors:[]})},'invalid_exchange'],
 ['callback_error',{evaluate:()=>{throw Error('offline')}},'callback_error']
])test('terminal snapshot '+name,async()=>{const x=setup(opts);assert.equal((await x.ctrl.run(x.args)).status,status);assert.equal(x.ctrl.snapshot().status,status)});

const integration=(index,{deltas=[0],open=false}={})=>{
 const originalRequest=clone(fullExamples[2*(index-1)]),originalResponse=clone(fullExamples[2*(index-1)+1]);
 const initialPlan={etaMs:1000000,passability:[open?'open':originalResponse.segments[0].passability],segments:clone(originalRequest.segments)};
 let calls=0;
 const evaluate=async request=>{
   calls++;
   const response=clone(originalResponse);
   for(const field of ['requestId','routeRevision','evaluationCycle','inputRevision','attempt'])response[field]=request[field];
   response.segments.forEach((segment,i)=>segment.expectedEntryAt=request.segments[i].expectedEntryAt);
   if(open){
     const segment=response.segments[0];segment.passability='open';
     segment.provenance.push({...segment.selected.source,kind:'passability_open',direction:request.segments[0].direction,vehicleProfileRef:request.vehicleProfileRef,validFrom:'2026-10-19T08:00:00Z',validTo:'2026-10-19T10:00:00Z'});
   }
   return response;
 };
 const createRequest=async ({cycle,routeRevision,attempt,inputRevision,requestId,plan})=>({...clone(originalRequest),evaluationCycle:cycle,routeRevision,attempt,inputRevision,requestId,segments:clone(plan.segments)});
 const plan=async ({previousPlan,attempt})=>({...clone(previousPlan),etaMs:previousPlan.etaMs+(deltas[attempt-1]??120000),passability:[open?'open':originalResponse.segments[0].passability]});
 const ctrl=createTrafficCycle({evaluate,createRequest,plan}); // default ACCEPTED validator
 const args={cycle:'cycle-real',routeRevision:originalRequest.routeRevision,initialPlan,requestIds:['real-1','real-2','real-3'],inputRevisions:['real-in-1','real-in-2','real-in-3']};
 return {ctrl,args,get calls(){return calls}};
};
test('default validator accepted complete example 1 is limited unknown',async()=>{const x=integration(1);assert.equal((await x.ctrl.run(x.args)).status,'limited');assert.equal(x.calls,1)});
test('default validator accepted complete example 4 is closed/unavailable',async()=>{const x=integration(4);assert.equal((await x.ctrl.run(x.args)).status,'unavailable');assert.equal(x.calls,1)});
test('default validator accepted complete example 5 is limited uncovered',async()=>{const x=integration(5);assert.equal((await x.ctrl.run(x.args)).status,'limited')});
test('default validator full example 1 with explicit open provenance converges',async()=>{const x=integration(1,{open:true,deltas:[60000]});const out=await x.ctrl.run(x.args);assert.equal(out.status,'converged',JSON.stringify(out));assert.equal(out.attempts,1)});
test('default validator full example 1 with explicit open provenance max three',async()=>{const x=integration(1,{open:true,deltas:[120000,120000,120000]});const out=await x.ctrl.run(x.args);assert.equal(out.status,'unstable_estimate',JSON.stringify(out));assert.equal(x.calls,3)});
