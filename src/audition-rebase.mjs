/** Audition migrations never mutate the source and never grant shipping status. */
import {validateSpec,shippingStatus} from './spec.mjs';
import {canonicalJson,sha256} from './provenance.mjs';
import {KIT_VERSION} from './version.mjs';

export function auditionRebase(sourceBytes, {kitVersion=KIT_VERSION,mix,cueId='kiosk-breeze-v5-dr5-control'}={}) {
  const source=JSON.parse(sourceBytes.toString());
  const copy=structuredClone(source);
  copy.kitVersion=kitVersion;
  if(mix!==undefined)copy.mix=structuredClone(mix);
  copy.audition={kind:'rebase',sourceSha256:sha256(sourceBytes),cueId};
  const score=validateSpec(copy);
  const migration=[{path:'/kitVersion',before:source.kitVersion,after:kitVersion},{path:'/audition',before:null,after:copy.audition}];
  if(mix!==undefined)migration.push({path:'/mix',before:source.mix??null,after:mix});
  const symbolic=structuredClone(copy);symbolic.kitVersion=source.kitVersion;delete symbolic.audition;
  if(source.mix===undefined)delete symbolic.mix;else symbolic.mix=source.mix;
  if(canonicalJson(source)!==canonicalJson(symbolic))throw Error('audition rebase changed symbolic score');
  return {score,identity:{originalByteSha256:sha256(sourceBytes),originalArtifactSha256:sha256(canonicalJson(source)),rebasedArtifactSha256:sha256(canonicalJson(score)),originalKit:source.kitVersion,rebasedKit:kitVersion,symbolicIdentityPreserved:true,migration,shipping:shippingStatus(score)}};
}
