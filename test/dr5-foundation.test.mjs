import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfflineAudioContext} from 'node-web-audio-api';
import {createBand} from '../src/kit/band.js';
import {OpenAiCompatibleProvider} from '../src/api/provider.mjs';
import {OpenAiCompatibleDeskProvider} from '../src/desk/providers/openai-compatible.mjs';

const base={task:'compose',sections:[{track:'A',bars:2},{track:'B',bars:2}],fixedRegister:{name:'sentinel'},scoreContract:{kitVersion:{semver:'x'},sampleRate:44100},canonicalVoiceAllowlist:['lead','bass'],scoreSchemaVersion:'1.1.0',seed:23};
const request={requestFormat:'hb-composition-repair/1.0.0',basePrompt:base,completePriorRawCandidate:'PRIOR_SENTINEL',orderedValidatorDiagnostics:['DIAGNOSTIC_SENTINEL'],admittedConstraints:{seed:23}};
for(const adapter of ['api','desk']) test(`${adapter}: A/B track names and repair sentinels reach mocked transport`,async()=>{
 const original=globalThis.fetch;let body;
 globalThis.fetch=async(_url,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:'{}'}}]})};};
 const profile={baseUrl:'https://offline.invalid',apiKeyEnvVar:'HB_DR5_MOCK',model:'mock'};
 const provider=adapter==='api'?new OpenAiCompatibleProvider(profile):new OpenAiCompatibleDeskProvider(profile,{HB_DR5_MOCK:'mock'});
 const prior=process.env.HB_DR5_MOCK;process.env.HB_DR5_MOCK='mock';
 try {await provider.generate({request});const s=body.messages[0].content;assert.doesNotMatch(s,/track names only from admitted voices/);const u=JSON.parse(body.messages[1].content);assert.equal(u.completePriorRawCandidate,'PRIOR_SENTINEL');assert.deepEqual(u.orderedValidatorDiagnostics,['DIAGNOSTIC_SENTINEL']);assert.deepEqual(u.sections,base.sections);} finally {globalThis.fetch=original;if(prior===undefined)delete process.env.HB_DR5_MOCK;else process.env.HB_DR5_MOCK=prior;}
});
for(const mode of ['crossfade','tail']) for(const bpm of [72,240,400]) test(`bounded scheduler ${mode}/${bpm} prevents outgoing and final grid starts`,()=>{
 const ctx=new OfflineAudioContext(2,44100*5,44100);let now=0;const calls=[];
 const band=createBand({ctx,nowFn:()=>now,retireMode:mode,retireHold:1,disconnectRetired:false});
 for(const [name,tempo] of [['A',bpm],['B',150]])band.registerTrack(name,{bpm:tempo,len:16,step(i,t){calls.push({name,i,t});}});
 const end=240/bpm;band.setTrack('A',{until:end,fadeIn:0});while(now<end){band.tick();now=Math.min(end,now+.05);}band.tick();
 assert.equal(calls.filter(e=>e.name==='A').length,16);assert.ok(calls.every(e=>e.t<end));
 band.setTrack('B',{until:end+1.6,fadeIn:0});now=end+1.6;band.tick();assert.ok(calls.filter(e=>e.name==='B').every(e=>e.t<end+1.6));band.setTrack(null);band.dispose();
});
test('explicit repeated track sections restart their local clock',()=>{
 const ctx=new OfflineAudioContext(2,44100*5,44100);let now=0;const events=[];const b=createBand({ctx,nowFn:()=>now});b.registerTrack('A',{bpm:120,len:16,step(i,t){events.push({i,t});}});b.setTrack('A',{until:2});now=2;b.setTrack('A',{restart:true,until:4});assert.ok(events.some(e=>e.i===0&&e.t>=2));b.dispose();
});
