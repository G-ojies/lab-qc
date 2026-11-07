# Lab QC

Westgard quality control for clinical labs, built on Atlassian Forge for Jira, Confluence and Rovo.
Entry for Codegeist 2026 (Apps for Specialized Industries).

Every shift, a clinical lab runs quality control (QC) samples on each analyser before it reports patient results.
When a Westgard rule fires, every patient result since the last good QC run must be held, the cause fixed and the
incident documented for accreditation (ISO 15189). Lab QC does the checking, gives the hold window, and opens the
corrective action. It never releases results: that stays a human sign-off.

## Features
- **Jira page "Lab QC":** dashboard of every test on every analyser, Levey-Jennings chart in SD units, runs table
  with the rules that fired and the patient-result hold window, and a form to log a new run (checked on the server).
- **Westgard engine:** 1-2s warning; 1-3s, 2-2s, R-4s, 4-1s and 10x reject, within a run, across runs and across
  control levels.
- **One-click corrective action:** a Jira work item (rules, hold window, likely causes, 7-step checklist) and a
  linked Confluence incident page in accreditation format, created as the signed-in user.
- **QC Officer (Rovo agent)** with three actions: `check-qc-status`, `get-hold-window`, `open-corrective-action`.
- **MCP server (`rovo:mcp`) and Rovo skill** exposing the same three actions to other agents.

## Layout
- `westgard/`: the engine and document builders in TypeScript, with tests (vitest).
  `npm run build:app` compiles them into `app/src/lib/`.
- `app/`: the Forge app (`manifest.yml`, UI Kit page, resolver, Rovo actions, skill).
- `docs/`: demo video script and Devpost text.

## Develop
```sh
cd westgard && npm install && npm test && npm run build:app
cd ../app && npm install && forge deploy && forge install
```
Install the app in both Jira and Confluence. On the Lab QC page press **Load demo month**, then set the Jira
project and Confluence space under **Corrective action settings**.

## License
MIT
