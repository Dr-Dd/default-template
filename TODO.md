# TODO

Planned work and follow-ups for the template itself. Kept out of the generated projects
(`copier.yml` excludes this file).

## Decided against

- **Masking old tool outputs in the context** (a `context` extension that blanks tool results
  older than N steps, as in JetBrains' "The Complexity Trap", which reports ~50% savings).
  Estimated on 76 recorded pi-read sessions (41 tickets, 35 main checkout; 2026-11-13..15,
  pre-v0.19 workflow): 96-97% of input was already served from the prompt cache. Masking changes
  old messages, so the cache must be rewritten from that point (~1.25x input price) to save cache
  reads (~0.1x). Net input cost: window 10/batch 10 -7.6%, 10/20 -3.3%, 20/20 -3.8%, 5/10 -8.2%
  (negative = more expensive); only sessions of 60+ steps gained (+6-8%, 6 of 76). No session hit
  compaction (max context 330K); files re-read more than 10 steps later: 6 times in 41 tickets.
  Trimming output when it enters the context does not touch the cache: today's `check` trimming
  would have saved ~11% on the same sessions; capping `bash` output at 4K/8K/16K chars ~4.5/1.9/0.5%
  (not done: risks re-runs; revisit with logging). Revisit masking if tickets get much longer
  (60+ steps typical), sessions start compacting, or the provider's cache pricing changes (on the
  Claude subscription the quota cost of cache reads is unknown; if they count as full input, the
  gross saving at window 10 is ~17%). Scripts: `analyze.mjs`, `econ.mjs`, `atentry.mjs` in
  `/tmp/pi-test-context-masking-example/` (not kept).
- **Hiding pi-subagents' `contact_supervisor` and `subagent_supervisor` in the parent session.**
  They add ~800 chars (~200 tokens) to every request, under 1% of a ticket's input cost, and were
  called 0 times in 83 pi-read main sessions (`subagent` 130, `bg_wait` 7; `bg_wait` is needed by
  `/review`). No setting removes them (`defaultTools` `-name` has no effect, pi-subagents' config
  is global-only); a project extension editing `systemPromptOptions.selectedTools` in
  `before_agent_start` works (tested on claude-code and deepseek, `/review` unaffected) but
  depends on when pi-subagents activates its tools. Not worth it.

## tickets.sh

- **Run ticket sessions in an isolated environment.** Ticket sessions run `pi --approve` with
  arbitrary bash and can currently reach the whole home directory (ssh keys, credentials, browser
  profiles). Plan: a rootless podman container with only the worktree mounted (not distrobox,
  which shares `$HOME`), tmux inside it, and a `tickets.sh` launcher for it. To solve first:
  logins inside the container (the Claude CLI used by `pi-claude-code`; narrow git credentials,
  no personal ssh keys), getting branches out (push from the container or share the git
  directory), and each project's `check.sh` toolchain in the image. Later, the same setup could
  move to a VM or remote box.

- **Support merging through GitHub PRs.** `tickets.sh` assumes local merges (`tickets.sh merge`,
  or `git merge --no-ff` by hand). `remove` checks "merged" through git history, so it sees a
  branch merged on GitHub with squash or rebase as unmerged. When a project needs PRs, add rather
  than rewrite: a `tickets.sh pr <slug>` (`git push` + `gh pr create`; the project's CI takes the
  place of the `check.sh` run in `merge`), and a `remove` that asks GitHub whether the PR was
  merged (`gh pr view --json state`), which works for every merge style. `start`, worktrees,
  `worktree-setup.sh` and the sessions stay as they are. Detecting squash and rebase merges from
  git history (`git cherry`) was considered and rejected: it is fragile and unnecessary once
  GitHub can be asked directly.

- **Keep a test suite for `tickets.sh`.** So far every change was checked with throwaway scripts in
  temporary repos, so nothing guards against regressions. Bugs like the dotted project name
  (`my.app`: tmux read the `.` in the session name as a window separator) are only caught by a
  test that uses awkward inputs. Plan: `tests/tickets.bats`, or a plain bash script, that builds
  temporary repos (one literally named `my.app`), uses a private tmux socket (`TMUX_TMPDIR`) and
  a fake `pi` (`TICKETS_PI_CMD`), and fake `git`/`tmux` wrappers on `PATH` to inject failures.
  Cases to keep, all exercised by hand once:
  - slugs git rejects (`a..b`, `x.lock`, `x.`), a branch named `ticket`, branches under
    `ticket/<slug>/`
  - `worktree-setup.sh` missing, unconfigured, failing for one ticket (rollback of all)
  - rollback after a failed `worktree add`, after Ctrl-C, and keeping a branch with commits
  - a worktree deleted by hand but still registered
  - a shared `TICKETS_WORKTREE_DIR` used by two repos with the same name
  - a launch failing for one ticket: the rest start, the summary lists it, exit code 1
  - `remove` refusing: unmerged, dirty, `SPEC.md`/`.review/`, open tmux pane (not a sibling
    directory with a common prefix), run from inside the worktree
  - `merge`: refused under pi, dirty main, nothing to merge; a conflict is aborted; a failing
    check keeps the merge (undo with `git reset --hard ORIG_HEAD`)
  - `list`: commits since start unchanged after switching the main checkout's branch; SESSION
    `open`/`-`/`?`
  - tmux sessions get the shell's `PATH`, `BASH_ENV`, `PI_CHECK_MAX_FAILURES`, not a stale
    server's, and never check-guard's `BASH_ENV` hook

  Hook it into this repo's own check once the template has one; shellcheck too.

- **Log each `start`.** When a launch fails, the only clue is tmux's error in the terminal, which
  is gone once `/fanout` or the terminal moves on. Write a log per run, e.g.
  `$wt_root/.logs/<timestamp>.log`: the tickets, base, launcher, every git/tmux command and its
  output, and which tickets started. Keep it outside the worktrees (they are removed) and
  outside the repository; mention its path in the failure summary.

- **Enforce good guarding.** Force the default template state for guarding to halt the `AGENTS.md`;
  find a way to force the user to build and extend the default guarded paths by himself.
