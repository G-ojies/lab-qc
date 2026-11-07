// Plain-language answers for the Rovo agent "QC Officer" and the MCP tools.
//
// Pure functions: they take stored analyte records and return the text the agent shows. Every verdict comes
// from the Westgard engine, never from the language model, so the agent can only report what the rules say.
// Nothing here releases patient results.

import { evaluateAll, holdWindow, type QcResult, type Verdict } from './index';
import { formatTime } from './incident';

export interface AnalyteRecord {
  key: string;
  analyser: string;
  analyte: string;
  unit: string;
  levels: Record<string, { mean: number; sd: number }>;
  results: QcResult[];
  /** Corrective actions already opened, by run id. */
  actions?: Record<string, { issueKey: string; issueUrl: string; pageUrl: string }>;
}

export interface Query {
  analyser?: string;
  test?: string;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find analytes from loose words, the way a person names them in chat: "glucose", "C-311", "cobas ALT",
 * "bs240-glucose". Every word given must match the analyser, the test or the key.
 */
export function matchAnalytes<T extends Pick<AnalyteRecord, 'key' | 'analyser' | 'analyte'>>(records: T[], q: Query = {}): T[] {
  const words = [q.analyser, q.test]
    .filter(Boolean)
    .flatMap((s) => String(s).split(/[\s,]+/))
    .map(norm)
    .filter(Boolean);
  if (!words.length) return records;
  return records.filter((r) => {
    const hay = [r.analyser, r.analyte, r.key].map(norm).join('|');
    return words.every((w) => hay.includes(w));
  });
}

const STATUS_TEXT: Record<Verdict['status'], string> = {
  accept: 'IN CONTROL: results can be reported',
  warning: 'WARNING (1-2s only): results can be reported, watch the next run',
  reject: 'OUT OF CONTROL: hold patient results',
};

const rulesOf = (v: Verdict) => [...new Set(v.violations.map((x) => x.rule))];

function valuesOf(record: AnalyteRecord, runId: string): string {
  return record.results
    .filter((r) => r.runId === runId)
    .map((r) => {
      const z = (r.value - r.mean) / r.sd;
      return `${r.level} ${r.value} ${record.unit} (${z > 0 ? '+' : ''}${z.toFixed(1)} SD)`;
    })
    .join(', ');
}

function holdText(h: { from: string | null; to: string }): string {
  return `hold results reported from ${h.from ? formatTime(h.from) : 'the start of the QC record'} to ${formatTime(h.to)}`;
}

function runTime(record: AnalyteRecord, runId: string): string {
  return record.results.find((r) => r.runId === runId)?.time ?? '';
}

/** The newest rejected run of a record, or null. */
export function latestReject(record: AnalyteRecord): string | null {
  const rejects = evaluateAll(record.results).filter((v) => v.status === 'reject');
  return rejects.length ? rejects[rejects.length - 1].runId : null;
}

function noMatch(records: AnalyteRecord[], q: Query): string {
  const asked = [q.analyser, q.test].filter(Boolean).join(' ');
  const list = records.map((r) => `${r.analyte} on ${r.analyser}`).join('; ');
  return `No QC record matches "${asked}". Tests with QC data: ${list || 'none yet'}.`;
}

/** One analyte's current state, for "is analyser X OK for test Y". */
export function statusLine(record: AnalyteRecord, now: Date = new Date()): string {
  const verdicts = evaluateAll(record.results);
  const latest = verdicts[verdicts.length - 1];
  if (!latest) return `${record.analyte} on ${record.analyser}: no QC runs recorded.`;
  const t = runTime(record, latest.runId);
  const ageH = (now.getTime() - new Date(t).getTime()) / 3_600_000;
  const lines = [
    `${record.analyte} on ${record.analyser}: ${STATUS_TEXT[latest.status]}.`,
    `Latest QC run ${formatTime(t)}: ${valuesOf(record, latest.runId)}.`,
  ];
  if (latest.violations.length)
    lines.push(`Rules: ${latest.violations.map((v) => `${v.rule}: ${v.detail}`).join(' ')}`);
  if (latest.status === 'reject') {
    lines.push(`Patient results: ${holdText(holdWindow(record.results, latest.runId))}.`);
    const a = record.actions?.[latest.runId];
    lines.push(a ? `Corrective action open: ${a.issueKey} (${a.issueUrl}), incident page ${a.pageUrl}.` : 'No corrective action opened yet for this run.');
  } else {
    const last = latestReject(record);
    if (last) {
      const a = record.actions?.[last];
      lines.push(`Last reject: ${formatTime(runTime(record, last))}${a ? `, corrective action ${a.issueKey}` : ', no corrective action on record'}.`);
    }
  }
  if (ageH > 24) lines.push(`No QC run in the last 24 hours (latest is ${Math.round(ageH)} h old): run QC before reporting patient results.`);
  return lines.join('\n');
}

/** Answer "is X OK": every analyte that matches the query. */
export function statusReport(records: AnalyteRecord[], q: Query = {}, now: Date = new Date()): string {
  const hits = matchAnalytes(records, q);
  if (!hits.length) return noMatch(records, q);
  return hits.map((r) => statusLine(r, now)).join('\n\n');
}

/** Resolve the one analyte and rejected run an action is about, or explain why it cannot. */
export function pickRejectedRun(
  records: AnalyteRecord[],
  q: Query & { runId?: string },
): { record: AnalyteRecord; runId: string } | { error: string } {
  if (q.runId) {
    const record = records.find((r) => r.results.some((x) => x.runId === q.runId));
    if (!record) return { error: `No QC run with id ${q.runId}.` };
    const v = evaluateAll(record.results).find((x) => x.runId === q.runId)!;
    if (v.status !== 'reject') return { error: `Run ${q.runId} was not rejected (${v.status}), so no patient results need holding.` };
    return { record, runId: q.runId };
  }
  const hits = matchAnalytes(records, q);
  if (!hits.length) return { error: noMatch(records, q) };
  if (hits.length > 1)
    return { error: `That matches ${hits.length} tests: ${hits.map((r) => `${r.analyte} on ${r.analyser}`).join('; ')}. Name the analyser and the test.` };
  const record = hits[0];
  const runId = latestReject(record);
  if (!runId) return { error: `${record.analyte} on ${record.analyser} has no rejected QC run.` };
  return { record, runId };
}

/** Answer "which results do I hold": the hold window for a rejected run. */
export function holdReport(record: AnalyteRecord, runId: string): string {
  const v = evaluateAll(record.results).find((x) => x.runId === runId)!;
  const h = holdWindow(record.results, runId);
  const a = record.actions?.[runId];
  return [
    `${record.analyte} on ${record.analyser}, rejected run ${formatTime(runTime(record, runId))} (run id ${runId}).`,
    `Rules: ${rulesOf(v).join(', ')}. Values: ${valuesOf(record, runId)}.`,
    `Hold window: ${holdText(h)}. The window starts at the last accepted run; if the investigation dates the cause earlier, extend the review.`,
    a ? `Corrective action: ${a.issueKey} (${a.issueUrl}), incident page ${a.pageUrl}.` : 'No corrective action opened yet. I can open one (a Jira work item and a Confluence incident page).',
    'Releasing held results is a human sign-off on the incident page. I cannot release them.',
  ].join('\n');
}
