---
description: Ticket on Sonnet with an Opus advisor
model: claude-code/claude-sonnet-5-5
thinking: medium
restore: false
---
Work this ticket following the workflow in AGENTS.md.

Advisor rule: consult the `oracle` subagent at exactly these points:
- after writing SPEC.md, before asking me to approve it.
- when the same error or test failure survives two fix attempts. Consult oracle first; if it still fails after one more attempt with its advice, stop and tell me as AGENTS.md says.
Do not consult it otherwise. Launch it with forked context (it needs to see what you have seen). Ask one short, specific question, and end every oracle task with: "Answer in under 200 words: your verdict first, then the single most important reason or correction.".

Ticket:
$@
