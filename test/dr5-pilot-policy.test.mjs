import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {auditPilot} from '../tools/dr5/pilot-policy.mjs';
import {auditScore} from '../tools/score-audit/lib.mjs';
import { dataSkip } from './helpers/env.mjs';
const root='listen/DR5-PHRASE-PILOT-2026-10-13';
const read=p=>JSON.parse(fs.readFileSync(root+'/'+p));
function evidence(){return {score:read('source/woh-expanded.score.json'),plan:read('source/woh-phrase-plan.json'),events:read('source/04-woh-settlement-growth-dr5-pilot.performed-events.json'),audio:read('reports/audio-measurements.json').reports.find(r=>r.id.startsWith('04'))};}
test('pinned pilot policy admits only verified phrase evidence and keeps old audit intact',{skip:dataSkip('listen/DR5-PHRASE-PILOT-2026-10-13')},()=>{
 const {score,plan,events,audio}=evidence(),before=auditScore(score),r=auditPilot(score,plan,events,{audioEvidence:audio});
 assert.equal(r.pass,true);assert.deepEqual(r.oldHsmd,before);assert.deepEqual(auditScore(score),before);assert.equal(r.shippingPromotion,false);assert.equal(r.musicalAcceptance,false);
});
test('pilot policy cannot admit another cue or a changed score, plan, schedule or audio report',{skip:dataSkip('listen/DR5-PHRASE-PILOT-2026-10-13')},()=>{
 for(const mutate of [x=>x.score.audition.cueId='another-cue',x=>x.score.tracks.sowing.steps[0].note='F4',x=>x.plan.rest.fromSeconds=0,x=>x.events[0].time+=.01,x=>x.audio.raw.sha256='0'.repeat(64)]){
  const x=evidence();mutate(x);assert.throws(()=>auditPilot(x.score,x.plan,x.events,{audioEvidence:x.audio}),/bound to exactly|identity mismatch/);
 }
 const x=evidence();assert.throws(()=>auditPilot(x.score,x.plan,x.events),/audio evidence identity mismatch/);
});

// Test musical relations directly; identity rejection alone cannot prove a phrase check.
import {phraseRelations} from '../tools/dr5/phrase-checks.mjs';
const relations=x=>phraseRelations(x.score,x.plan,x.events,x.audio);
test('wind gaps include gates, envelope release and room decay before the next call',{skip:dataSkip('listen/DR5-PHRASE-PILOT-2026-10-13')},()=>{
 const x=evidence(),r=relations(x);assert.equal(r.windAnswersDuringCallVacancy,true);
 assert.ok(r.windGaps.every(g=>g.releaseEndSeconds<g.nextCallSeconds&&g.clearanceSeconds>=x.plan.windGap.minimumClearanceSeconds));
 for(const change of [w=>w.duration+=2,w=>w.options.r+=2]){
  const y=evidence();change(y.events.filter(e=>e.voice==='lead')[2]);
  assert.equal(relations(y).windAnswersDuringCallVacancy,false,'unchanged onsets must not hide an overlapping release');
 }
 const wet=evidence();wet.plan.windGap.roomTailSeconds+=1;
 assert.equal(relations(wet).windAnswersDuringCallVacancy,false,'wet tail also ends in the gap');
});
test('wind entrance must clear the previous pluck release, including holdScale',{skip:dataSkip('listen/DR5-PHRASE-PILOT-2026-10-13')},()=>{
 const x=evidence(),w=x.events.find(e=>e.voice==='lead');
 const p=x.events.filter(e=>e.voice==='pluck'&&e.time<w.time).at(-1);
 p.options.r=w.time-p.time+1;
 assert.equal(relations(x).windAnswersDuringCallVacancy,false);
});
test('documented rise requires the authored arch, performed gain and brightness, and rendered apex',{skip:dataSkip('listen/DR5-PHRASE-PILOT-2026-10-13')},()=>{
 assert.equal(relations(evidence()).documentedRise,true);
 const changes=[
  x=>{x.score.sections[2].shape.gain.fill(1);},
  x=>{x.score.sections[2].shape.bright.fill(1);},
  x=>{const es=x.events.filter(e=>e.sectionIndex===2&&e.voice==='pluck');es.forEach(e=>e.options.vol=.1);es.at(-1).options.vol=.101;},
  x=>{x.events.filter(e=>e.sectionIndex===2&&e.voice==='pluck').forEach(e=>e.options.cut=1700);},
  x=>{x.audio.barRmsDbFS.fill(-40);},
  x=>{x.audio.barRmsDbFS[0]=0;},
 ];
 for(const change of changes){const x=evidence();change(x);assert.equal(relations(x).documentedRise,false);}
});
