import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {OfflineAudioContext} from 'node-web-audio-api';
import {KIT_VERSION,PRE_TIMBRE_KIT_VERSION,PHRASE_SCHEMA_VERSION} from '../src/version.mjs';
import {validateSpec,shippingStatus,assertShippingPromotionAllowed} from '../src/spec.mjs';
import {auditionRebase} from '../src/audition-rebase.mjs';
import {renderSpecToWav} from '../src/render.mjs';
import {renderScoreToWav} from '../app/render.mjs';
import {HouseBandApiService} from '../src/api/service.mjs';
import {DeskService} from '../src/desk/service.mjs';
import {createAcceptedBundle} from '../app/bundle.mjs';
import {createHandoffBundle} from '../app/handoff.mjs';
import { pinnedSkip } from './helpers/env.mjs';
const source=()=>({schemaVersion:'1.1.0',kitVersion:{semver:'1.9.0',sha:'4e27575dc63f5b01a7c5392a28d47ffeeec217b931755618dd7b51dd970c6417'},seed:42,sampleRate:44100,tempo:240,gain:.5,register:{name:'dr5-test',briefRef:'docs/DR5.md'},tracks:{A:{len:16,steps:[{i:0,voice:'pluck',note:'C4',dur:.2,opts:{cut:900,vol:.12,verb:.3}}]}},sections:[{track:'A',bars:1,fadeIn:0}]});
test('audition rebase keeps source bytes, reports every migration, and blocks shipping',()=>{
 const bytes=Buffer.from(JSON.stringify(source())),snapshot=Buffer.from(bytes);const {score,identity}=auditionRebase(bytes,{mix:{room:.3}});assert.deepEqual(bytes,snapshot);assert.ok(identity.symbolicIdentityPreserved);assert.deepEqual(identity.migration.map(x=>x.path),['/kitVersion','/audition','/mix']);assert.equal(shippingStatus(score).shippable,false);assert.throws(()=>assertShippingPromotionAllowed(score),/shipping promotion blocked/);
});
test('Node and browser OFFLINE routes render identical DR5 expression/spatial bytes and non-shipping status',async()=>{
 globalThis.OfflineAudioContext=OfflineAudioContext;const s=source();s.schemaVersion=PHRASE_SCHEMA_VERSION;s.kitVersion=KIT_VERSION;s.audition={kind:'pilot',cueId:'dr5-test'};s.mix={room:.4,voices:{pluck:{pan:-.25,width:.3}}};s.tracks.A.steps[0].accent=.7;s.sections[0].shape={gain:[.8,1.2],bright:[.8,1.3]};const a=validateSpec(s);const node=await renderSpecToWav(a),browser=await renderScoreToWav(a);assert.deepEqual(Buffer.from(browser.wav),node.wav);assert.equal(browser.manifest.shipping.shippable,false);assert.equal(node.manifest.shipping.shippable,false);
});
test('neutral opt-ins preserve PCM and unsupported sample controls are rejected',async()=>{
 const s=source();s.kitVersion=KIT_VERSION;s.schemaVersion=PHRASE_SCHEMA_VERSION;const a=await renderSpecToWav(validateSpec(s));s.sections[0].shape={gain:[1,1],bright:[1,1]};s.tracks.A.steps[0].accent=0;s.mix={width:0,voices:{pluck:{pan:0,width:0}}};const b=await renderSpecToWav(validateSpec(s));assert.deepEqual(a.wav,b.wav);
 const sample=JSON.parse(fs.readFileSync('examples/sampler-demo-spec.json'));sample.kitVersion=PRE_TIMBRE_KIT_VERSION;sample.mix={room:.5};assert.throws(()=>validateSpec(sample),/sample voices do not support/);sample.kitVersion=KIT_VERSION;assert.doesNotThrow(()=>validateSpec(sample),'kit 1.11.0 routes bound samples through the graph, so mix is admitted');
});
test('API custody retains pilot classification through schema 1.2 render and blocks RPP export',{skip:pinnedSkip()},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hb-dr5-custody-'));try{const api=await new HouseBandApiService({storeRoot:root}).init();const s=source();s.schemaVersion=PHRASE_SCHEMA_VERSION;s.kitVersion=KIT_VERSION;s.audition={kind:'pilot',cueId:'dr5-test'};s.sections[0].shape={gain:[1,.8]};const done=await(await api.submitRender({score:s,outputs:{fullMix:true}})).completion;assert.equal(done.state,'succeeded',JSON.stringify(done.error));const meta=done.artifacts.find(a=>a.kind==='manifest');const manifest=JSON.parse((await api.getArtifact(done.jobId,meta.artifactId)).bytes);assert.equal(manifest.shipping.shippable,false);const denied=await(await api.submitRender({score:s,outputs:{fullMix:true,stems:true,rpp:true}})).completion;assert.equal(denied.state,'failed');assert.match(denied.error.message,/audition-only/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Desk export cannot promote an audition take',async()=>{
 const fake={sessionStore:{read:async()=>({takes:[{takeId:'x',score:{audition:{kind:'pilot'}}}]})}};await assert.rejects(()=>DeskService.prototype.exportBundle.call(fake,'s','x'),/audition-only/);
});
test('new-kit sample FX declarations fail instead of silently bypassing processing',()=>{
 const s=JSON.parse(fs.readFileSync('examples/sampler-demo-spec.json'));s.kitVersion=PRE_TIMBRE_KIT_VERSION;s.fx={reverb:'room'};assert.throws(()=>validateSpec(s),/sample voices do not support/);s.kitVersion=KIT_VERSION;assert.doesNotThrow(()=>validateSpec(s),'kit 1.11.0 routes bound samples through the fx chain');
 s.kitVersion={semver:'1.9.0',sha:'4e27575dc63f5b01a7c5392a28d47ffeeec217b931755618dd7b51dd970c6417'};assert.doesNotThrow(()=>validateSpec(s),'historical admission retains its original semantics');
});
test('current API custody refuses to relabel a historical score with the new renderer identity',{skip:pinnedSkip()},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hb-dr5-history-'));try{const api=await new HouseBandApiService({storeRoot:root}).init();const result=await(await api.submitRender({score:source(),outputs:{fullMix:true}})).completion;assert.equal(result.state,'failed');assert.equal(result.error.code,'TOOLCHAIN_UNAVAILABLE');assert.match(result.error.message,/historical score/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('browser accepted bundle and REAPER handoff cannot promote an audition artifact',async()=>{
 const s=source();s.kitVersion=KIT_VERSION;s.audition={kind:'pilot',cueId:'dr5-test'};const artifact=validateSpec(s);
 await assert.rejects(()=>createAcceptedBundle(artifact,new ArrayBuffer(0),{}),/audition-only/);
 await assert.rejects(()=>createHandoffBundle(artifact),/audition-only/);
});
