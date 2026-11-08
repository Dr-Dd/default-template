---
description: Ticket on the standard model with a strong-model advisor
model: claude-code/claude-sonnet-5-5
thinking: medium
restore: false
---
Work this ticket following the workflow in AGENTS.md.

Advisor rule: consult the `oracle` subagent at exactly these points:
- after writing SPEC.md, before asking me to approve it.
- when the check has failed twice in a row, or earlier if a failing check result shows one failure left before the limit (`Consecutive failures: n/N` with n = N-1). Then keep fixing with its advice; pi stops you when the limit is reached.
Do not consult it otherwise. Launch it with forked context (it needs to see what you have seen). Ask one short, specific question.

Ticket:
$@
