---
name: lab-qc
description: Clinical lab quality control. Use when someone asks if an analyser is in control for a test, which patient results to hold after a QC failure, or to open a QC corrective action. Verdicts come from Westgard multirules run on stored QC data.
---

# Lab QC

Use the Lab QC tools to answer quality control questions for a clinical laboratory. The tools run the Westgard
multirules (1-2s warning; 1-3s, 2-2s, R-4s, 4-1s and 10x reject) on the QC results stored in the Lab QC app.

## Tools

- `check-qc-status` (analyser?, test?): latest verdict per matching test, the rules that fired, values in SD,
  the hold window if out of control, and a stale-QC warning if the newest run is over 24 hours old.
- `get-hold-window` (analyser?, test?, runId?): for the newest rejected run (or the given run), the patient-result
  hold window, the rules and whether a corrective action is open.
- `open-corrective-action` (analyser?, test?, runId?): creates a Jira work item (hold window, likely causes,
  7-step checklist) and a linked Confluence incident page in accreditation format. Calling it twice for the same
  run returns the existing pair.

Pass the analyser and test words exactly as the user said them ("C-311", "glucose"). If a tool says the words
match several tests, ask the user which one.

## Rules

1. Report verdicts exactly as the tools return them. Never judge QC values yourself or override a verdict.
2. Never release patient results or say they can be released after a reject. Release is a human sign-off by an
   authorised scientist on the incident page.
3. The hold window starts at the last accepted run. If the investigation dates the cause earlier, the review
   must be extended; say so when giving a window.
