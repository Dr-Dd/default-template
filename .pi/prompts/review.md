---
description: Review the current change with a fresh reviewer subagent; apply P0/P1 findings
---
Review the current change. The rest of the workflow in AGENTS.md still applies.

1. Prepare: run `git add -N` on every new file you created (so it shows up in the diff), then `mkdir -p .review && git diff HEAD > .review/diff.patch`. Overwrite this file every round.
2. Run one `reviewer` subagent with fresh context. It already knows how to review and how to report. Do not paste the diff into the task; add only context the spec does not make obvious.
  - With SPEC.md, its task is: "Review the change. Spec: SPEC.md. Patch: .review/diff.patch."
  - Without SPEC.md (a /quick change), its task is: "Review the change. Patch: .review/diff.patch. There is no SPEC.md: the plan below replaces it, including its list of test cases. Report anything in the patch the plan does not describe." Follow it with the plan exactly as you first stated it.
3. Fix: apply P0 and P1 findings yourself, re-run the `check` tool, and review again with a new fresh reviewer. Max 3 review rounds, then stop and report what is left. For a /quick change, run one round only, and another only if I ask.
4. Report the findings, what you fixed, and an updated tests report if the tests changed.

Notes:
$@
