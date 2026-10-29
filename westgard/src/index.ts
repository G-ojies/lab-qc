// Westgard multirule QC evaluation.
//
// All rejection rules are applied to every run. Westgard's own guidance for computerised QC is that the
// 1-2s rule need not act as a gate that decides whether the other rules are checked, so here 1-2s is only a
// warning and never blocks the rejection rules.

export type Rule = '1-2s' | '1-3s' | '2-2s' | 'R-4s' | '4-1s' | '10x';
export type Scope = 'within-run' | 'across-runs' | 'across-levels';
export type Status = 'accept' | 'warning' | 'reject';

/** One control measurement: a single level of control material in a single QC run. */
export interface QcResult {
  id: string;
  runId: string;
  /** ISO timestamp of the run. */
  time: string;
  /** Control level, e.g. "L1" (normal) or "L2" (pathological). */
  level: string;
  value: number;
  /** Established target mean and SD for this level and lot. */
  mean: number;
  sd: number;
}

export interface Violation {
  rule: Rule;
  scope: Scope;
  /** Ids of the results that together break the rule, oldest first. */
  resultIds: string[];
  /** Plain-language explanation for the bench scientist. */
  detail: string;
}

export interface Verdict {
  runId: string;
  status: Status;
  violations: Violation[];
}

export const REJECTION_RULES: Rule[] = ['1-3s', '2-2s', 'R-4s', '4-1s', '10x'];

export function zScore(r: QcResult): number {
  if (!(r.sd > 0)) throw new Error(`QC result ${r.id} has a non-positive SD (${r.sd})`);
  return (r.value - r.mean) / r.sd;
}

const byTime = (a: QcResult, b: QcResult) => a.time.localeCompare(b.time) || a.level.localeCompare(b.level);
const fmt = (z: number) => `${z >= 0 ? '+' : ''}${z.toFixed(2)} SD`;
const side = (z: number) => (z > 0 ? 1 : z < 0 ? -1 : 0);

/**
 * Evaluate one run against the results that came before it.
 * `history` may include later runs; only results at or before the run's time are used.
 */
export function evaluateRun(history: QcResult[], runId: string): Verdict {
  const current = history.filter(r => r.runId === runId).sort(byTime);
  if (current.length === 0) throw new Error(`No QC results for run ${runId}`);
  const runTime = current[0].time;
  const past = history.filter(r => r.runId !== runId && r.time <= runTime).sort(byTime);
  const timeline = [...past, ...current];
  const z = new Map(timeline.map(r => [r.id, zScore(r)]));
  const violations: Violation[] = [];
  const add = (rule: Rule, scope: Scope, rs: QcResult[], detail: string) =>
    violations.push({ rule, scope, resultIds: rs.map(r => r.id), detail });

  // 1-3s: a single control beyond 3 SD (random error).
  for (const r of current) {
    const zr = z.get(r.id)!;
    if (Math.abs(zr) > 3) add('1-3s', 'within-run', [r], `${r.level} is ${fmt(zr)}, beyond 3 SD`);
  }

  // 2-2s: two consecutive controls beyond 2 SD on the same side (systematic error).
  for (let i = 0; i < current.length; i++) {
    for (let j = i + 1; j < current.length; j++) {
      const a = z.get(current[i].id)!, b = z.get(current[j].id)!;
      if (Math.abs(a) > 2 && Math.abs(b) > 2 && side(a) === side(b)) {
        add('2-2s', 'across-levels', [current[i], current[j]],
          `${current[i].level} ${fmt(a)} and ${current[j].level} ${fmt(b)} in the same run`);
      }
    }
  }
  for (const r of current) {
    const prev = past.filter(p => p.level === r.level).at(-1);
    if (!prev) continue;
    const a = z.get(prev.id)!, b = z.get(r.id)!;
    if (Math.abs(a) > 2 && Math.abs(b) > 2 && side(a) === side(b)) {
      add('2-2s', 'across-runs', [prev, r], `${r.level} beyond 2 SD on the same side in two consecutive runs (${fmt(a)}, ${fmt(b)})`);
    }
  }

  // R-4s: within one run, one control above +2 SD and another below -2 SD (random error).
  const hi = current.filter(r => z.get(r.id)! > 2);
  const lo = current.filter(r => z.get(r.id)! < -2);
  if (hi.length && lo.length) {
    const pair = [hi[0], lo[0]].sort(byTime);
    add('R-4s', 'within-run', pair,
      `${hi[0].level} ${fmt(z.get(hi[0].id)!)} and ${lo[0].level} ${fmt(z.get(lo[0].id)!)}: range exceeds 4 SD`);
  }

  // 4-1s and 10x: runs of consecutive results on one side, per level and across levels.
  const streak = (rule: Rule, n: number, limit: number) => {
    const sameSide = (rs: QcResult[]) => {
      const sides = rs.map(r => z.get(r.id)!);
      return rs.length === n && sides.every(s => Math.abs(s) > limit && side(s) === side(sides[0]) && side(s) !== 0);
    };
    const what = rule === '4-1s' ? 'beyond 1 SD' : 'of the mean';
    for (const r of current) {
      const lvl = timeline.filter(t => t.level === r.level && t.time <= r.time).slice(-n);
      if (sameSide(lvl)) {
        add(rule, 'across-runs', lvl, `last ${n} ${r.level} results all on the ${side(z.get(r.id)!) > 0 ? 'high' : 'low'} side ${what}`);
      }
    }
    const levels = new Set(timeline.map(t => t.level));
    if (levels.size > 1 && !violations.some(v => v.rule === rule)) {
      const all = timeline.slice(-n);
      if (sameSide(all) && new Set(all.map(t => t.level)).size > 1) {
        add(rule, 'across-levels', all, `last ${n} results across levels all on the ${side(z.get(all[0].id)!) > 0 ? 'high' : 'low'} side ${what}`);
      }
    }
  };
  streak('4-1s', 4, 1);
  streak('10x', 10, 0);

  const rejected = violations.length > 0;
  // 1-2s: warning only, reported when nothing else fired.
  if (!rejected) {
    for (const r of current) {
      const zr = z.get(r.id)!;
      if (Math.abs(zr) > 2) add('1-2s', 'within-run', [r], `${r.level} is ${fmt(zr)}, beyond 2 SD (warning)`);
    }
  }
  return { runId, status: rejected ? 'reject' : violations.length ? 'warning' : 'accept', violations };
}

/** Evaluate every run in time order, each against only the results before it. */
export function evaluateAll(history: QcResult[]): Verdict[] {
  const runs = [...new Map([...history].sort(byTime).map(r => [r.runId, r.time])).keys()];
  return runs.map(id => evaluateRun(history, id));
}

/**
 * Patient results to hold after a rejected run: everything reported since the last QC run that was accepted
 * (or warned) before it. `from` is null when there is no earlier good run, meaning hold everything up to `to`.
 */
export function holdWindow(history: QcResult[], rejectedRunId: string): { from: string | null; to: string } {
  const verdicts = evaluateAll(history);
  const time = new Map(history.map(r => [r.runId, r.time]));
  const to = time.get(rejectedRunId);
  if (!to) throw new Error(`No QC results for run ${rejectedRunId}`);
  const lastGood = verdicts
    .filter(v => v.status !== 'reject' && time.get(v.runId)! < to)
    .map(v => time.get(v.runId)!)
    .sort()
    .at(-1);
  return { from: lastGood ?? null, to };
}
