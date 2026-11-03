## Agent workflow (one ticket per session)

**Main agent only.** If you are a subagent, ignore this section and follow the task you were given.

Lookups: For narrow searches ("where is X defined", "who calls Y") run one-shot grep/find yourself. Use the `scout` subagent when a lookup needs several searches or would return a lot of output. In its task, say what you are looking for and why you need it. Treat any claim that something is unused or absent as unverified until you check it yourself.

You are the only agent that edits files in this repo. Subagents read and advise; they never write.

1. Plan: If the working tree is not clean, or SPEC.md or .review/ exists, stop and tell me before planning. Run the `check` tool once before changing anything; if it fails, stop and tell me, with its output. Read the relevant code and write SPEC.md (what changes, files touched, how we know it works). Stop and wait for my approval.
2. Build: implement SPEC.md. The change is done when the `check` tool passes.
  - Make the check pass by fixing the code, never by weakening, skipping or deleting existing tests. Change an existing test only if SPEC.md lists it, ask me to approve each one. If the spec and an existing test disagree, stop and tell me.
3. Review: when the check passes, run one `reviewer` subagent with fresh context.
  - Prepare: Run `git add -N` on every new file you created (so it shows up in the diff), then `mkdir -p .review && git diff HEAD > .review/diff.patch`. Overwrite this file every round.
  - The reviewer already knows how to review and how to report. Its task is: "Review the change. Spec: SPEC.md. Patch: .review/diff.patch." Add only context the spec does not make obvious. Do not paste the diff into the task.
4. Fix: apply P0 and P1 findings yourself, re-run the check, review again with a new fresh reviewer. Max 3 review rounds, then stop and report what is left.
5. Finish: summarize changed files, validation, and remaining notes. Do not merge. If I ask you to commit, delete SPEC.md and .review/ afterwards.

Never change the model mid-ticket. If pi stops you because the check keeps failing, stop and tell me unless the ticket template says otherwise; I may raise the thinking level before you continue.
