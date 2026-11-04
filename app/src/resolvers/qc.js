// Backend for the Lab QC page. Each analyte (one test on one analyser) is stored in Forge Key-Value Storage as
// a single record holding its control targets and every QC result. Westgard evaluation always runs here, on the
// server, against the stored history, so the verdict a bench scientist sees cannot be edited in the browser.
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { evaluateAll, evaluateRun, holdWindow, zScore } from '../lib/westgard';
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

export const handler = resolver.getDefinitions();
