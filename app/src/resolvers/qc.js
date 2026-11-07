// Backend for the Lab QC page. Each analyte (one test on one analyser) is stored in Forge Key-Value Storage as
// a single record holding its control targets and every QC result. Westgard evaluation always runs here, on the
// server, against the stored history, so the verdict a bench scientist sees cannot be edited in the browser.
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import api, { route } from '@forge/api';
import { evaluateAll, evaluateRun, holdWindow, zScore } from '../lib/westgard';
import { buildIncidentPage, buildIssue } from '../lib/incident';
import { ANALYTES, demoResults } from '../lib/demo';

const INDEX_KEY = 'qc-index';
const recordKey = (key) => `qc-analyte-${key}`;
// Keep the newest runs only, so a record stays well inside the storage value size limit.
const MAX_RESULTS = 400;

/** Load every analyte record listed in the index. */
async function loadAll() {
  const keys = (await kvs.get(INDEX_KEY)) || [];
  const records = await Promise.all(keys.map((k) => kvs.get(recordKey(k))));
  return records.filter(Boolean);
}

/** Summarise one analyte for the dashboard: its latest verdict and how many runs are rejected. */
function summarise(record) {
  const verdicts = evaluateAll(record.results);
  const latest = verdicts[verdicts.length - 1] || null;
  return {
    key: record.key,
    analyser: record.analyser,
    analyte: record.analyte,
    unit: record.unit,
    runs: verdicts.length,
    rejects: verdicts.filter((v) => v.status === 'reject').length,
    latestStatus: latest ? latest.status : 'none',
    latestRules: latest ? [...new Set(latest.violations.map((v) => v.rule))] : [],
    latestTime: record.results.length ? record.results[record.results.length - 1].time : null,
  };
}

/** Full detail for one analyte: every run with its verdict, chart points in SD units, and hold windows. */
function detail(record) {
  const verdicts = evaluateAll(record.results);
  const byRun = new Map(verdicts.map((v) => [v.runId, v]));
  const runs = [...new Map(record.results.map((r) => [r.runId, r.time])).entries()].map(([runId, time]) => {
    const v = byRun.get(runId);
    const values = Object.fromEntries(record.results.filter((r) => r.runId === runId).map((r) => [r.level, r.value]));
    return {
      runId,
      time,
      values,
      status: v.status,
      violations: v.violations,
      hold: v.status === 'reject' ? holdWindow(record.results, runId) : null,
      action: record.actions?.[runId] ?? null,
    };
  });
  // One point per control result, in SD units, so both levels share one Levey-Jennings chart.
  const chart = record.results.map((r) => ({
    day: r.time.slice(5, 10),
    sd: Number(zScore(r).toFixed(2)),
    level: `${r.level} (target ${r.mean} ± ${r.sd} ${record.unit})`,
  }));
  return { ...summarise(record), levels: record.levels, runs: runs.reverse(), chart };
}

const resolver = new Resolver();

resolver.define('getDashboard', async () => {
  const records = await loadAll();
  return { analytes: records.map(summarise) };
});

resolver.define('getAnalyte', async ({ payload }) => {
  const record = await kvs.get(recordKey(payload.key));
  if (!record) return { error: 'Analyte not found' };
  return detail(record);
});

/**
 * Log a new QC run: one value per control level, timestamped now. The run is evaluated against the stored
 * history and the verdict is returned straight away.
 */
resolver.define('addRun', async ({ payload }) => {
  const record = await kvs.get(recordKey(payload.key));
  if (!record) return { error: 'Analyte not found' };
  const time = new Date().toISOString();
  const runId = `${record.key}-${Date.now()}`;
  const added = [];
  for (const [level, target] of Object.entries(record.levels)) {
    const value = Number(payload.values?.[level]);
    if (!Number.isFinite(value)) return { error: `Enter a number for ${level}` };
    added.push({ id: `${runId}-${level}`, runId, time, level, mean: target.mean, sd: target.sd, value });
  }
  record.results = [...record.results, ...added].slice(-MAX_RESULTS);
  await kvs.set(recordKey(record.key), record);
  const verdict = evaluateRun(record.results, runId);
  return { verdict, hold: verdict.status === 'reject' ? holdWindow(record.results, runId) : null };
});

/** Replace all QC data with the demo month (three analysers, six analytes, planted errors). */
resolver.define('seedDemo', async () => {
  const now = new Date();
  for (const spec of ANALYTES) {
    const { plant, ...meta } = spec;
    await kvs.set(recordKey(spec.key), { ...meta, results: demoResults(spec, 30, now) });
  }
  await kvs.set(INDEX_KEY, ANALYTES.map((a) => a.key));
  return { seeded: ANALYTES.length };
});

// ---------- Corrective action: Jira work item + Confluence incident page ----------

// Where corrective actions go. Override per site by storing { projectKey, spaceKey } under this key.
const CONFIG_KEY = 'qc-config';
const DEFAULT_CONFIG = { projectKey: 'QC', spaceKey: 'LABQ', issueType: 'Task' };

/** Read a Jira or Confluence response, throwing a short readable error when it failed. */
async function json(res, what) {
  if (res.ok) return res.status === 204 ? null : res.json();
  const body = await res.text();
  throw new Error(`${what} failed (${res.status}): ${body.slice(0, 300)}`);
}

/** The incident input for one rejected run, in the shape lib/incident.js expects. */
function incidentInput(record, runId) {
  const mine = record.results.filter((r) => r.runId === runId);
  if (!mine.length) return null;
  const verdict = evaluateRun(record.results, runId);
  if (verdict.status !== 'reject') return null;
  return {
    analyser: record.analyser,
    analyte: record.analyte,
    unit: record.unit,
    levels: record.levels,
    run: {
      runId,
      time: mine[0].time,
      values: Object.fromEntries(mine.map((r) => [r.level, r.value])),
      violations: verdict.violations,
    },
    hold: holdWindow(record.results, runId),
  };
}

/**
 * Open the corrective action for a rejected run: a Jira work item with the hold window and checklist, and a
 * Confluence incident page in the accreditation format, linked to each other. Runs as the signed-in user, so
 * the work item and page are attributed to the scientist who opened them. Calling it again for the same run
 * returns the existing pair instead of creating duplicates.
 */
resolver.define('openCorrectiveAction', async ({ payload }) => {
  const record = await kvs.get(recordKey(payload.key));
  if (!record) return { error: 'Analyte not found' };
  if (record.actions?.[payload.runId]) return { action: record.actions[payload.runId], existing: true };
  const input = incidentInput(record, payload.runId);
  if (!input) return { error: 'Only a rejected run gets a corrective action.' };
  const cfg = { ...DEFAULT_CONFIG, ...((await kvs.get(CONFIG_KEY)) || {}) };

  try {
    const { baseUrl } = await json(await api.asUser().requestJira(route`/rest/api/3/serverInfo`), 'Reading the Jira site');

    const draft = buildIssue(input);
    const issue = await json(
      await api.asUser().requestJira(route`/rest/api/3/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          fields: {
            project: { key: cfg.projectKey },
            issuetype: { name: cfg.issueType },
            summary: draft.summary,
            labels: draft.labels,
            description: draft.description,
          },
        }),
      }),
      `Creating the work item in Jira project ${cfg.projectKey}`,
    );
    const issueUrl = `${baseUrl}/browse/${issue.key}`;

    const spaces = await json(
      await api.asUser().requestConfluence(route`/wiki/api/v2/spaces?keys=${cfg.spaceKey}`),
      `Finding Confluence space ${cfg.spaceKey}`,
    );
    const space = spaces.results?.[0];
    if (!space) throw new Error(`Confluence space ${cfg.spaceKey} not found`);
    const pageDraft = buildIncidentPage(input, issue.key);
    const page = await json(
      await api.asUser().requestConfluence(route`/wiki/api/v2/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          spaceId: space.id,
          status: 'current',
          title: pageDraft.title,
          body: { representation: 'storage', value: pageDraft.body },
        }),
      }),
      'Creating the Confluence incident page',
    );
    const pageUrl = `${baseUrl}/wiki${page._links.webui}`;

    // Link the page from the work item so either one leads to the other.
    await json(
      await api.asUser().requestJira(route`/rest/api/3/issue/${issue.key}/remotelink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ object: { url: pageUrl, title: pageDraft.title } }),
      }),
      'Linking the incident page to the work item',
    );

    const action = { issueKey: issue.key, issueUrl, pageId: page.id, pageUrl, openedAt: new Date().toISOString() };
    record.actions = { ...(record.actions || {}), [payload.runId]: action };
    await kvs.set(recordKey(record.key), record);
    return { action };
  } catch (e) {
    return { error: e.message };
  }
});

export const handler = resolver.getDefinitions();
