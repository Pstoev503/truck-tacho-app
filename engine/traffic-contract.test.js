import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateTrafficExchange as validate} from './traffic-contract.js';
const doc=readFileSync(new URL('../docs/traffic-intelligence/SCENARIOS-v0.1.md',import.meta.url),'utf8');
const blocks=[...doc.matchAll(/```json\s*([\s\S]*?)\s*```/g)].map(m=>JSON.parse(m[1]));
const pair=(i=0)=>[structuredClone(blocks[i*2]),structuredClone(blocks[i*2+1])];
const run=(change,i=0,options)=>{const [a,b]=pair(i);change(a,b);return validate(a,b,options)};
const error=(result,code)=>assert.ok(result.errors.some(x=>x.code===code),JSON.stringify(result));
for(let i=0;i<6;i++)test('synthetic complete pair '+(i+1),()=>{const [a,b]=pair(i);assert.deepEqual(validate(a,b).errors,[]);});
test('15 JSON blocks including 3 fragments',()=>assert.equal(blocks.length,15));
test('fragments are not full responses',()=>{const [a]=pair();for(let i=12;i<15;i++)assert.equal(validate(a,blocks[i]).valid,false)});
test('input immutable',()=>{const [a,b]=pair(),before=JSON.stringify([a,b]);validate(a,b);assert.equal(JSON.stringify([a,b]),before)});
test('null input does not throw',()=>assert.equal(validate(null,null).valid,false));
const negatives=[
['version','VERSION',(a,b)=>{a.contractVersion='x'}],
['echo','ECHO',(a,b)=>{b.requestId='old'}],
['attempt','ATTEMPT',(a,b)=>{a.attempt=4;b.attempt=4}],
['duplicate ref','DUPLICATE_REF',(a,b)=>{a.segments.push({...a.segments[0],sequence:1});b.segments.push({...b.segments[0],sequence:1})}],
['negative seconds','DURATION',(a,b)=>{b.segments[0].selected.durationSeconds=-1}],
['NaN seconds','DURATION',(a,b)=>{b.segments[0].selected.durationSeconds=NaN}],
['unit mismatch','UNIT',(a,b)=>{b.segments[0].selected.unit='minutes'}],
['bad UTC','UTC',(a,b)=>{a.departureAt='2026-10-19T08:00:00+03:00'}],
['open unproven','OPEN_UNPROVEN',(a,b)=>{b.segments[0].passability='open'}],
['closed with ETA','CLOSED_ETA',(a,b)=>{b.segments[0].passability='closed'}],
['constraint enum','ENUM',(a,b)=>{b.segments[0].incidents=[structuredClone(blocks[7].segments[0].incidents[0])];b.segments[0].incidents[0].effectKind='constraint'}],
['unknown status','ENUM',(a,b)=>{b.segments[0].status='live'}],
['bad candidate ref','SELECTED_REF',(a,b)=>{b.segments[0].selected.candidateRef='missing'}],
['unknown event ref','EVENT_REF',(a,b)=>{b.segments[0].selected.appliedEventRefs=['missing']}],
['missing source','SOURCE',(a,b)=>{b.segments[0].selected.source=null}],
['bad segment order','ORDER',(a,b)=>{a.segments[0].sequence=1}],
];
for(const [name,code,fn] of negatives)test(name,()=>error(run(fn),code));
test('stale request same route but new input',()=>{const [a,b]=pair();error(validate(a,b,{activeRequest:{...a,inputRevision:'next'}}),'STALE_REQUEST')});
test('null closed duration is not zero',()=>{const [a,b]=pair(3);assert.equal(b.segments[0].selected.durationSeconds,null);assert.equal(validate(a,b).valid,true)});
test('unknown truck applicability not promoted to covered',()=>{const [a,b]=pair(5);assert.equal(b.segments[0].vehicleApplicability,'not_covered');assert.equal(validate(a,b).valid,true)});
test('stale status is not auto fresh',()=>{const [a,b]=pair(2);assert.equal(b.segments[0].measured.status,'stale');assert.equal(b.segments[0].selected.kind,'historical');assert.equal(validate(a,b).valid,true)});
function wrapped(index){const [a,b]=pair();const frag=structuredClone(blocks[index]),s=b.segments[0];s.incidents=frag.incidents;s.provenance=frag.provenance;s.selected={...s.selected,...frag.selected,unit:'seconds'};s.measured={...s.measured,...frag.measured,unit:'seconds'};return [a,b];}
test('replacement full wrapper',()=>{const [a,b]=wrapped(12);assert.equal(validate(a,b).valid,true,JSON.stringify(validate(a,b).errors))});
test('independent adjustment full wrapper',()=>{const [a,b]=wrapped(13);assert.equal(validate(a,b).valid,true,JSON.stringify(validate(a,b).errors))});
test('blocked adjustment full wrapper',()=>{const [a,b]=wrapped(14);assert.equal(validate(a,b).valid,true,JSON.stringify(validate(a,b).errors))});
test('replacement missing incident lineage',()=>{const [a,b]=wrapped(12);b.segments[0].provenance=[];error(validate(a,b),'EVENT_LINEAGE')});
test('adjustment missing evidence',()=>{const [a,b]=wrapped(13);b.segments[0].provenance=b.segments[0].provenance.filter(v=>!v.independenceEvidenceRef);error(validate(a,b),'EVIDENCE')});
test('adjustment double count',()=>{const [a,b]=wrapped(13);b.segments[0].incidents[0].alreadyIncludedIn=['measured:s1'];error(validate(a,b),'DOUBLE_COUNT')});

test('derived ghost is not a candidate reference',()=>error(run((a,b)=>{b.segments[0].selected.candidateRef='derived:ghost'}),'SELECTED_REF'));
test('count-only cannot be measured travel-time',()=>error(run((a,b)=>{b.segments[0].measured.kind='count';b.segments[0].selected.kind='count'}),'COUNT_ONLY'));
test('selected candidate expired at expectedEntryAt',()=>error(run((a,b)=>{b.segments[0].measured.validTo='2026-10-19T08:29:00Z'}),'SELECTED_OUTSIDE_WINDOW'));
test('selected stale measured cannot claim fresh',()=>error(run((a,b)=>{b.segments[0].measured.status='stale';b.segments[0].selected.status='fresh'}),'STALE_SELECTED_FRESH'));
test('selected positive duration without candidate',()=>error(run((a,b)=>{const s=b.segments[0];for(const k of ['routingBase','measured','historical','forecast'])s[k]=null;s.selected.candidateRef=null}),'SELECTED_REF'));
test('invalid direction rejected',()=>error(run((a,b)=>{a.segments[0].direction='sideways'}),'ENUM'));
test('malformed alreadyIncludedIn is structured error',()=>{const [a,b]=wrapped(13);b.segments[0].incidents[0].alreadyIncludedIn={};assert.doesNotThrow(()=>validate(a,b));error(validate(a,b),'INCLUDED_ARRAY')});
test('geometry null permitted by contract',()=>{const [a,b]=pair();a.segments[0].geometry=null;assert.equal(validate(a,b).valid,true)});
