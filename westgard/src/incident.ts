// Corrective-action documents for a rejected QC run.
//
// Pure functions only: given the analyte, the rejected run and its hold window, build
//   - the Jira work item (summary, labels, Atlassian Document Format description with the checklist), and
//   - the Confluence incident page (storage format) in the shape an accreditation assessor expects.
// The resolver sends these to Jira and Confluence. Nothing here releases patient results: release is a human
// sign-off recorded on the incident page.

import type { Rule, Violation } from './index';

export interface IncidentInput {
  analyser: string;
  analyte: string;
  unit: string;
  /** Targets per control level, e.g. { L1: { mean: 95, sd: 3 } }. */
  levels: Record<string, { mean: number; sd: number }>;
  run: {
    runId: string;
    /** ISO time of the rejected run. */
    time: string;
    /** Measured value per control level. */
    values: Record<string, number>;
    violations: Violation[];
  };
  /** Patient results to hold: from the last good run (null = start of record) to the rejected run. */
  hold: { from: string | null; to: string };
}

/** Random errors widen the spread; systematic errors shift every result the same way. */
export type ErrorType = 'random' | 'systematic';

export const ERROR_TYPE: Record<Rule, ErrorType> = {
  '1-2s': 'random',
  '1-3s': 'random',
  'R-4s': 'random',
  '2-2s': 'systematic',
  '4-1s': 'systematic',
  '10x': 'systematic',
};

/** Where a bench scientist looks first for each error type. */
export const LIKELY_CAUSES: Record<ErrorType, string[]> = {
  random: [
    'Bubble, clot or short sample in the control cup',
    'Pipetting or sample probe fault (check probe wash and alignment)',
    'Control not mixed or not brought to room temperature',
    'Electrical noise or a one-off instrument error flag',
  ],
  systematic: [
    'Calibration drift: recalibrate and check calibrator lot and expiry',
    'New reagent lot or reagent near expiry or opened too long',
    'Control material deteriorated or a new control lot with unchanged targets',
    'Instrument wear: lamp, electrode, cuvette or incubator temperature',
  ],
};

/** The corrective-action checklist, in the order the work is done. */
export const CHECKLIST = [
  'Stop reporting patient results for this test on this analyser',
  'Hold the patient results in the hold window and notify the requesting clinicians if any were already released',
  'Investigate the cause (see likely causes) and record what was found',
  'Fix the cause: recalibrate, change reagent or control lot, or service the instrument',
  'Rerun both control levels and confirm the run is accepted',
  'Rerun or review held patient samples as the lab procedure requires',
  'Authorised scientist reviews the incident and releases held results (human sign-off)',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "07 Nov 2026 08:00 UTC". */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${dd} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${iso.slice(11, 16)} UTC`;
}

function rulesOf(input: IncidentInput): Rule[] {
  return [...new Set(input.run.violations.map((v) => v.rule))];
}

/** Error types behind the rejection rules that fired (1-2s alone never rejects, so it is ignored here). */
export function errorTypes(input: IncidentInput): ErrorType[] {
  const types = rulesOf(input)
    .filter((r) => r !== '1-2s')
    .map((r) => ERROR_TYPE[r]);
  return [...new Set(types)];
}

function holdText(hold: IncidentInput['hold']): string {
  const from = hold.from ? formatTime(hold.from) : 'the start of the QC record';
  return `Hold patient results for this test on this analyser reported from ${from} to ${formatTime(hold.to)}.`;
}

function valuesText(input: IncidentInput): string {
  return Object.entries(input.run.values)
    .map(([level, value]) => {
      const t = input.levels[level];
      const z = t ? ((value - t.mean) / t.sd).toFixed(1) : '?';
      return `${level} ${value} ${input.unit} (target ${t?.mean} ± ${t?.sd}, ${Number(z) > 0 ? '+' : ''}${z} SD)`;
    })
    .join('; ');
}

// ---------- Jira work item ----------

export interface IssueDraft {
  summary: string;
  labels: string[];
  /** Atlassian Document Format (version 1). */
  description: unknown;
}

const text = (t: string, marks?: { type: string }[]) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const heading = (level: number, t: string) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const bullets = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [para(text(i))] })),
});
const numbered = (items: string[]) => ({
  type: 'orderedList',
  content: items.map((i) => ({ type: 'listItem', content: [para(text(i))] })),
});

export function buildIssue(input: IncidentInput): IssueDraft {
  const rules = rulesOf(input);
  const types = errorTypes(input);
  const summary = `QC reject: ${input.analyte} on ${input.analyser}, ${rules.join(' + ')} (${formatTime(input.run.time)})`;
  const labels = ['qc-reject', ...types.map((t) => `${t}-error`), ...rules.map((r) => `westgard-${r.replace(/[^0-9a-z]/gi, '')}`)];
  const description = {
    type: 'doc',
    version: 1,
    content: [
      para(text('A QC run was rejected by the Westgard multirules. ', [{ type: 'strong' }]), text('Patient results for this test on this analyser must be held until the cause is fixed and QC is back in control.')),
      heading(3, 'What failed'),
      bullets([
        `Run: ${formatTime(input.run.time)} (${input.run.runId})`,
        `Control values: ${valuesText(input)}`,
        ...input.run.violations.map((v) => `${v.rule} (${ERROR_TYPE[v.rule]} error): ${v.detail}`),
      ]),
      heading(3, 'Hold'),
      para(text(holdText(input.hold), [{ type: 'strong' }])),
      para(text('Releasing held results is a human decision. Lab QC never releases them.')),
      heading(3, 'Likely causes'),
      bullets(types.flatMap((t) => LIKELY_CAUSES[t])),
      heading(3, 'Corrective action checklist'),
      numbered(CHECKLIST),
    ],
  };
  return { summary, labels, description };
}

// ---------- Confluence incident page ----------

/** Escape text for Confluence storage format (XHTML). */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface PageDraft {
  title: string;
  /** Confluence storage format. */
  body: string;
}

export function buildIncidentPage(input: IncidentInput, issueKey?: string): PageDraft {
  const rules = rulesOf(input);
  const types = errorTypes(input);
  const title = `QC incident${issueKey ? ` ${issueKey}` : ''}: ${input.analyte} on ${input.analyser}, ${formatTime(input.run.time).slice(0, 11)}`;
  const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const tasks = (items: string[]) =>
    `<ac:task-list>${items
      .map((i, n) => `<ac:task><ac:task-id>${n + 1}</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>${esc(i)}</ac:task-body></ac:task>`)
      .join('')}</ac:task-list>`;
  const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;

  const body = [
    `<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>${esc(holdText(input.hold))} Releasing them needs the sign-off at the end of this page.</p></ac:rich-text-body></ac:structured-macro>`,
    '<h2>1. Summary</h2>',
    `<table><tbody>${[
      row('Analyser', input.analyser),
      row('Test (analyte)', input.analyte),
      row('Rejected run', `${formatTime(input.run.time)} (${input.run.runId})`),
      row('Rules violated', rules.join(', ')),
      row('Error type', types.join(' and ')),
      row('Corrective-action work item', issueKey ?? 'not linked'),
    ].join('')}</tbody></table>`,
    '<h2>2. QC data</h2>',
    `<p>${esc(valuesText(input))}</p>`,
    ul(input.run.violations.map((v) => `${v.rule} (${v.scope}): ${v.detail}`)),
    '<h2>3. Patient impact</h2>',
    `<p>${esc(holdText(input.hold))}</p>`,
    '<p>Look back: an error can start before the run that detects it. If the investigation dates the cause earlier than the hold window, extend the review to results reported since then.</p>',
    '<h2>4. Investigation</h2>',
    '<p>Check the likely causes for this error type and record what was found:</p>',
    tasks(types.flatMap((t) => LIKELY_CAUSES[t])),
    '<p><strong>Root cause found:</strong> </p>',
    '<h2>5. Corrective action</h2>',
    tasks(CHECKLIST),
    '<h2>6. Verification</h2>',
    '<p><strong>Repeat QC run (time, values, verdict):</strong> </p>',
    '<h2>7. Release of held results</h2>',
    '<p>Held results are released only by an authorised scientist after QC is back in control.</p>',
    `<table><tbody>${row('Released by', '')}${row('Date and time', '')}${row('Results reviewed or rerun', '')}</tbody></table>`,
    '<h2>References</h2>',
    ul([
      'ISO 15189:2022, 7.3.7.2 Internal quality control',
      'CLSI C24, Statistical Quality Control for Quantitative Measurement Procedures',
      'Westgard JO et al., A multi-rule Shewhart chart for quality control in clinical chemistry, Clin Chem 1981',
    ]),
  ].join('\n');
  return { title, body };
}
