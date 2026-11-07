import { describe, expect, it } from 'vitest';
import { evaluateAll, holdWindow, type QcResult } from './index';
import { buildIncidentPage, buildIssue, CHECKLIST, errorTypes, esc, formatTime, type IncidentInput } from './incident';
// @ts-expect-error plain JS module without type declarations
import { ANALYTES, demoResults } from '../../app/src/lib/demo.js';

const NOW = new Date('2026-11-04T12:00:00Z');

/** Build the incident input for the first rejected run of a demo analyte, the way the resolver does. */
function firstReject(key: string): IncidentInput {
  const spec = (ANALYTES as Array<Record<string, any>>).find(a => a.key === key)!;
  const results = demoResults(spec, 30, NOW) as QcResult[];
  const v = evaluateAll(results).find(x => x.status === 'reject')!;
  const mine = results.filter(r => r.runId === v.runId);
  return {
    analyser: spec.analyser,
    analyte: spec.analyte,
    unit: spec.unit,
    levels: spec.levels,
    run: {
      runId: v.runId,
      time: mine[0].time,
      values: Object.fromEntries(mine.map(r => [r.level, r.value])),
      violations: v.violations,
    },
    hold: holdWindow(results, v.runId),
  };
}

const ADF_TYPES = new Set(['doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem']);
function walk(node: any, seen: string[] = []): string[] {
  seen.push(node.type);
  for (const c of node.content ?? []) walk(c, seen);
  return seen;
}
const adfText = (node: any): string => (node.text ?? '') + (node.content ?? []).map(adfText).join(' ');

describe('incident documents', () => {
  it('formats times in UTC', () => {
    expect(formatTime('2026-11-07T08:05:00.000Z')).toBe('07 Nov 2026 08:05 UTC');
  });

  it('classifies the error type from the rules that fired', () => {
    const glucose = firstReject('bs240-glucose');
    expect(errorTypes(glucose)).toContain('systematic');
    const alt = firstReject('c311-alt');
    expect(alt.run.violations.length).toBeGreaterThan(0);
    expect(errorTypes(alt).length).toBeGreaterThan(0);
  });

  it('builds a Jira work item with the rules, hold window and checklist', () => {
    const input = firstReject('bs240-glucose');
    const issue = buildIssue(input);
    expect(issue.summary).toMatch(/^QC reject: Glucose on .+, .*4-1s/);
    expect(issue.labels).toContain('qc-reject');
    expect(issue.labels).toContain('systematic-error');
    expect(issue.labels.every(l => !/\s/.test(l))).toBe(true);
    const doc = issue.description as any;
    expect(doc).toMatchObject({ type: 'doc', version: 1 });
    expect(walk(doc).every(t => ADF_TYPES.has(t))).toBe(true);
    const all = adfText(doc);
    expect(all).toContain('Hold patient results');
    expect(all).toContain(formatTime(input.hold.to));
    for (const step of CHECKLIST) expect(all).toContain(step);
    expect(all).toContain('Calibration drift');
  });

  it('builds a Confluence incident page with the accreditation sections and a human release sign-off', () => {
    const input = firstReject('bs240-creatinine');
    const page = buildIncidentPage(input, 'QC-7');
    expect(page.title).toMatch(/^QC incident QC-7: Creatinine on /);
    for (const h of ['1. Summary', '2. QC data', '3. Patient impact', '4. Investigation', '5. Corrective action', '6. Verification', '7. Release of held results'])
      expect(page.body).toContain(`<h2>${h}</h2>`);
    expect(page.body).toContain('ISO 15189:2022');
    expect(page.body).toContain('Released by');
    // Every task in the task lists has a unique id within its list and starts incomplete.
    expect(page.body).not.toContain('<ac:task-status>complete</ac:task-status>');
    // Tags balance, so Confluence accepts the storage format.
    for (const tag of ['table', 'tbody', 'tr', 'ul', 'li', 'ac:task-list', 'ac:task', 'ac:structured-macro', 'h2', 'p']) {
      const open = page.body.match(new RegExp(`<${tag}[ >]`, 'g'))?.length ?? 0;
      const close = page.body.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
      expect(close, tag).toBe(open);
    }
  });

  it('escapes text for storage format', () => {
    expect(esc('a < b & "c" > d')).toBe('a &lt; b &amp; &quot;c&quot; &gt; d');
    const input = firstReject('c311-cholesterol');
    input.analyser = 'Lab <A> & B';
    expect(buildIncidentPage(input).body).toContain('Lab &lt;A&gt; &amp; B');
  });
});
