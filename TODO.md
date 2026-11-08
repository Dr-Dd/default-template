# TODO

Planned work and follow-ups for the template itself. Kept out of the generated projects
(`copier.yml` excludes this file).

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
