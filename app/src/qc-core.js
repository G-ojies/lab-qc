// Shared Lab QC logic used by the Jira page (resolvers/qc.js) and the Rovo agent / MCP tools (agent.js).
// Each analyte (one test on one analyser) is stored in Forge Key-Value Storage as a single record holding its
// control targets and every QC result. Westgard evaluation always runs here, on the server, against the stored
// history, so a verdict cannot be edited in the browser or talked into a different answer by a prompt.
import { kvs } from '@forge/kvs';
import api, { route } from '@forge/api';
import { evaluateAll, evaluateRun, holdWindow, zScore } from './lib/westgard';
import { buildIncidentPage, buildIssue } from './lib/incident';

export const INDEX_KEY = 'qc-index';
export const recordKey = (key) => `qc-analyte-${key}`;
// Keep the newest runs only, so a record stays well inside the storage value size limit.
export const MAX_RESULTS = 400;

/** Load every analyte record listed in the index. */
export async function loadAll() {
  const keys = (await kvs.get(INDEX_KEY)) || [];
  const records = await Promise.all(keys.map((k) => kvs.get(recordKey(k))));
  return records.filter(Boolean);
}

export const loadOne = (key) => kvs.get(recordKey(key));
export const saveOne = (record) => kvs.set(recordKey(record.key), record);

/** Summarise one analyte for the dashboard: its latest verdict and how many runs are rejected. */
export function summarise(record) {
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
    latestRunId: latest ? latest.runId : null,
    latestTime: record.results.length ? record.results[record.results.length - 1].time : null,
  };
}

/** Full detail for one analyte: every run with its verdict, chart points in SD units, and hold windows. */
export function detail(record) {
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

// ---------- Corrective action: Jira work item + Confluence incident page ----------

// Where corrective actions go. Override per site by storing { projectKey, spaceKey } under this key.
export const CONFIG_KEY = 'qc-config';
export const DEFAULT_CONFIG = { projectKey: 'QC', spaceKey: 'LABQ', issueType: 'Task' };

/** Read a Jira or Confluence response, throwing a short readable error when it failed. */
async function json(res, what) {
  if (res.ok) return res.status === 204 ? null : res.json();
  const body = await res.text();
  throw new Error(`${what} failed (${res.status}): ${body.slice(0, 300)}`);
}

/** The project and space corrective actions go to (defaults merged with any saved override). */
export async function getConfig() {
  return { ...DEFAULT_CONFIG, ...((await kvs.get(CONFIG_KEY)) || {}) };
}

/**
 * Save where corrective actions go, after checking as the user that the Jira project and Confluence space exist,
 * so a typo shows up here and not halfway through opening a corrective action.
 */
export async function setConfig({ projectKey, spaceKey, issueType }) {
  const cfg = {
    projectKey: String(projectKey || '').trim().toUpperCase(),
    spaceKey: String(spaceKey || '').trim(),
    issueType: String(issueType || DEFAULT_CONFIG.issueType).trim(),
  };
  if (!cfg.projectKey || !cfg.spaceKey) return { error: 'Enter a Jira project key and a Confluence space key.' };
  try {
    const project = await json(
      await api.asUser().requestJira(route`/rest/api/3/project/${cfg.projectKey}?expand=issueTypes`),
      `Finding Jira project ${cfg.projectKey}`,
    );
    const types = (project.issueTypes || []).filter((t) => !t.subtask).map((t) => t.name);
    if (types.length && !types.includes(cfg.issueType))
      return { error: `Project ${cfg.projectKey} has no "${cfg.issueType}" work type. It has: ${types.join(', ')}.` };
    const spaces = await json(
      await api.asUser().requestConfluence(route`/wiki/api/v2/spaces?keys=${cfg.spaceKey}`),
      `Finding Confluence space ${cfg.spaceKey}`,
    );
    if (!spaces.results?.length) return { error: `Confluence space ${cfg.spaceKey} not found. Is the app installed in Confluence too?` };
  } catch (e) {
    return { error: e.message };
  }
  await kvs.set(CONFIG_KEY, cfg);
  return { config: cfg };
}

/** The incident input for one rejected run, in the shape lib/incident.js expects. */
export function incidentInput(record, runId) {
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
 * the work item and page are attributed to the scientist who asked for them. Calling it again for the same run
 * returns the existing pair instead of creating duplicates. Never releases patient results.
 */
export async function openCorrectiveAction(record, runId) {
  if (record.actions?.[runId]) return { action: record.actions[runId], existing: true };
  const input = incidentInput(record, runId);
  if (!input) return { error: 'Only a rejected run gets a corrective action.' };
  const cfg = await getConfig();

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
    record.actions = { ...(record.actions || {}), [runId]: action };
    await saveOne(record);
    return { action };
  } catch (e) {
    return { error: e.message };
  }
}
