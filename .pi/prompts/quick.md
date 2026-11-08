---
description: Quick change on the standard model; no SPEC.md, review only on request
model: claude-code/claude-sonnet-5-5
thinking: medium
restore: false
---
Work this request following the workflow in AGENTS.md, with these changes. Do not consult `oracle`.

- Plan: do not write SPEC.md and do not wait for my approval. State in a few lines what changes, the files touched and the test cases. Wherever AGENTS.md refers to SPEC.md, use this plan instead. Stop and ask me only if the request has more than one reasonable reading, needs changes to existing tests, or has grown past a quick change (then suggest /solo or /advised).
- Review: skip it unless I ask for one, in the request or after your summary. If I do, write the plan as built to .review/spec.md and pass that as the spec instead of SPEC.md. One round only; run another only if I ask.
- Finish: say whether the change was reviewed. After a successful commit, delete .review/.

Request:
$@
