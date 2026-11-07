// Lab QC page (Jira global page, UI Kit).
//
// The page has two parts:
//   1. A dashboard table with one row per analyte (one test on one analyser) and its latest Westgard verdict.
//   2. The detail of the analyte you pick: a Levey-Jennings chart in SD units, the list of runs with the rules
//      that fired, the patient-result window to hold for every rejected run, and a form to log a new run.
//
// All Westgard evaluation happens in the backend resolver (src/resolvers/qc.js). The page only displays what the
// resolver returns, so a verdict cannot be changed in the browser.
import React, { useEffect, useRef, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  EmptyState,
  Form,
  FormFooter,
  FormSection,
  Heading,
  Inline,
  Label,
  LineChart,
  Link,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Textfield,
  useForm,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// How each verdict looks. Lozenge appearances come from the Atlassian design system.
const STATUS = {
  accept: { label: 'In control', appearance: 'success' },
  warning: { label: 'Warning', appearance: 'moved' },
  reject: { label: 'Rejected', appearance: 'removed' },
  none: { label: 'No runs', appearance: 'default' },
};

// Flat reference lines drawn on every Levey-Jennings chart, in SD units.
const LIMITS = [
  { name: '+3 SD', sd: 3 },
  { name: '+2 SD', sd: 2 },
  { name: 'Mean', sd: 0 },
  { name: '-2 SD', sd: -2 },
  { name: '-3 SD', sd: -3 },
];

/** Format an ISO time as "04 Nov 08:00" (UTC), short enough for a table cell. */
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${day} ${mon} ${iso.slice(11, 16)}`;
}

function StatusLozenge({ status }) {
  const s = STATUS[status] || STATUS.none;
  return <Lozenge appearance={s.appearance}>{s.label}</Lozenge>;
}

/**
 * Build the chart rows: one point per control result (series = control level) plus the five limit lines.
 * Every series uses the same x values (the run day), so the chart lines up.
 */
function chartRows(detail) {
  const days = [...new Set(detail.chart.map((p) => p.day))];
  const limitRows = LIMITS.flatMap((l) => days.map((day) => ({ day, sd: l.sd, series: l.name })));
  const pointRows = detail.chart.map((p) => ({ day: p.day, sd: p.sd, series: p.level }));
  return [...limitRows, ...pointRows];
}

/** Colours: limit lines in red (3 SD), amber (2 SD) and grey (mean); control levels in blue and purple. */
function chartPalette(detail) {
  const levelNames = [...new Set(detail.chart.map((p) => p.level))];
  return [
    { key: '+3 SD', value: '#C9372C' },
    { key: '-3 SD', value: '#C9372C' },
    { key: '+2 SD', value: '#E2B203' },
    { key: '-2 SD', value: '#E2B203' },
    { key: 'Mean', value: '#8590A2' },
    ...levelNames.map((name, i) => ({ key: name, value: i === 0 ? '#1D7AFC' : '#8F7EE7' })),
  ];
}

/** One-line description of what fired in a run, e.g. "4-1s: last 4 L1 results all on the high side". */
function ruleText(run) {
  if (!run.violations.length) return '';
  return run.violations.map((v) => `${v.rule}: ${v.detail}`).join('; ');
}

/**
 * Corrective action for one rejected run: links to the Jira work item and Confluence incident page once they
 * exist, otherwise a button that opens both (as the signed-in user).
 */
function CorrectiveAction({ analyteKey, runId, action, onOpened }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [opened, setOpened] = useState(action);

  if (opened) {
    return (
      <Inline space="space.100">
        <Link href={opened.issueUrl} openNewTab>{opened.issueKey}</Link>
        <Link href={opened.pageUrl} openNewTab>Incident page</Link>
      </Inline>
    );
  }
  const openIt = async () => {
    setBusy(true);
    setError(null);
    const res = await invoke('openCorrectiveAction', { key: analyteKey, runId });
    setBusy(false);
    if (res.error) setError(res.error);
    else {
      setOpened(res.action);
      if (onOpened) onOpened();
    }
  };
  return (
    <Stack space="space.050">
      <LoadingButton appearance="warning" isLoading={busy} onClick={openIt}>
        Open corrective action
      </LoadingButton>
      {error && <Text>{error}</Text>}
    </Stack>
  );
}

function Dashboard({ analytes, onOpen, selectedKey }) {
  const head = {
    cells: [
      { key: 'analyser', content: 'Analyser' },
      { key: 'analyte', content: 'Analyte' },
      { key: 'status', content: 'Latest run' },
      { key: 'rules', content: 'Rules on latest run' },
      { key: 'rejects', content: 'Rejected runs' },
      { key: 'open', content: '' },
    ],
  };
  const rows = analytes.map((a) => ({
    key: a.key,
    cells: [
      { key: 'analyser', content: a.analyser },
      { key: 'analyte', content: a.analyte },
      { key: 'status', content: <StatusLozenge status={a.latestStatus} /> },
      { key: 'rules', content: a.latestRules.join(', ') || 'none' },
      { key: 'rejects', content: `${a.rejects} of ${a.runs}` },
      {
        key: 'open',
        content: (
          <Button appearance={a.key === selectedKey ? 'primary' : 'default'} onClick={() => onOpen(a.key)}>
            {a.key === selectedKey ? 'Showing' : 'Open chart'}
          </Button>
        ),
      },
    ],
  }));
  return <DynamicTable caption="Analytes under QC" head={head} rows={rows} />;
}

function RunsTable({ detail, onChanged }) {
  const levels = Object.keys(detail.levels);
  const head = {
    cells: [
      { key: 'time', content: 'Run (UTC)' },
      ...levels.map((l) => ({ key: l, content: `${l} (${detail.unit})` })),
      { key: 'status', content: 'Verdict' },
      { key: 'rules', content: 'Rules fired' },
      { key: 'hold', content: 'Hold patient results' },
      { key: 'action', content: 'Corrective action' },
    ],
  };
  const rows = detail.runs.map((run) => ({
    key: run.runId,
    cells: [
      { key: 'time', content: when(run.time) },
      ...levels.map((l) => ({ key: l, content: String(run.values[l] ?? '') })),
      { key: 'status', content: <StatusLozenge status={run.status} /> },
      { key: 'rules', content: ruleText(run) },
      {
        key: 'hold',
        content: run.hold ? `${run.hold.from ? when(run.hold.from) : 'start of record'} to ${when(run.hold.to)}` : '',
      },
      {
        key: 'action',
        content:
          run.status === 'reject' ? (
            <CorrectiveAction analyteKey={detail.key} runId={run.runId} action={run.action} onOpened={onChanged} />
          ) : (
            ''
          ),
      },
    ],
  }));
  return <DynamicTable caption="Runs, newest first" head={head} rows={rows} rowsPerPage={10} />;
}

function AddRunForm({ detail, onAdded }) {
  // Forge's useForm has no reset(); the values stay in the fields after logging, which also shows what was entered.
  const { handleSubmit, register, getFieldId } = useForm();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async (values) => {
    setBusy(true);
    const res = await invoke('addRun', { key: detail.key, values });
    setBusy(false);
    setResult(res);
    if (!res.error) onAdded();
  };

  return (
    <Form onSubmit={handleSubmit(submit)}>
      <FormSection>
        <Inline space="space.200" alignBlock="end">
          {Object.entries(detail.levels).map(([level, t]) => (
            <Box key={level}>
              <Label labelFor={getFieldId(level)}>{`${level} (target ${t.mean} ± ${t.sd} ${detail.unit})`}</Label>
              <Textfield id={level} {...register(level, { required: true })} />
            </Box>
          ))}
        </Inline>
      </FormSection>
      <FormFooter align="start">
        <LoadingButton appearance="primary" type="submit" isLoading={busy}>
          Log run and check
        </LoadingButton>
      </FormFooter>
      {result && result.error && <SectionMessage appearance="error"><Text>{result.error}</Text></SectionMessage>}
      {result && result.verdict && (
        <SectionMessage
          appearance={result.verdict.status === 'reject' ? 'error' : result.verdict.status === 'warning' ? 'warning' : 'success'}
          title={STATUS[result.verdict.status].label}
        >
          <Text>{result.verdict.violations.map((v) => `${v.rule}: ${v.detail}`).join('; ') || 'No Westgard rule fired.'}</Text>
          {result.hold && (
            <Text>{`Hold patient results reported from ${result.hold.from ? when(result.hold.from) : 'the start of the record'} to ${when(result.hold.to)}. Release stays a human decision.`}</Text>
          )}
          {result.verdict.status === 'reject' && (
            <CorrectiveAction analyteKey={detail.key} runId={result.verdict.runId} action={null} onOpened={onAdded} />
          )}
        </SectionMessage>
      )}
    </Form>
  );
}

function AnalyteDetail({ detail, onAdded }) {
  const rejected = detail.runs.filter((r) => r.status === 'reject');
  const subtitle = rejected.length
    ? `${rejected.length} rejected run(s): ${[...new Set(rejected.flatMap((r) => r.violations.map((v) => v.rule)))].join(', ')}`
    : 'No rejected runs';
  return (
    <Stack space="space.300">
      <Inline space="space.100" alignBlock="center">
        <Heading size="medium">{`${detail.analyte} on ${detail.analyser}`}</Heading>
        <StatusLozenge status={detail.latestStatus} />
      </Inline>
      <LineChart
        data={chartRows(detail)}
        xAccessor="day"
        yAccessor="sd"
        colorAccessor="series"
        title="Levey-Jennings chart (SD from target)"
        subtitle={subtitle}
        colorPalette={chartPalette(detail)}
        height={360}
      />
      <Heading size="small">Log a QC run</Heading>
      <AddRunForm detail={detail} onAdded={onAdded} />
      <RunsTable detail={detail} onChanged={onAdded} />
    </Stack>
  );
}

const App = () => {
  const [dashboard, setDashboard] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [seeding, setSeeding] = useState(false);
  // The analyte the user asked for most recently. A slow response for an earlier pick is dropped, so the chart
  // never shows a different analyte from the one highlighted in the table.
  const wanted = useRef(null);

  const loadDashboard = async () => {
    const d = await invoke('getDashboard');
    setDashboard(d);
    return d;
  };

  const open = async (key) => {
    wanted.current = key;
    setSelected(key);
    setDetail(null);
    const d = await invoke('getAnalyte', { key });
    if (wanted.current === key) setDetail(d);
  };

  // On first load, open the first analyte that has a rejected latest run, else the first one.
  useEffect(() => {
    loadDashboard().then((d) => {
      const first = d.analytes.find((a) => a.latestStatus === 'reject') || d.analytes[0];
      if (first) open(first.key);
    });
  }, []);

  const seed = async () => {
    setSeeding(true);
    await invoke('seedDemo');
    setSeeding(false);
    const d = await loadDashboard();
    const first = d.analytes.find((a) => a.latestStatus === 'reject') || d.analytes[0];
    if (first) open(first.key);
  };

  // After a new run is logged: reload the table and the chart of that analyte, keeping it on screen meanwhile.
  const refresh = async (key) => {
    const [, d] = await Promise.all([loadDashboard(), invoke('getAnalyte', { key })]);
    if (wanted.current === key) setDetail(d);
  };

  if (!dashboard) return <Spinner label="Loading QC data" />;

  return (
    <Stack space="space.300">
      <Heading size="large">Lab QC</Heading>
      <Text>
        Internal quality control for each analyser, checked against the Westgard multirules (1-2s warning; 1-3s,
        2-2s, R-4s, 4-1s and 10x reject). A rejected run shows which patient results to hold. Releasing them stays
        a human decision.
      </Text>
      {dashboard.analytes.length === 0 ? (
        <EmptyState
          header="No QC data yet"
          description="Load a demo month: three analysers, six analytes, two control levels, with real-world faults planted."
          primaryAction={
            <LoadingButton appearance="primary" isLoading={seeding} onClick={seed}>
              Load demo month
            </LoadingButton>
          }
        />
      ) : (
        <Stack space="space.300">
          <Dashboard analytes={dashboard.analytes} onOpen={open} selectedKey={selected} />
          {selected && !detail && <Spinner label="Loading chart" />}
          {detail && detail.error && <SectionMessage appearance="error"><Text>{detail.error}</Text></SectionMessage>}
          {detail && !detail.error && <AnalyteDetail detail={detail} onAdded={() => refresh(detail.key)} />}
          <Inline>
            <LoadingButton appearance="subtle" isLoading={seeding} onClick={seed}>
              Reset to demo month
            </LoadingButton>
          </Inline>
        </Stack>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
