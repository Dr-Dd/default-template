---
description: Discuss choices for the current ticket (no build/test/review workflow)
model: claude-code/claude-opus-5-5
thinking: high
restore: false
---
This is a discussion, not a ticket. Do not follow the numbered workflow in AGENTS.md (Plan, Build, Review, Fix, Finish). In particular:
- do not check that the working tree is clean
- do not run the check
- do not run `reviewer` or consult `oracle`
- do not regenerate .review/diff.patch or run `git add -N`

The lookup rules in AGENTS.md still apply, so use `scout` for lookups that need several searches.

Context: read SPEC.md and .review/diff.patch if they exist, and the code they touch when the question needs it. The patch may be older than the working tree. If that matters, check `git diff HEAD` and do not overwrite the patch.

Do not edit files. If we reach a decision and I ask you to record it, update SPEC.md only.

How to answer:
- Lay out the realistic options, with the trade-offs that actually matter here. Cite code as path:line.
- Give your recommendation and the main reason for it. Say what would change your mind.
- If the question is underspecified, ask me before going deep.
- Keep it short. I will ask follow-ups.

Topic:
$@
