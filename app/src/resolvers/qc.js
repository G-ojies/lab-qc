// Backend for the Lab QC page. The logic lives in ../qc-core.js, shared with the Rovo agent and MCP tools.
import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { evaluateRun, holdWindow } from '../lib/westgard';
import { ANALYTES, demoResults } from '../lib/demo';
import { INDEX_KEY, MAX_RESULTS, detail, getConfig, loadAll, loadOne, openCorrectiveAction, recordKey, saveOne, setConfig, summarise } from '../qc-core';

const resolver = new Resolver();

resolver.define('getDashboard', async () => {
  const records = await loadAll();
  return { analytes: records.map(summarise) };
});

resolver.define('getAnalyte', async ({ payload }) => {
  const record = await loadOne(payload.key);
  if (!record) return { error: 'Analyte not found' };
  return detail(record);
});

/**
 * Log a new QC run: one value per control level, timestamped now. The run is evaluated against the stored
 * history and the verdict is returned straight away.
 */
resolver.define('addRun', async ({ payload }) => {
  const record = await loadOne(payload.key);
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
  await saveOne(record);
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

/** Open (or return the existing) corrective action for a rejected run. */
resolver.define('openCorrectiveAction', async ({ payload }) => {
  const record = await loadOne(payload.key);
  if (!record) return { error: 'Analyte not found' };
  return openCorrectiveAction(record, payload.runId);
});

/** Where corrective actions go: read, and save after checking the project and space exist. */
resolver.define('getConfig', () => getConfig());
resolver.define('setConfig', ({ payload }) => setConfig(payload || {}));

export const handler = resolver.getDefinitions();
