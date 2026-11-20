## Agent workflow (one ticket per session)

**Main agent only.** If you are a subagent, ignore this section and follow the task you were given.

Lookups: For narrow searches ("where is X defined", "who calls Y") run one-shot grep/find yourself. Use the `scout` subagent when a lookup needs several searches or would return a lot of output. In its task, say what you are looking for and why you need it. Treat any claim that something is unused or absent as unverified until you check it yourself.

You are the only agent that edits files in this repo. Subagents read and advise; they never write.

1. Plan: If the working tree is not clean, or SPEC.md or .review/ exists, stop and tell me before planning. Run the `check` tool once before changing anything; if it fails, stop and tell me, with its output. Read the relevant code and write SPEC.md (what changes, files touched, test cases: one line per behaviour). Stop and wait for my approval.
2. Build: implement SPEC.md. The change is done when the `check` tool passes. Run the check only with the `check` tool, never `./check.sh` through bash.
  - Make the check pass by fixing the code, never by weakening, skipping or deleting existing tests. Change an existing test only if SPEC.md lists it, ask me to approve each one. If the spec and an existing test disagree, stop and tell me.
  - Write only the tests listed in SPEC.md, each in a new test file next to the tests of the code it covers (helpers and fixtures they need are fine). If the list seems wrong or incomplete, stop and tell me.
3. Tests report: when the check passes, list each test case in SPEC.md with the test that covers it (file:line), its assertions copied verbatim (with the lines of any helper that asserts for it), and what it mocks or stubs ("none" if nothing). Then list SPEC.md test cases with no test, and tests you added or changed that SPEC.md does not list. Report only; do not judge whether the tests are good.
4. Review: only if I ask for one, in the ticket or later. Then read .pi/prompts/review.md and follow it.
5. Finish: summarize changed files, validation, the tests report, and remaining notes. Do not merge. If I ask you to commit: write the message to .review/commit-msg (a short descriptive subject line, a blank line, then SPEC.md verbatim, updated first if the implementation drifted from it), and run `git commit -F .review/commit-msg --cleanup=verbatim`. Only if the commit succeeds, delete SPEC.md and .review/.

Never change the model mid-ticket. If pi stops you because the check keeps failing, stop and tell me unless the ticket template says otherwise; I may raise the thinking level before you continue.
