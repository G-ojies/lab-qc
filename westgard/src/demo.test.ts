import { describe, expect, it } from 'vitest';
import { evaluateAll, type QcResult } from './index';
// The demo month lives in the Forge app (plain JS) so the app can seed it; test it here against the engine.
// @ts-expect-error plain JS module without type declarations
import { ANALYTES, demoResults } from '../../app/src/lib/demo.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const dayOf = (runId: string) => Number(runId.slice(-2));

const verdicts = Object.fromEntries(
  (ANALYTES as Array<{ key: string }>).map(spec => [spec.key, evaluateAll(demoResults(spec, 30, NOW) as QcResult[])]),
);
const flagged = (key: string, status: string) =>
  verdicts[key].filter(v => v.status === status).map(v => dayOf(v.runId));

describe('demo QC month', () => {
  it('covers three analysers and six analytes with two levels each', () => {
    expect(new Set(ANALYTES.map((a: { analyser: string }) => a.analyser)).size).toBe(3);
    expect(ANALYTES).toHaveLength(6);
    for (const v of Object.values(verdicts)) expect(v).toHaveLength(30);
  });

  it('fires every Westgard rule at least once', () => {
    const fired = new Set(Object.values(verdicts).flat().flatMap(v => v.violations.map(x => x.rule)));
    expect([...fired].sort()).toEqual(['1-2s', '1-3s', '10x', '2-2s', '4-1s', 'R-4s']);
  });

  it('rejects only the planted problems', () => {
    expect(flagged('bs240-creatinine', 'reject')).toEqual([18]);
    expect(flagged('c311-cholesterol', 'reject')).toEqual([25]);
    expect(flagged('c311-alt', 'reject')).toEqual([13]);
    expect(flagged('xn550-haemoglobin', 'reject')).toEqual([]);
    expect(flagged('xn550-wbc', 'reject')).toEqual([]);
    const glucose = flagged('bs240-glucose', 'reject');
    expect(glucose.length).toBeGreaterThan(0);
    expect(Math.min(...glucose)).toBeGreaterThanOrEqual(22);
  });

  it('catches the glucose shift with 4-1s before 10x', () => {
    const rulesOn = verdicts['bs240-glucose'].map(v => ({ day: dayOf(v.runId), rules: v.violations.map(x => x.rule) }));
    const first41 = rulesOn.find(r => r.rules.includes('4-1s'))!.day;
    const first10x = rulesOn.find(r => r.rules.includes('10x'))?.day;
    // Day 22 and 23 give four results (two levels x two runs) beyond +1 SD: 4-1s across levels on day 23.
    expect(first41).toBe(23);
    if (first10x !== undefined) expect(first10x).toBeGreaterThan(first41);
  });

  it('warns on haemoglobin day 9 and ALT day 12 without rejecting', () => {
    expect(flagged('xn550-haemoglobin', 'warning')).toContain(9);
    expect(flagged('c311-alt', 'warning')).toContain(12);
  });

  it('is the same month on every seed', () => {
    const a = demoResults(ANALYTES[0], 30, NOW), b = demoResults(ANALYTES[0], 30, NOW);
    expect(a).toEqual(b);
  });
});
