/** Cue-bound experiment; never modifies the default score-audit implementation. */
import fs from 'node:fs';
import {auditScore} from '../score-audit/lib.mjs';
import {canonicalJson,sha256} from '../../src/provenance.mjs';
import {validateSpec,shippingStatus} from '../../src/spec.mjs';
import {COMPILER_VERSION} from '../../src/version.mjs';
import {phraseRelations} from './phrase-checks.mjs';
export const POLICY_PATH='docs/dr5/PILOT-POLICY-v1.json';
export function auditPilot(score,plan,events,{audioEvidence}={}){
 const policy=JSON.parse(fs.readFileSync(POLICY_PATH));
 score=validateSpec(score);
 if(policy.id!=='dr5-phrase-admission/1.0.0'||policy.cueId!=='woh-settlement-growth-dr5-pilot'||score.audition?.cueId!==policy.cueId||score.audition?.kind!=='pilot'||score.label!==policy.cueId)throw Error('pilot policy is bound to exactly the adopted WoH cue');
 if(sha256(canonicalJson(score))!==policy.scoreArtifactSha256||sha256(canonicalJson(plan))!==policy.phrasePlanSha256||sha256(canonicalJson(events))!==policy.performedScheduleSha256||sha256(fs.readFileSync(score.register.briefRef))!==policy.registerSha256||policy.compilerVersion!==COMPILER_VERSION)throw Error('pilot policy identity mismatch');
 if(!audioEvidence || sha256(canonicalJson(audioEvidence))!==policy.audioReportSha256 || audioEvidence.raw.sha256!==policy.renderSha256)throw Error('pilot audio evidence identity mismatch');
 const old=auditScore(score),duration=160;
 const timed=events.every(e=>Number.isFinite(e.time)&&e.time>=0&&e.time<duration&&Number.isFinite(e.options.vol)&&(!e.frequency||Number.isFinite(e.frequency)));
 const rested=events.filter(e=>e.voice==='pluck'&&e.time>=plan.rest.fromSeconds+.05&&e.time<plan.rest.toSeconds).length===0;
 const arrived=events.some(e=>e.voice==='bass'&&e.sectionIndex===5&&e.time>=plan.landing.fromSeconds-.05&&Math.abs(e.frequency-146.8323839587)<.01);
 const relations=phraseRelations(score,plan,events,audioEvidence);
 const retainedFlags=old.flags.filter(f=>!['static-harmonic-bed','low-harmonic-motion'].includes(f));
 const checks={finitePerformedSchedule:timed,documentedRise:relations.documentedRise,documentedRest:rested,bassArrival:arrived,windAnswersDuringCallVacancy:relations.windAnswersDuringCallVacancy,explicitReuse:score.sections.slice(1).every(s=>s.harmonicClaim==='reuse'),shippingBlocked:!shippingStatus(score).shippable};
 if(audioEvidence){checks.audioSafety=audioEvidence.matched.clippedFrames===0&&audioEvidence.matched.truePeakDbTP<=-1;checks.leadBalance=audioEvidence.balance.verdict==='GREEN';}
 return {policyId:policy.id,cueId:policy.cueId,oldHsmd:old,oldRateAdmissionFlags:old.flags.filter(f=>['static-harmonic-bed','low-harmonic-motion'].includes(f)),retainedFlags,phraseChecks:checks,phraseEvidence:relations,pass:retainedFlags.length===0&&Object.values(checks).every(Boolean),musicalAcceptance:false,shippingPromotion:false,note:'Only this pinned cue uses phrase evidence instead of static/low HSMD admission. distinctRootCount is a pitch-class count, not a chord-root count. No numeric fleet threshold changes.'};
}
