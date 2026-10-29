import { describe, expect, it } from 'vitest';
import { evaluateAll, evaluateRun, holdWindow, type QcResult } from './index';

// Glucose controls: L1 target 100 mg/dL SD 2, L2 target 300 mg/dL SD 6. Values are built from z-scores.
const TARGET = { L1: { mean: 100, sd: 2 }, L2: { mean: 300, sd: 6 } } as const;
type Lv = keyof typeof TARGET;

function runs(...zs: Array<Partial<Record<Lv, number>>>): QcResult[] {
  return zs.flatMap((levels, i) =>
    (Object.entries(levels) as Array<[Lv, number]>).map(([level, z]) => ({
      id: `r${i + 1}-${level}`,
      runId: `r${i + 1}`,
      time: new Date(Date.UTC(2026, 10, 1, 6 + i)).toISOString(),
      level,
      mean: TARGET[level].mean,
      sd: TARGET[level].sd,
      value: TARGET[level].mean + z * TARGET[level].sd,
    })));
}
const last = (h: QcResult[]) => evaluateRun(h, h.at(-1)!.runId);
const rules = (h: QcResult[]) => last(h).violations.map(v => `${v.rule}/${v.scope}`);

describe('single-run rules', () => {
  it('accepts a run inside 2 SD', () => {
    expect(last(runs({ L1: 0.4, L2: -1.1 }))).toMatchObject({ status: 'accept', violations: [] });
  });

  it('flags 1-2s as a warning only', () => {
    const v = last(runs({ L1: 2.5, L2: 0.2 }));
    expect(v.status).toBe('warning');
    expect(v.violations.map(x => x.rule)).toEqual(['1-2s']);
  });

  it('treats exactly 2 SD as inside the limit', () => {
    expect(last(runs({ L1: 2, L2: -2 })).status).toBe('accept');
  });

  it('rejects 1-3s', () => {
    expect(last(runs({ L1: -3.2, L2: 0 })).status).toBe('reject');
    expect(rules(runs({ L1: -3.2, L2: 0 }))).toEqual(['1-3s/within-run']);
  });

  it('rejects 2-2s across levels within a run', () => {
    expect(rules(runs({ L1: 2.3, L2: 2.4 }))).toEqual(['2-2s/across-levels']);
  });

  it('rejects R-4s, not 2-2s, when the two levels split across the mean', () => {
    expect(rules(runs({ L1: 2.3, L2: -2.4 }))).toEqual(['R-4s/within-run']);
  });

  it('does not report the 1-2s warning once a rejection rule fires', () => {
    expect(rules(runs({ L1: 3.5, L2: 2.5 }))).not.toContain('1-2s/within-run');
  });
});

describe('rules across runs', () => {
  it('rejects 2-2s on the same level in consecutive runs', () => {
    const h = runs({ L1: 2.2, L2: 0 }, { L1: 2.1, L2: 0.3 });
    expect(evaluateRun(h, 'r1').status).toBe('warning');
    expect(rules(h)).toEqual(['2-2s/across-runs']);
  });

  it('does not reject 2-2s across runs on opposite sides', () => {
    expect(last(runs({ L1: 2.2, L2: 0 }, { L1: -2.1, L2: 0 })).status).toBe('warning');
  });

  it('rejects 4-1s on the fourth consecutive result beyond 1 SD, not the third', () => {
    const h = runs({ L1: 1.2, L2: 0 }, { L1: 1.3, L2: 0.1 }, { L1: 1.1, L2: -0.2 }, { L1: 1.5, L2: 0 });
    expect(evaluateRun(h, 'r3').status).toBe('accept');
    expect(rules(h)).toEqual(['4-1s/across-runs']);
  });

  it('rejects 4-1s across levels over two runs', () => {
    expect(rules(runs({ L1: 1.2, L2: 1.3 }, { L1: 1.4, L2: 1.1 }))).toEqual(['4-1s/across-levels']);
  });

  it('rejects 10x on the tenth result on one side of the mean, not the ninth', () => {
    const zs = Array.from({ length: 10 }, (_, i) => ({ L1: 0.5, L2: i % 2 ? 0.3 : -0.3 }));
    const h = runs(...zs);
    expect(evaluateRun(h, 'r9').status).toBe('accept');
    expect(rules(h)).toEqual(['10x/across-runs']);
  });

  it('rejects 10x across levels over five runs', () => {
    const h = runs(...Array.from({ length: 5 }, () => ({ L1: 0.4, L2: 0.6 })));
    expect(evaluateRun(h, 'r4').status).toBe('accept');
    expect(rules(h)).toEqual(['10x/across-levels']);
  });

  it('breaks a streak on a result exactly at the mean', () => {
    const zs = Array.from({ length: 10 }, (_, i) => ({ L1: i === 4 ? 0 : 0.5 }));
    expect(last(runs(...zs)).status).toBe('accept');
  });

  it('ignores runs that come after the one being evaluated', () => {
    const h = runs({ L1: 0.2, L2: 0 }, { L1: 3.4, L2: 0 });
    expect(evaluateRun(h, 'r1').status).toBe('accept');
  });

  it('lists the results behind each violation, oldest first', () => {
    const v = last(runs({ L1: 2.2, L2: 0 }, { L1: 2.1, L2: 0.3 })).violations[0];
    expect(v.resultIds).toEqual(['r1-L1', 'r2-L1']);
    expect(v.detail).toContain('L1');
  });
});

describe('evaluateAll and holdWindow', () => {
  const h = runs({ L1: 0.1, L2: 0.2 }, { L1: 2.4, L2: 0.1 }, { L1: -0.5, L2: 0.3 }, { L1: 3.3, L2: 0.4 });

  it('evaluates every run in order', () => {
    expect(evaluateAll(h).map(v => v.status)).toEqual(['accept', 'warning', 'accept', 'reject']);
  });

  it('holds patient results back to the last good run', () => {
    expect(holdWindow(h, 'r4')).toEqual({ from: h.find(r => r.runId === 'r3')!.time, to: h.find(r => r.runId === 'r4')!.time });
  });

  it('skips earlier rejected runs when finding the last good run', () => {
    const h2 = runs({ L1: 0.1, L2: 0 }, { L1: 3.6, L2: 0 }, { L1: -3.4, L2: 0 });
    expect(holdWindow(h2, 'r3').from).toBe(h2[0].time);
  });

  it('returns a null start when no run before it was good', () => {
    expect(holdWindow(runs({ L1: 3.1, L2: 0 }), 'r1').from).toBeNull();
  });

  it('refuses a control with no usable SD', () => {
    const bad = runs({ L1: 0 });
    bad[0].sd = 0;
    expect(() => evaluateRun(bad, 'r1')).toThrow(/SD/);
  });
});
