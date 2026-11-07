// Rovo actions for the "QC Officer" agent. The same actions are exposed as MCP tools (rovo:mcp) and used by
// the lab-qc skill. Each one reads the stored QC data and answers from the Westgard engine, so the agent can
// only repeat what the rules decided. None of them releases patient results.
import { loadAll, openCorrectiveAction } from './qc-core';
import { holdReport, pickRejectedRun, statusReport } from './lib/agent';

const query = (p = {}) => ({ analyser: p.analyser || undefined, test: p.test || undefined, runId: p.runId || undefined });

/** "Is analyser C-311 OK for cholesterol this morning?" */
export async function checkQcStatus(payload) {
  const records = await loadAll();
  if (!records.length) return 'No QC data yet. Open Lab QC in Jira and log a run (or load the demo month).';
  return statusReport(records, query(payload));
}

/** "Which patient results do I hold for the glucose reject?" */
export async function getHoldWindow(payload) {
  const pick = pickRejectedRun(await loadAll(), query(payload));
  if ('error' in pick) return pick.error;
  return holdReport(pick.record, pick.runId);
}

/** "Open a corrective action for it." Creates the Jira work item and Confluence incident page as the user. */
export async function openCorrectiveActionAction(payload) {
  const pick = pickRejectedRun(await loadAll(), query(payload));
  if ('error' in pick) return pick.error;
  const { record, runId } = pick;
  const res = await openCorrectiveAction(record, runId);
  if (res.error) return `Could not open the corrective action: ${res.error}`;
  const a = res.action;
  return [
    `${res.existing ? 'A corrective action was already open' : 'Opened the corrective action'} for ${record.analyte} on ${record.analyser} (run ${runId}).`,
    `Jira work item: ${a.issueKey} ${a.issueUrl}`,
    `Confluence incident page: ${a.pageUrl}`,
    'Patient results stay on hold until an authorised scientist signs the release section of the incident page.',
  ].join('\n');
}
