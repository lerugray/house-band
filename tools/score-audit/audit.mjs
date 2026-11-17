#!/usr/bin/env node
/**
 * House Band structural score-audit probe.
 *
 * Usage:
 *   node tools/score-audit/audit.mjs <path-to-score>
 *   node tools/score-audit/audit.mjs <path-to-score> --human
 *
 * Exit code 0 when the score passes, 1 when any audit flag fires.
 */

import { loadScore, auditScore } from './lib.mjs';

function humanSummary(result, path) {
  const { pass, flags, metrics } = result;
  const lines = [];
  lines.push(`${pass ? 'PASS' : 'FAIL'}: ${path}`);
  if (flags.length === 0) {
    lines.push('  No audit flags.');
  } else {
    lines.push(`  Flags: ${flags.join(', ')}`);
  }

  const onset = Object.entries(metrics.onset)
    .map(([voice, m]) => `${voice} residualRange=${m.residualRangeMs.toFixed(2)}ms humanized=${m.humanized}`)
    .join('; ');
  if (onset) lines.push(`  Onsets: ${onset}`);

  const velocity = Object.entries(metrics.velocity)
    .map(([voice, m]) => `${voice} range=${m.range?.toFixed(4) ?? 'default'} humanized=${m.humanized}`)
    .join('; ');
  if (velocity) lines.push(`  Velocities: ${velocity}`);

  const lead = Object.entries(metrics.leadReleases)
    .map(([voice, m]) => `${voice} totalRange=${m.totalRange.toFixed(3)}s`)
    .join('; ');
  if (lead) lines.push(`  Lead releases: ${lead}`);

  lines.push(`  Sections: count=${metrics.sections.count} distinctSignatures=${metrics.sections.distinctSignatures}`);
  lines.push(`  Harmony: distinctRoots=${metrics.harmony.distinctRootCount} [${metrics.harmony.distinctRoots.join(', ')}]`);

  const harmonicMotion = metrics.harmonicState.sections
    .map((section) => section.available
      ? `${section.label}=${section.score.toFixed(3)} ${section.classification}`
      : `${section.label}=n/a ${section.classification}`)
    .join('; ');
  if (harmonicMotion) lines.push(`  HSMD motion: ${harmonicMotion}`);

  const distinctness = metrics.harmonicState.comparisons
    .filter((comparison) => comparison.available)
    .map((comparison) => `${comparison.labels.join('↔')}=${comparison.distance.toFixed(3)}`)
    .join('; ');
  if (distinctness) lines.push(`  HSMD distinctness: ${distinctness}`);
  lines.push(`  HSMD suggested verdict: ${metrics.harmonicState.summary.suggestedVerdict}`);
  const enforcement = metrics.harmonicState.enforcement;
  lines.push(`  HSMD enforcement: ${enforcement.mode}${enforcement.staticBedAuthorized ? ' (operator-authorized static bed)' : ''}`);
  if (enforcement.grandfatheredPath) {
    lines.push(`  HSMD grandfathered: ${enforcement.grandfatheredPath}`);
  }
  if (enforcement.reportedReusePairs.length > 0) {
    lines.push(`  HSMD reported reuse: ${enforcement.reportedReusePairs.map((pair) => pair.labels.join('↔')).join(', ')}`);
  }
  if (enforcement.operatorJudgmentPairs.length > 0) {
    lines.push(`  HSMD operator judgment: ${enforcement.operatorJudgmentPairs.map((pair) => `${pair.labels.join('↔')}=${pair.distance.toFixed(3)}`).join('; ')}`);
  }
  if (enforcement.insufficientSections.length > 0) {
    lines.push(`  HSMD insufficient data (operator judgment): ${enforcement.insufficientSections.map((section) => section.label).join(', ')}`);
  }

  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const humanMode = args.includes('--human');
  const path = args.find((a) => !a.startsWith('-'));

  if (!path) {
    console.error('Usage: node tools/score-audit/audit.mjs <path-to-score> [--human]');
    process.exit(2);
  }

  let score;
  try {
    score = await loadScore(path);
  } catch (err) {
    if (humanMode) {
      console.error(`ERROR: cannot load ${path}: ${err.message}`);
    } else {
      console.error(JSON.stringify({ pass: false, flags: ['load-error'], error: err.message }, null, 2));
    }
    process.exit(2);
  }

  const result = auditScore(score, { sourcePath: path });

  if (humanMode) {
    console.log(humanSummary(result, path));
    console.log('\nJSON:');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
    console.error(humanSummary(result, path));
  }

  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
