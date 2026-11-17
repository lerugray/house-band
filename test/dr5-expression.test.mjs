import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfflineAudioContext} from 'node-web-audio-api';
import {createBand} from '../src/kit/band.js';
import {KIT_VERSION,PHRASE_SCHEMA_VERSION} from '../src/version.mjs';
import {validateSpec,compileTrackStep,shippingStatus} from '../src/spec.mjs';
import {renderSpec,renderSpecToWav} from '../src/render.mjs';

export function fixture() {return {schemaVersion:PHRASE_SCHEMA_VERSION,kitVersion:KIT_VERSION,seed:127,sampleRate:44100,tempo:120,gain:.5,register:{name:'dr5-probe',briefRef:'docs/DR5.md'},tracks:{A:{len:16,steps:[{every:4,voice:'pluck',note:'C4',dur:.15,opts:{vol:.12,cut:500,wave:'sawtooth',verb:0}}]}},sections:[{track:'A',bars:1,fadeIn:0},{track:'A',bars:1,fadeIn:0}]};}
const rms=(x,a=0,b=x.length)=>Math.sqrt(x.slice(a,b).reduce((s,v)=>s+v*v,0)/Math.max(1,b-a));
const hpRatio=x=>{let d=0,e=0;for(let i=1;i<x.length;i++){d+=(x[i]-x[i-1])**2;e+=x[i]**2;}return d/e;};
test('strict bounds, old-schema rejection, unknown fields and unsupported voices',()=>{
 for(const alter of [s=>s.sections[0].shape={gain:[1,NaN]},s=>s.sections[0].shape={gain:[1,1,1]},s=>s.sections[0].shape={typo:[1,1]},s=>s.tracks.A.steps[0].accent=1.1,s=>s.mix={voices:{pluck:{pan:1.1}}},s=>s.mix={width:.61},s=>s.sections[0].dropouts=[{from:.1,to:.5,voices:['pluck']}],s=>{s.schemaVersion='1.1.0';s.sections[0].mute=['pluck'];},s=>{s.tracks.A.steps=[{i:0,voice:'bell',note:'C4',dur:.2,accent:.3}];}]){const s=fixture();alter(s);assert.throws(()=>validateSpec(s));}
});
test('shape interpolates per onset, mute/dropout suppress starts and repeat resets',async()=>{
 const s=fixture();s.sections[0].shape={gain:[.5,1.5],bright:[.5,1.5]};s.sections[0].dropouts=[{from:.25,to:.5,voices:['pluck']}];s.sections.push({track:'A',bars:1,fadeIn:0,mute:['pluck']});
 const events=[];await renderSpec(validateSpec(s),{onEvent:e=>events.push(e)});
 assert.deepEqual(events.filter(e=>e.sectionIndex===0).map(e=>e.absoluteStep),[0,8,12]);
 assert.equal(events[0].options.vol,.06);assert.equal(events[0].options.cut,250);
 assert.equal(events[2].options.vol,.15);assert.equal(events[2].options.cut,625);
 const reset=events.find(e=>e.sectionIndex===1);assert.equal(reset.absoluteStep,0);assert.equal(reset.options.vol,.12);assert.equal(reset.options.cut,500);assert.equal(events.filter(e=>e.sectionIndex===2).length,0);
});
test('performed schedule includes nudge precedence and resolved per-voice humanize',async()=>{
 const s=fixture();s.performance={humanize:{timingMs:[8,8],velocity:[.1,.1]},voices:{pluck:{humanize:{timingMs:[3,3],velocity:[.2,.2]}}}};s.tracks.A.steps[0].nudge=20;s.tracks.A.steps[0].opts.nudge=-5;
 const events=[];await renderSpec(validateSpec(s),{onEvent:e=>events.push(e)});assert.ok(Math.abs(events[0].time-.028)<1e-9);assert.equal(events[0].options.vol,.144);
});
test('accent has a level-matched tonal difference, plus a level increase',async()=>{
 const s=fixture();s.tracks.A.steps=s.tracks.A.steps.slice(0,1);s.tracks.A.steps[0].i=0;delete s.tracks.A.steps[0].every;s.sections=s.sections.slice(0,1);
 // Snapshot native channel views before starting another OfflineAudioContext.
 const plain=(await renderSpec(validateSpec(s))).getChannelData(0).slice();s.tracks.A.steps[0].accent=1;const hard=(await renderSpec(validateSpec(s))).getChannelData(0).slice();
 const levelRatio=rms(hard)/rms(plain), tonalRatio=hpRatio(hard)/hpRatio(plain);
 assert.ok(levelRatio>1.2,`accent level ratio ${levelRatio} must exceed 1.2`);assert.ok(tonalRatio>1.25,`normalized spectral first-difference ratio ${tonalRatio} must exceed 1.25`);
 const ratio=rms(plain)/rms(hard);let diff=0;for(let i=0;i<plain.length;i++)diff+=(plain[i]-hard[i]*ratio)**2;assert.ok(Math.sqrt(diff/plain.length)>rms(plain)*.1,'equal-RMS waveforms differ');
});
test('pan, width and room create stereo safely, silence stays exact, repeat hashes match',async()=>{
 const s=fixture();s.mix={room:.7,voices:{pluck:{pan:-.35,width:.5}}};s.tracks.A.steps[0].opts.verb=.6;
 const a=await renderSpecToWav(validateSpec(s)),b=await renderSpecToWav(validateSpec(s));assert.equal(a.manifest.output.sha256,b.manifest.output.sha256);
 const buf=await renderSpec(validateSpec(s));const l=buf.getChannelData(0),r=buf.getChannelData(1);let side=0,mid=0,power=0,peak=0;for(let i=0;i<l.length;i++){side+=(l[i]-r[i])**2;mid+=((l[i]+r[i])/2)**2;power+=(l[i]**2+r[i]**2)/2;peak=Math.max(peak,Math.abs(l[i]),Math.abs(r[i]));}assert.ok(side/power>.02);assert.ok(mid/power>.5);assert.ok(peak<.98);
 s.sections.forEach(sec=>sec.mute=['pluck']);const silent=await renderSpec(validateSpec(s));assert.ok(silent.getChannelData(0).every(v=>v===0));assert.ok(silent.getChannelData(1).every(v=>v===0));
});
for(const mode of ['crossfade','tail'])test(`live ${mode}: cancel already queued FUTURE dry/wet events, keep earlier tails`,async()=>{
 async function render(future){const ctx=new OfflineAudioContext(2,44100*4,44100);let now=0;const band=createBand({ctx,nowFn:()=>now,retireMode:mode,retireHold:2,disconnectRetired:false});band.registerTrack('A',{bpm:240,len:16,step(i,t,s){if(i===0||(future&&i===2))s.v.bell(t,440,.4,{vol:.12,r:1.2,verb:.8});}});band.setTrack('A',{fadeIn:0});now=.1;band.setTrack(null);const b=await ctx.startRendering();band.dispose();return b.getChannelData(0);}
 const clean=await render(false),cancelled=await render(true);assert.deepEqual(cancelled,clean);assert.ok(rms(clean,4410,6000)>0,'earlier note tail survives');
});
test('positive performed nudge beyond final boundary is not admitted',async()=>{
 const s=fixture();s.tempo=400;s.tracks.A.steps=[{i:15,voice:'pluck',note:'C4',dur:.2,nudge:50}];s.sections=s.sections.slice(0,1);const events=[];await renderSpec(validateSpec(s),{onEvent:e=>events.push(e)});assert.equal(events.length,0);
});
test('room changes wet-tail energy without raising dry-note level',async()=>{
 const s=fixture();s.tracks.A.steps=[{i:0,voice:'pluck',note:'C4',dur:.06,opts:{vol:.1,cut:1800,r:.03,verb:.7}}];s.sections=s.sections.slice(0,1);
 s.mix={room:0};const a=(await renderSpec(validateSpec(s))).getChannelData(0);s.mix={room:1};const b=(await renderSpec(validateSpec(s))).getChannelData(0);assert.ok(rms(b,20000,35000)>rms(a,20000,35000)*2,'room return must be audible in the tail');
});
test('width alone produces side energy and shape gain produces a measured arc',async()=>{
 const s=fixture();s.sections=s.sections.slice(0,1);s.mix={width:.6};const spatial=await renderSpec(validateSpec(s));let side=0;for(let i=0;i<spatial.length;i++)side+=(spatial.getChannelData(0)[i]-spatial.getChannelData(1)[i])**2;assert.ok(side>1e-5,'width cannot be a dead control');
 delete s.mix;s.tracks.A.steps[0].opts.vol=.01;s.sections[0].shape={gain:[.5,1.5]};const x=(await renderSpec(validateSpec(s))).getChannelData(0);const a=rms(x,Math.round(.04*44100),Math.round(.2*44100)),b=rms(x,Math.round(1.54*44100),Math.round(1.7*44100));assert.ok(b/a>2&&b/a<3.1);
});
