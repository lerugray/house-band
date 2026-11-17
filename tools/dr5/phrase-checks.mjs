/** Cue-local phrase relations, separate from custody pins so regressions can mutate evidence. */
const median=values=>{const s=[...values].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:NaN;};
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
export function noteReleaseEnd(e){
 const o=e.options;
 const hold=e.duration*(e.voice==='pluck'||e.voice==='bass'?(o.holdScale??1):1);
 const decay=e.voice==='pluck'||e.voice==='bass'?e.duration*o.dScale:o.d;
 return e.time+Math.max(hold,o.a+decay)+o.r;
}
export function phraseRelations(score,plan,events,audio){
 const sectionSeconds=32*60/score.tempo;
 const riseIndex=Math.round(plan.rise.fromSeconds/sectionSeconds);
 const section=score.sections[riseIndex];
 const start=riseIndex*sectionSeconds,barSeconds=sectionSeconds/8;
 const inBars=(e,bars)=>e.sectionIndex===riseIndex&&bars.includes(Math.floor(e.absoluteStep/16));
 const lead=events.filter(e=>e.voice==='pluck');
 const baseline=lead.filter(e=>inBars(e,plan.rise.baselineBars));
 const apex=lead.filter(e=>inBars(e,plan.rise.apexBars));
 const shapeRatio=key=>mean(plan.rise.apexBars.map(i=>section.shape[key][i]))/mean(plan.rise.baselineBars.map(i=>section.shape[key][i]));
 const gainRatio=median(apex.map(e=>e.options.vol))/median(baseline.map(e=>e.options.vol));
 const brightnessRatio=median(apex.map(e=>e.options.cut))/median(baseline.map(e=>e.options.cut));
 const bars=audio.barRmsDbFS.slice(riseIndex*8,(riseIndex+1)*8);
 const renderedRiseDb=mean(plan.rise.apexBars.map(i=>bars[i]))-mean(plan.rise.baselineBars.map(i=>bars[i]));
 const loudestBar=audio.barRmsDbFS.indexOf(Math.max(...audio.barRmsDbFS));
 const riseAligned=Math.abs(start-plan.rise.fromSeconds)<.001&&Math.abs(start+sectionSeconds-plan.rise.toSeconds)<.001&&plan.rise.apexBars.includes(Math.floor((plan.rise.apexSeconds-start)/barSeconds+1e-6));
 const documentedRise=riseAligned&&shapeRatio('gain')>=plan.rise.minimumGainRatio&&shapeRatio('bright')>=plan.rise.minimumBrightnessRatio&&gainRatio>=plan.rise.minimumGainRatio&&brightnessRatio>=plan.rise.minimumBrightnessRatio&&renderedRiseDb>=plan.rise.minimumRenderedRiseDb&&plan.rise.apexBars.includes(loudestBar-riseIndex*8);
 const wind=events.filter(e=>e.voice==='lead');
 const gaps=wind.map(w=>{
  const releaseEnd=noteReleaseEnd(w);
  const roomEnd=releaseEnd+plan.windGap.roomTailSeconds;
  const nextCall=lead.find(c=>c.time>w.time);
  const previousCall=lead.filter(c=>c.time<=w.time).at(-1);
  const previousReleaseEnd=previousCall?noteReleaseEnd(previousCall):null;
  return {onsetSeconds:w.time,releaseEndSeconds:releaseEnd,roomEndSeconds:roomEnd,nextCallSeconds:nextCall?.time??null,clearanceSeconds:nextCall?nextCall.time-roomEnd:null,previousReleaseEndSeconds:previousReleaseEnd,pass:!lead.some(c=>c.time<=w.time&&noteReleaseEnd(c)>w.time)&&(!nextCall||roomEnd+plan.windGap.minimumClearanceSeconds<=nextCall.time)};
 });
 return {documentedRise,windAnswersDuringCallVacancy:wind.length>0&&gaps.every(g=>g.pass),riseEvidence:{gainRatio,brightnessRatio,shapeGainRatio:shapeRatio('gain'),shapeBrightnessRatio:shapeRatio('bright'),renderedRiseDb,loudestBar,loudestBarStartSeconds:loudestBar*barSeconds},windGaps:gaps};
}
