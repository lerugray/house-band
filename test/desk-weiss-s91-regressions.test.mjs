import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WeissCli} from '../src/desk/weiss.mjs';
import {DeskService} from '../src/desk/service.mjs';
import {SessionStore} from '../src/desk/session-store.mjs';

it('retains observed model receipts and citation confidence separately from requested model',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hb-weiss-receipts-'));
 try {
  const envelope={arm:'primary',backend:'claude-home',model:'requested-model',reply:'A direction.',backend_receipts:[{model_usage_ids:['actual-model','auxiliary-model'],subtype:'success',num_turns:1}],citations:[{tag:'music:test',title:'Fixture',source_kind:'music',source_path:'fixture.mid.json',id:'fixture',kind:'source',confidence_tier:'direct',source_id:'fixture-source'}],music_evidence:{tracks:[{title:'Fixture'}],modality_limit:'Descriptors, not heard audio.',correlated_support_limit:"Repeated fingerprint facts, recovered duplicates and analyses derived from the same track are correlated evidence, not independent votes. A second catalog row or title does not establish a second musical example.",selection:'explicit'},calibration:{stage:'DRAFT-ONLY',ux_action:'ASK HUMAN'}};
  const script=join(dir,'fixture.mjs');await writeFile(script,`console.log(${JSON.stringify(JSON.stringify(envelope))});`);
  const cli=new WeissCli({executable:process.execPath,script,cwd:dir,configPath:join(dir,'missing.json'),env:{}});
  const result=await cli.generate('fixture');assert.equal(result.reply,envelope.reply);
  for(const key of ['model','backend','backend_receipts','citations','calibration','music_evidence'])assert.deepEqual(result.provenance[key],envelope[key],key);
  assert(!('argv' in result.provenance));assert(!('stdout' in result.provenance));
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('Weiss-off fresh brief does not inherit prior context; revision retains its original prompt shape',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hb-weiss-off-'));
 try {
  const store=new SessionStore({root:join(dir,'sessions')});
  const api={setProvider(){},async submitSong(){return {job:{jobId:'fake'},completion:Promise.resolve({state:'succeeded'})};}};
  const service=await new DeskService({sessionStore:store,apiService:api}).init();
  let request;service.providerFor=()=>({laneId:'stub',async generate(input){request=input.request;return 'A direction.';}});
  service.takeFromJob=async()=>({takeId:'new',score:{},model:'stub'});
  const created=await service.createSession({prompt:'original',weissEnabled:false});let session=await store.read(created.sessionId);session.brief={text:'prior context'};session.takes=[{takeId:'parent'}];await store.write(session);
  await service.makeBrief(created.sessionId,'fresh');assert.equal(request.rawPrompt,'fresh');assert.equal(request.context,null);assert.equal(request.revision,null);
  session=await store.read(created.sessionId);session.brief={text:'prior context'};await store.write(session);
  await service.reviseScore(created.sessionId,'parent','slower');assert.equal(request.rawPrompt,'fresh');assert.equal(request.context,'prior context');assert.equal(request.revision,'slower');
 }finally{await rm(dir,{recursive:true,force:true});}
});
