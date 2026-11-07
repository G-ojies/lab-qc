import { describe, expect, it } from 'vitest';
import { evaluateAll, type QcResult } from './index';
import { holdReport, latestReject, matchAnalytes, pickRejectedRun, statusLine, statusReport, type AnalyteRecord } from './agent';
// @ts-expect-error plain JS module without type declarations
import { ANALYTES, demoResults } from '../../app/src/lib/demo.js';

const NOW = new Date('2026-11-04T12:00:00Z');

/** The stored records exactly as the resolver seeds them. */
function records(): AnalyteRecord[] {
  return (ANALYTES as Array<Record<string, any>>).map(({ plant, ...meta }) => ({
    ...(meta as any),
    results: demoResults({ plant, ...meta }, 30, NOW) as QcResult[],
  }));
}

describe('QC Officer answers', () => {
  it('matches analytes from loose words', () => {
    const all = records();
    expect(matchAnalytes(all, { test: 'glucose' }).map((r) => r.key)).toEqual(['bs240-glucose']);
    expect(matchAnalytes(all, { analyser: 'C-311' }).map((r) => r.key)).toEqual(['c311-cholesterol', 'c311-alt']);
    expect(matchAnalytes(all, { analyser: 'cobas', test: 'ALT' }).map((r) => r.key)).toEqual(['c311-alt']);
    expect(matchAnalytes(all, { test: 'bs240-creatinine' }).map((r) => r.key)).toEqual(['bs240-creatinine']);
    expect(matchAnalytes(all, {})).toHaveLength(all.length);
    expect(matchAnalytes(all, { analyser: 'C-311', test: 'glucose' })).toHaveLength(0);
  });

  it('reports the latest verdict from the engine, with the rule text', () => {
    const all = records();
    for (const r of all) {
      const latest = evaluateAll(r.results).at(-1)!;
      const line = statusLine(r, NOW);
      const word = { accept: 'IN CONTROL', warning: 'WARNING', reject: 'OUT OF CONTROL' }[latest.status];
      expect(line, r.key).toContain(word);
      for (const v of latest.violations) expect(line).toContain(v.rule);
      if (latest.status === 'reject') expect(line).toContain('hold results reported from');
    }
  });

  it('says when there is no match and lists what exists', () => {
    const text = statusReport(records(), { analyser: 'C-311', test: 'glucose' }, NOW);
    expect(text).toMatch(/^No QC record matches "C-311 glucose"/);
    expect(text).toContain('Glucose on Mindray BS-240');
  });

  it('flags stale QC older than 24 hours', () => {
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    expect(statusLine(records()[0], later)).toContain('No QC run in the last 24 hours');
    expect(statusLine(records()[0], NOW)).not.toContain('No QC run in the last 24 hours');
  });

  it('picks the newest rejected run, or explains why it cannot', () => {
    const all = records();
    const glucose = all.find((r) => r.key === 'bs240-glucose')!;
    const pick = pickRejectedRun(all, { test: 'glucose' });
    expect(pick).toEqual({ record: glucose, runId: latestReject(glucose) });
    expect(pickRejectedRun(all, { analyser: 'C-311' })).toMatchObject({ error: expect.stringContaining('matches 2 tests') });
    const accepted = evaluateAll(glucose.results).find((v) => v.status === 'accept')!;
    expect(pickRejectedRun(all, { runId: accepted.runId })).toMatchObject({ error: expect.stringContaining('was not rejected') });
    expect(pickRejectedRun(all, { runId: 'nope' })).toEqual({ error: 'No QC run with id nope.' });
  });

  it('gives the hold window and never offers to release results', () => {
    const all = records();
    const pick = pickRejectedRun(all, { test: 'creatinine' }) as { record: AnalyteRecord; runId: string };
    let text = holdReport(pick.record, pick.runId);
    expect(text).toContain('Hold window: hold results reported from');
    expect(text).toContain('I cannot release them');
    expect(text).toContain('No corrective action opened yet');
    pick.record.actions = { [pick.runId]: { issueKey: 'QC-9', issueUrl: 'https://x/browse/QC-9', pageUrl: 'https://x/wiki/p' } };
    text = holdReport(pick.record, pick.runId);
    expect(text).toContain('Corrective action: QC-9');
  });
});
