---
description: Quick change on the standard model; no SPEC.md, review only on request
model: claude-code/claude-sonnet-5-5
thinking: medium
restore: false
---

Work this request following the workflow in AGENTS.md, with the changes below. Every stop in AGENTS.md still applies. Do not consult `oracle`.
- Plan: do not write SPEC.md and do not wait for my approval. State in a few lines what changes, the files touched and the test cases (or "none" and why). Wherever AGENTS.md refers to SPEC.md, use this plan instead.
  Also stop and ask me if the request has more than one reasonable reading, needs changes to existing tests, or is not a quick change: more than 3 files or about 100 changed lines, a new dependency, or a change to a public API, schema or migration. Then suggest /solo or /advised.
- Review: skip it unless I ask for one (in the request or after your summary), or unless the change adds or edits tests, test or lint configuration, or suppression comments. To review, prepare the patch as in AGENTS.md step 3, then run one fresh `reviewer` with this task: "Review the change. Patch: .review/diff.patch. There is no SPEC.md: the plan below replaces it, including its list of test cases. Report anything in the patch the plan does not describe." Follow it with the plan exactly as you first stated it. One round: apply findings, re-run the check, and run another round only if I ask.
- Finish: say whether the change was reviewed, then delete .review/.

Request:
$@
