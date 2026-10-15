import type { Check, Review } from './types.js';

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Match every agreed line once; omissions remain visible even when the Builder reports extra checks. */
export function matchChecks(doneWhen: string[], checks: Check[]): Check[] {
  const used = new Set<number>();
  const matches = doneWhen.map(criterion => {
    const index = checks.findIndex((check, i) => !used.has(i) && normalize(check.criterion) === normalize(criterion));
    if (index >= 0) used.add(index);
    return index;
  });
  return doneWhen.map((criterion, index) => {
    let found = matches[index] ?? -1;
    if (found < 0 && checks.length === doneWhen.length) {
      found = !used.has(index) ? index : checks.findIndex((_check, i) => !used.has(i));
      if (found >= 0) used.add(found);
    }
    const check = checks[found];
    return check ? { ...check, criterion } : { criterion, passed: false, evidence: 'not addressed' };
  });
}

/** Only Fade's successful runs prove a line. A Builder claim alone never does. */
export function verdict(doneWhen: string[], checks: Check[]): Review['verdict'] {
  if (doneWhen.length === 0) return 'none';
  const rows = matchChecks(doneWhen, checks);
  if (rows.some(row => row.ran ? row.ran.code !== 0 : !row.look && !row.passed)) return 'failed';
  if (rows.some(row => !row.look && (!row.proof || !row.ran))) return 'said';
  return rows.some(row => row.look) ? 'look' : 'verified';
}

export function checkMark(check: Check): string {
  if (check.ran) return check.ran.code === 0 ? '✓' : '✗';
  if (check.look) return '👁';
  return check.passed ? '·' : '✗';
}

export function reviewLabel(review: Review): string {
  if (review.verdict === 'none') return 'no checks agreed';
  if (review.verdict === 'look') return 'your call';
  if (review.verdict === 'failed') {
    const checks = matchChecks(review.doneWhen ?? [], review.checks ?? []);
    return `${checks.filter(check => check.ran?.code === 0).length}/${checks.length} proved`;
  }
  return review.verdict === 'said' ? 'said, not run' : review.verdict;
}
