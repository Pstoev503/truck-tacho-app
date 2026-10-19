import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validateTrafficExchangeWithSourceHealth as gate} from './traffic-source-gate.js';
import {createTrafficCycle} from './traffic-cycle.js';
const examples=[...readFileSync(fileURLToPath(new URL('../docs/traffic-intelligence/SCENARIOS-v0.1.md',import.meta.url)),'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)].map(m=>JSON.parse(m[1]));
const clone=x=>structuredClone(x);
const at=Date.parse('2026-10-19T08:28:00Z');
const relative=ms=>at-100000+ms;
const healthy=(sourceId,licenseRef='synthetic-only',extra={})=>({sourceId,licenseRef,expectedIntervalMs:10000,maxAgeMs:50000,lastSuccessAt:relative(99000),lastAttemptAt:relative(99000),consecutiveFailures:0,permissionState:'declared-allowed',...extra});
const fixture=(index=1)=>{
 const request=clone(examples[(index-1)*2]),response=clone(examples[(index-1)*2+1]);
 const cited=new Set();
 const collect=s=>{if(s?.sourceId)cited.add(s.sourceId)};
 for(const s of response.segments){
  for(const key of ['routingBase','measured','historical','forecast'])collect(s[key]?.source);
  for(const event of s.incidents??[])collect(event?.source);
  collect(s.selected?.source);
  for(const item of s.provenance??[])collect(item);
 }
 const sources=[...cited].map(id=>healthy(id));
 return {request,response,options:{activeRequest:request,evaluatedAt:Date.parse(response.evaluatedAt),maxExchangeAgeMs:60000,sources}};
};
const check=(change,index=1)=>{const x=fixture(index);change?.(x);return gate(x.request,x.response,x.options)};
test('complete accepted exchange and healthy citations valid',()=>{const x=check();assert.equal(x.valid,true,JSON.stringify(x.errors));assert.ok(x.sourceIds.includes('synthetic-live'))});
test('all source diagnostics have stable paths',()=>{const x=check();assert.ok(x.sourceDiagnostics.every(d=>d.path.startsWith('response.segments[0]')));assert.equal(x.sourceDiagnostics.some(d=>d.reason),false)});
test('missing provider blocks',()=>{const x=check(v=>v.options.sources=v.options.sources.filter(s=>s.sourceId!=='synthetic-live'));assert.equal(x.valid,false);assert.ok(x.errors.some(e=>e.code==='SOURCE_HEALTH_MISSING_PROVIDER'))});
test('denied provider blocks',()=>assert.equal(check(v=>v.options.sources[0].permissionState='denied').valid,false));
test('unknown permission blocks',()=>assert.equal(check(v=>v.options.sources[0].permissionState='unknown').valid,false));
test('stale provider blocks',()=>assert.equal(check(v=>{v.options.sources[0].lastSuccessAt=relative(49000);v.options.sources[0].lastAttemptAt=relative(49000)}).valid,false));
test('no-data provider blocks',()=>assert.equal(check(v=>{v.options.sources[0].lastSuccessAt=null;v.options.sources[0].lastAttemptAt=null}).valid,false));
test('duplicate provider IDs block',()=>{const x=check(v=>v.options.sources.push(clone(v.options.sources[0])));assert.ok(x.errors.some(e=>e.code==='SOURCE_HEALTH_DUPLICATE_PROVIDER'))});
test('invalid provider configuration blocks',()=>assert.equal(check(v=>v.options.sources[0].maxAgeMs=0).valid,false));
test('missing licenseRef blocks',()=>assert.equal(check(v=>v.options.sources[0].licenseRef=null).valid,false));
test('license mismatch blocks with citation path',()=>{const x=check(v=>v.options.sources[0].licenseRef='different');assert.ok(x.errors.some(e=>e.code==='SOURCE_HEALTH_LICENSE_MISMATCH'&&e.path.startsWith('response.segments[0]')))});
test('exact maxAge blocks',()=>assert.equal(check(v=>{v.options.sources[0].lastSuccessAt=relative(50000);v.options.sources[0].lastAttemptAt=relative(50000)}).valid,false));
test('maxAge minus 1 remains eligible',()=>{const x=check(v=>{v.options.sources[0].lastSuccessAt=relative(50001);v.options.sources[0].lastAttemptAt=relative(50001)});assert.equal(x.valid,true,JSON.stringify(x.errors))});
test('fresh failures warning remains technically eligible',()=>{const x=check(v=>{v.options.sources[0].consecutiveFailures=2;v.options.sources[0].lastAttemptAt=null});assert.equal(x.valid,true,JSON.stringify(x.errors));assert.equal(x.sourceHealth.status,'degraded')});
test('fresh late update warning remains technically eligible',()=>{const x=check(v=>{v.options.sources[0].expectedIntervalMs=1000});assert.equal(x.valid,true,JSON.stringify(x.errors));assert.ok(x.sourceHealth.sources[0].warnings.includes('LATE_UPDATE'))});
test('unreferenced invalid provider does not block',()=>{const x=check(v=>v.options.sources.push(healthy('unreferenced','synthetic-only',{maxAgeMs:0})));assert.equal(x.valid,true,JSON.stringify(x.errors));assert.equal(x.sourceHealth.status,'degraded')});
test('candidate source citation audited',()=>{const x=check(v=>v.options.sources=v.options.sources.filter(s=>s.sourceId!=='routing-engine'));assert.ok(x.errors.some(e=>e.path.endsWith('.routingBase.source')))});
test('selected source citation audited',()=>{const x=check(v=>v.options.sources=v.options.sources.filter(s=>s.sourceId!=='synthetic-live'));assert.ok(x.errors.some(e=>e.path.endsWith('.selected.source')))});
test('provenance citation audited',()=>{const x=check(v=>{v.response.segments[0].provenance.push({...v.response.segments[0].provenance[0],sourceId:'provenance-only'})});assert.ok(x.errors.some(e=>e.path.endsWith('.provenance[1]')))});
test('event citation audited using full accepted exchange',()=>{const x=fixture(4);const result=gate(x.request,x.response,x.options);assert.ok(result.sourceDiagnostics.some(d=>d.path.includes('.incidents[')),JSON.stringify(result.sourceDiagnostics))});
test('independence evidence provenance citation audited',()=>{const x=fixture(6);const result=gate(x.request,x.response,x.options);assert.ok(result.sourceDiagnostics.some(d=>d.path.includes('.provenance[')),JSON.stringify(result.sourceDiagnostics))});
test('malformed exchange never rescued by healthy provider',()=>{const x=check(v=>v.response.contractVersion='bad');assert.equal(x.valid,false);assert.ok(x.errors.some(e=>e.code==='VERSION'))});
test('echo mismatch never rescued',()=>{const x=check(v=>v.response.requestId='wrong');assert.equal(x.valid,false);assert.ok(x.errors.some(e=>e.code==='ECHO'))});
test('malformed options return structured health error',()=>{const x=fixture();const r=gate(x.request,x.response,null);assert.equal(r.valid,false);assert.equal(r.sourceHealth.status,'invalid-input')});
test('invalid health evaluatedAt returns structured error',()=>{const x=check(v=>v.options.evaluatedAt='bad-clock');assert.equal(x.valid,false);assert.ok(x.errors.some(e=>e.code==='SOURCE_HEALTH_INVALID_INPUT'))});
test('frozen request response and health input untouched',()=>{const x=fixture();const before=clone(x);Object.freeze(x.request);Object.freeze(x.response);Object.freeze(x.options);Object.freeze(x.options.sources);const result=gate(x.request,x.response,x.options);assert.equal(result.valid,true,JSON.stringify(result.errors));assert.deepEqual(x,before)});
test('no ambient clock',()=>{const now=Date.now;Date.now=()=>{throw Error('ambient')};try{assert.equal(check().valid,true)}finally{Date.now=now}});
test('stable citation order',()=>{const a=check().sourceDiagnostics.map(x=>x.path),b=check().sourceDiagnostics.map(x=>x.path);assert.deepEqual(a,b)});
test('partial bad provider still visible in health diagnostics',()=>{const x=check(v=>v.options.sources.push(healthy('unused','synthetic-only',{permissionState:'denied'})));assert.equal(x.valid,true);assert.equal(x.sourceHealth.status,'degraded');assert.ok(x.sourceHealth.sources.some(s=>s.sourceId==='unused'&&!s.usableForEvaluation))});
const cycleFixture=blocked=>{
 const x=fixture(1);
 const planCalls={count:0};
 const initialPlan={etaMs:1000000,passability:['open'],segments:clone(x.request.segments)};
 const ctrl=createTrafficCycle({
  createRequest:async ({cycle,routeRevision,attempt,inputRevision,requestId,plan})=>({...clone(x.request),evaluationCycle:cycle,routeRevision,attempt,inputRevision,requestId,segments:clone(plan.segments)}),
  evaluate:async request=>{const response=clone(x.response);for(const key of ['requestId','routeRevision','evaluationCycle','inputRevision','attempt'])response[key]=request[key];response.segments.forEach((s,i)=>{s.expectedEntryAt=request.segments[i].expectedEntryAt;s.passability='open';s.provenance.push({...s.selected.source,kind:'passability_open',direction:request.segments[i].direction,vehicleProfileRef:request.vehicleProfileRef,validFrom:'2026-10-19T08:00:00Z',validTo:'2026-10-19T10:00:00Z'});});return response},
  plan:async ({previousPlan})=>{planCalls.count++;return {...clone(previousPlan),etaMs:previousPlan.etaMs+120000}},
  validate:(request,response,opts)=>gate(request,response,{...opts,evaluatedAt:x.options.evaluatedAt,maxExchangeAgeMs:x.options.maxExchangeAgeMs,sources:blocked?x.options.sources.filter(s=>s.sourceId!=='synthetic-live'):x.options.sources})
 });
 return {ctrl,planCalls,args:{cycle:'cycle-gate',routeRevision:x.request.routeRevision,initialPlan,requestIds:['gate-1','gate-2','gate-3'],inputRevisions:['in-1','in-2','in-3']}};
};
test('real cycle with default contract plus health gate allows planner',async()=>{const x=cycleFixture(false);const r=await x.ctrl.run(x.args);assert.equal(r.status,'unstable_estimate',JSON.stringify(r));assert.equal(x.planCalls.count,3)});
test('real cycle source gate rejection blocks planner',async()=>{const x=cycleFixture(true);const r=await x.ctrl.run(x.args);assert.equal(r.status,'invalid_exchange');assert.equal(x.planCalls.count,0)});

const temporal=(mutate)=>{const x=fixture();mutate?.(x);return gate(x.request,x.response,x.options)};
test('exchange fresh exact zero age',()=>{const x=temporal();assert.equal(x.valid,true,JSON.stringify(x.errors));assert.equal(x.exchangeHealth.ageMs,0);assert.equal(x.exchangeHealth.state,'fresh')});
test('exchange TTL minus 1ms fresh',()=>{const x=temporal(v=>v.options.evaluatedAt=Date.parse(v.response.evaluatedAt)+59999);assert.equal(x.exchangeHealth.state,'fresh');assert.equal(x.valid,false);assert.ok(x.errors.some(e=>e.code.startsWith('SOURCE_HEALTH_')))});
test('exchange TTL exact boundary stale',()=>{const x=temporal(v=>v.options.evaluatedAt=Date.parse(v.response.evaluatedAt)+60000);assert.equal(x.exchangeHealth.state,'stale');assert.ok(x.errors.some(e=>e.code==='EXCHANGE_STALE_RESPONSE'))});
test('exchange TTL plus 1ms stale',()=>{const x=temporal(v=>v.options.evaluatedAt=Date.parse(v.response.evaluatedAt)+60001);assert.equal(x.exchangeHealth.state,'stale')});
test('exchange future by 1ms blocked',()=>{const x=temporal(v=>v.options.evaluatedAt=Date.parse(v.response.evaluatedAt)-1);assert.equal(x.exchangeHealth.state,'future');assert.ok(x.errors.some(e=>e.code==='EXCHANGE_FUTURE_RESPONSE'))});
test('exchange before unix epoch blocked',()=>{const x=temporal(v=>v.response.evaluatedAt='1969-12-31T23:59:59Z');assert.equal(x.exchangeHealth.state,'invalid-input');assert.ok(x.errors.some(e=>e.code==='EXCHANGE_INVALID_RESPONSE_TIME'))});
test('malformed UTC response keeps contract errors',()=>{const x=temporal(v=>v.response.evaluatedAt='not-utc');assert.equal(x.valid,false);assert.ok(x.errors.some(e=>e.code==='UTC'));assert.ok(x.errors.some(e=>e.code==='EXCHANGE_INVALID_RESPONSE_TIME'))});
test('missing explicit exchange max age blocked',()=>{const x=temporal(v=>delete v.options.maxExchangeAgeMs);assert.equal(x.exchangeHealth.state,'invalid-input');assert.ok(x.errors.some(e=>e.code==='EXCHANGE_INVALID_MAX_AGE'))});
for(const value of [null,'60000',0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])test('bad exchange maxAge '+String(value)+' rejected',()=>{const x=temporal(v=>v.options.maxExchangeAgeMs=value);assert.equal(x.exchangeHealth.state,'invalid-input');assert.equal(x.valid,false)});
test('caller clock mismatch future is blocked',()=>{const x=temporal(v=>v.options.evaluatedAt=100000);assert.equal(x.exchangeHealth.state,'future')});
test('future departure is not future response',()=>{const x=temporal(v=>{v.request.departureAt='2026-10-20T08:00:00Z'});assert.equal(x.exchangeHealth.state,'fresh');assert.equal(x.valid,true,JSON.stringify(x.errors))});
test('stale source blocks even when exchange fresh',()=>{const x=temporal(v=>{v.options.sources[0].lastSuccessAt=v.options.evaluatedAt-50000;v.options.sources[0].lastAttemptAt=v.options.evaluatedAt-50000});assert.equal(x.exchangeHealth.state,'fresh');assert.equal(x.valid,false)});
test('old exchange blocked even when providers fresh',()=>{const x=temporal(v=>{v.options.maxExchangeAgeMs=1;v.options.evaluatedAt=Date.parse(v.response.evaluatedAt)+1;v.options.sources.forEach(s=>{s.lastSuccessAt=v.options.evaluatedAt;s.lastAttemptAt=v.options.evaluatedAt})});assert.equal(x.sourceHealth.status,'usable');assert.equal(x.exchangeHealth.state,'stale');assert.equal(x.valid,false)});
test('source failure and stale exchange preserve both errors',()=>{const x=temporal(v=>{v.options.maxExchangeAgeMs=1;v.options.evaluatedAt=Date.parse(v.response.evaluatedAt)+1;v.options.sources[0].permissionState='denied'});assert.ok(x.errors.some(e=>e.code==='EXCHANGE_STALE_RESPONSE'));assert.ok(x.errors.some(e=>e.code==='SOURCE_HEALTH_PROVIDER_NOT_USABLE'))});
test('deep frozen envelope response and providers',()=>{const x=fixture();const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v)}return v};freeze(x);const r=gate(x.request,x.response,x.options);assert.equal(r.valid,true,JSON.stringify(r.errors))});
test('temporal gate uses no ambient clock',()=>{const old=Date.now;Date.now=()=>{throw Error('ambient')};try{assert.equal(temporal().valid,true)}finally{Date.now=old}});
test('negative caller clock invalid-input structured',()=>{const x=temporal(v=>v.options.evaluatedAt=-1);assert.equal(x.exchangeHealth.state,'invalid-input');assert.ok(x.errors.some(e=>e.code==='EXCHANGE_INVALID_EVALUATED_AT'))});
