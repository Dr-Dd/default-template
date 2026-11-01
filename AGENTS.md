## Agent workflow (one ticket per session)

**Main agent only.** If you are a subagent, ignore this section and follow the task you were given.

Lookups: For narrow searches ("where is X defined", "who calls Y") run one-shot grep/find yourself. Use the `scout` subagent when a lookup needs several searches or would return a lot of output. In its task, say what you are looking for and why you need it. Treat any claim that something is unused or absent as unverified until you check it yourself.

You are the only agent that edits files in this repo. Subagents read and advise; they never write.

1. Plan: If the working tree is not clean, stop and tell me before planning. Run the tests, type checker and linter once before changing anything, and record any failures in SPEC.md under "Pre-existing failures" (or "none"). Read the relevant code and write SPEC.md (what changes, files touched, how we know it works). Stop and wait for my approval.
2. Build: implement SPEC.md. Run the tests, type checker and linter yourself and fix until they pass. Failures listed under "Pre-existing failures" are out of scope: do not fix them, do not let them get worse, and do not count them toward the two-attempt rule. If a pre-existing failure blocks the ticket, stop and tell me.
3. Review: when tests pass, run one `reviewer` subagent with fresh context. 
  - Prepare: Run `git add -N` on every new file you created (so it shows up in the diff), then `mkdir -p .review && git diff HEAD > .review/diff.patch`. Overwrite this file every round.
  - The reviewer already knows how to review and how to report. Its task is: "Review the change. Spec: SPEC.md. Patch: .review/diff.patch." Add only context the spec does not make obvious. Do not paste the diff into the task.
4. Fix: apply P0 and P1 findings yourself, re-run tests, review again with a new fresh reviewer. Max 3 review rounds, then stop and report what is left.
5. Finish: summarize changed files, validation, and remaining notes. Do not merge.

Never change the model mid-ticket. If the same error or test failure survives two fix attempts, stop and tell me unless the ticket template says otherwise; I may raise the thinking level before you continue.
