---
description: Quick change on the standard model; no SPEC.md, review only on request (/review)
model: claude-code/claude-sonnet-5-5
thinking: medium
restore: false
---

Work this request following the workflow in AGENTS.md, with the changes below. Every stop in AGENTS.md still applies.
- Plan: do not write SPEC.md and do not wait for my approval. State in a few lines what changes, the files touched and the test cases (or "none" and why). Wherever AGENTS.md refers to SPEC.md, use this plan instead.
  Also stop and ask me if the request has more than one reasonable reading, needs changes to existing tests, or is not a quick change: more than 3 files or about 100 changed lines, a new dependency, or a change to a public API, schema or migration. Then suggest running it as a normal ticket (plain pi, no prompt).
- Tests report: as in AGENTS.md, with the plan's test cases. Also list any test or lint configuration and suppression comments the change adds or edits.
- Finish: say whether the change was reviewed, then delete .review/ if it exists.

Request:
$@
