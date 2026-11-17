import {test} from 'node:test';import assert from 'node:assert/strict';
import * as current from '../src/render.mjs';import * as modern from '../src/spec.mjs';import {KIT_VERSION} from '../src/version.mjs';
import * as old from '../history/pre-dr5/src/render.mjs';import * as legacy from '../history/pre-dr5/src/spec.mjs';
const oldMode=process.env.DR5_USE_OLD_RENDERER==='1';
const kit=oldMode?{semver:'1.9.0',sha:'4e27575dc63f5b01a7c5392a28d47ffeeec217b931755618dd7b51dd970c6417'}:KIT_VERSION;
const validate=oldMode?legacy.validateSpec:modern.validateSpec;
const render=oldMode?old.renderSpec:current.renderSpec;
// Kit 1.12.0: these probes measure the DRY boundary, so the bright-voice dark tail (a reverb on the bell) is off.
function score(bpm,mode){return {...(oldMode?{}:{brightVoice:'off'}),schemaVersion:'1.1.0',kitVersion:kit,seed:17,sampleRate:44100,tempo:bpm,gain:.5,register:{name:'boundary-probe',briefRef:'docs/DR5.md'},retire:{mode,hold:1.5},tracks:{A:{len:16,steps:[{i:0,voice:'bell',note:'C5',dur:.02,opts:{vol:.2,a:.001,r:.01,verb:0,ratios:[1],levels:[1]}}]},B:{bpm:180,len:16,steps:[]}},sections:[{track:'A',bars:1,fadeIn:0},{track:'B',bars:1,fadeIn:0}]};}
function energy(b,from,to){const x=b.getChannelData(0);let sum=0,n=0;for(let i=Math.round(from*44100);i<Math.min(x.length,Math.round(to*44100));i++){sum+=x[i]*x[i];n++;}return Math.sqrt(sum/Math.max(1,n));}
for(const bpm of [72,240,400])for(const mode of ['crossfade','tail'])test(`PCM ${bpm}/${mode}: no old downbeat after boundary or final stop`,async()=>{
 const s=score(bpm,mode),end=240/bpm;const b=await render(validate(s),{tailSeconds:2});assert.ok(energy(b,end+.031,end+.065)<1e-7,'outgoing C5 absent at incoming boundary');
 s.sections=s.sections.slice(0,1);const final=await render(validate(s),{tailSeconds:2});assert.ok(energy(final,end+.031,end+.065)<1e-7,'final track cannot restart in render tail');
});
test('PCM: incoming downbeat is present and an intentional fade stays effective',async()=>{
 const s=score(120,'tail');s.tracks.B.steps=[{i:0,voice:'lead',note:'G4',dur:.6,opts:{a:.005,d:.01,s:1,r:.1,vol:.2,verb:0,vibrato:0}}];
 const direct=await render(validate(s));s.sections[1].fadeIn=.8;const faded=await render(validate(s));assert.ok(energy(direct,2.04,2.1)>.001);assert.ok(energy(faded,2.04,2.1)<energy(direct,2.04,2.1)*.4);
});
test('PCM: legitimate final note release and authored performance release survive',async()=>{
 const s=score(120,'tail');s.sections=s.sections.slice(0,1);s.tracks.A.steps=[{i:15,voice:'pad',note:'C4',dur:.3,opts:{vol:.15,a:.01,d:.02,s:.8,r:.2,sub:false,verb:0}}];s.performance={releaseTail:3};const b=await render(validate(s));assert.ok(energy(b,2.2,2.4)>.0001);assert.ok(b.length/44100>5);assert.ok(energy(b,b.length/44100-.02,b.length/44100)<1e-7);
});
