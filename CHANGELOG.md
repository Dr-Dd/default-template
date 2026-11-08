# Changelog

Releases follow [semver](https://semver.org) (see Versioning in README.md). The project is
pre-1.0: anything may change in any release, and breaking changes bump the minor version.

The tags `v1`...`v15.0.0` were deleted and numbering restarted at 0.15.0. The entries below
`v0.15.0` keep the old numbering of the deleted tags and are history only.

## Unreleased

### Breaking

- check-guard: the `subagent` tool is allowlisted instead of blocklisted. Only the actions
  `status`, `interrupt`, `stop`, `list`, `get` and `guide` are allowed; all others (including
  `resume`, schedules and agent management) are blocked. A direct launch may only start `scout`,
  `reviewer` or `oracle`, one per call (`workflow`, `tasks` and `chain` are blocked). Projects
  with their own agents must add them to `ALLOW_SUBAGENT_AGENTS` in the extension. This replaces
  the agent-management blocklist and launch gating of v0.15.0: allowed actions skip the gate,
  launches keep it.

### Added

- check-guard: `Shift+A` also applies the multi-file approval dialog, like `Shift+Enter`.
- check-guard: `vulnerableFiles` in `.pi/check-guard.json` (default `.pi/npm`, `.pi/git`): globs
  that are not guarded at all, even when `strictFiles` or `guardedFiles` match them. The config
  and the extension cannot be exempted.
- `check.sh`: new `guarded-files` step that fails while `guardedFiles` in `.pi/check-guard.json`
  is missing or empty, so a project has to list its tests and fixtures. Existing projects with
  their own `check.sh` are unaffected; `copier update` does not overwrite it.

## v0.15.0 (2026-11-08)

### Breaking

- check-guard: new `strictFiles` list in `.pi/check-guard.json`. Strict files are always protected
  and need approval even to be created. `guardedFiles` now means only the soft level: protected
  once committed, new files free, whatever the pattern (a literal name like `check.sh` no longer
  makes it strict). `strictFiles` defaults to `check.sh`, `worktree-setup.sh`, `AGENTS.md`,
  `.pi/settings.json`, `.pi/agents/**` and `.pi/prompts/**`; `guardedFiles` defaults to empty.
  A new file under `.pi/agents/**` or `.pi/prompts/**` now needs approval. Move those entries
  from your `guardedFiles` to `strictFiles` yourself (`copier update` keeps your config).

### Changed

- check-guard: blocks the `subagent` tool's agent-management actions (`create`, `update`, `delete`,
  `eject`, `disable`, `enable`, `reset`, `refine`, `refine.rollback`). They wrote agent files
  without the approval dialog.
- check-guard: a `subagent` call that may start children (anything but status, list, guide and
  similar) first checks the guarded files against the baseline, like the `check` tool, and is
  refused if changes were reverted. It must also be the only tool call of its message, so a
  `bash` edit cannot land after the check, while the child starts.

## Old v15.0.0 (2026-11-08)

### Breaking

- `tickets.sh start` runs the new `worktree-setup.sh` in each new worktree and refuses to run
  until it is configured, like `check.sh`. Copy it from the template (`copier update` adds it),
  replace its `not_configured` line with what a worktree needs (installed dependencies, `.env`,
  ...), or delete the line if it needs nothing.
- check-guard: `worktree-setup.sh` is guarded by default. `copier update` does not overwrite an
  existing `.pi/check-guard.json`: add it to its `guardedFiles` yourself.
- check-guard: a file named explicitly in `guardedFiles` (no glob syntax, e.g. `check.sh`) now
  needs approval even to be created, like the config. Files matched only by a wildcard
  (`tests/**`) stay free to create until committed, as before.

### Added

- `tickets.sh merge <slug>`: merges a ticket with `--no-ff` into the main checkout's current
  branch, runs `check.sh` on the result and removes the ticket if it passes. Aborts on conflicts;
  keeps the merge (undo: `git reset --hard ORIG_HEAD`) if the check fails. Refuses under pi.
- check-guard: `checkTimeoutSeconds` in `.pi/check-guard.json` (default 600, 0 turns it off). A
  `check` run that takes longer is stopped, along with every process `check.sh` started, and counts
  as a failing check. Before, a hanging check ran forever.
- `models.sh`: list or switch the models of `.pi/settings.json`, the prompts and the agents by role
  (`strong`, `standard`, `fast`) instead of editing eight files.
- `/quick`: small changes on the standard model. It follows AGENTS.md but writes no `SPEC.md`
  and does not stop for approval (it states a short plan instead); the review runs only if you ask
  for one, with the plan in `.review/spec.md` as the spec.

### Changed

- check-guard: unapproved changes found at one time are shown in a single dialog instead of one
  dialog per file. For several files it lists their paths: Enter toggles a file between keep and
  discard, Tab shows or hides its diff, Shift+V keeps all, Shift+X discards all, Shift+Enter applies once
  every file is decided.
- `/solo` and `/advised` descriptions name model roles (strong, standard) instead of Opus and
  Sonnet.
- check-guard: unknown keys in `.pi/check-guard.json` show a warning instead of being silently
  ignored. A config that is not a JSON object also warns.

### Fixed

- check-guard: running `check.sh` through bash is now also stopped when `check.sh` starts, not only
  when the command text matches. Every bash command runs with `BASH_ENV` set to the new
  `.pi/extensions/check-guard/bash-env.sh`, which exits bash if the script is `check.sh` or a copy
  of it. This catches `make check`, `xargs`, `find -exec`, symlinks and subprocesses. The pattern
  also matches `nice`, `eval`, `xargs`, `setsid` and wrappers given by path (`/usr/bin/env`).
  Deliberate dodges (clearing `BASH_ENV`, `cat check.sh | bash`) still work; see "Running
  check.sh" in README.md.
- check-guard: `guardedFiles` entries starting with `./` (e.g. `./check.sh`) matched nothing, so
  the file was not guarded. The prefix is now ignored.
- `tickets.sh`: slugs that git rejects as branch names (`a..b`, `x.lock`, `x.`) are refused while
  parsing, so `--dry-run` catches them. Before, they passed the checks and `start` failed halfway.
- `tickets.sh start` creates every worktree before launching any session. If creating one fails
  or you press Ctrl-C, the worktrees and branches it already created are removed again (a branch
  with commits on it is kept). A worktree deleted by hand but still registered is reported
  before anything is created.
- `tickets.sh remove` refuses while `SPEC.md` or `.review/` exists in the worktree (the ticket
  did not finish; both are gitignored, so they used to be deleted silently), while a tmux pane is
  open in the worktree, or when run from inside it.
- `tickets.sh`: tmux-launched sessions get the `PATH`, `BASH_ENV` and `PI_CHECK_MAX_FAILURES` of
  the shell that ran `start`, not the stale environment of the tmux server. Started from pi
  (`/fanout`), they no longer inherit check-guard's `BASH_ENV` hook.
- `tickets.sh`: a project directory with `.` or `:` in its name (`my.app`) broke the tmux
  launcher: tmux read the dot in the session name as a window separator, so a second `start`
  failed with "duplicate session". The session name now replaces such characters with `_`
  (`my_app-tickets`).
- `tickets.sh start`: if a session fails to launch, the remaining tickets still start, and the
  tickets left without a session are listed at the end with the command to start each by hand.
  `start` then exits non-zero. Before, it stopped at the first failure with only tmux's error.
- `tickets.sh list` counts each ticket's commits since it started (the base `start` used, stored
  in the branch's git config) instead of commits ahead of whatever the main checkout has checked
  out, so the numbers no longer change when you switch branches. It also shows the base
  (`main@1a2b3c4`) and a SESSION column: `open` when a tmux pane is in the worktree.
- `tickets.sh start` refuses when the worktree directory already holds worktrees of another
  repository with the same directory name (shared `TICKETS_WORKTREE_DIR`), and reports a branch
  named `ticket` (or `ticket/<slug>/...`) that would block the ticket branches, instead of failing
  halfway.

### Removed

- `tickets.sh`: the unused `PI_TICKET` variable (its reader, `ticket-status.ts`, was removed
  earlier).

## Old v14.0.0 (2026-11-08)

### Breaking

- `tickets.sh`: tickets start with `## ticket: <slug> [prompt]` instead of `## <slug> [prompt]`,
  so ticket text can contain its own `##` headings. Old ticket files are rejected; rename their
  headings. `/fanout` writes the new format.
- check-guard: `AGENTS.md`, `.pi/agents/**`, `.pi/prompts/**` and `.pi/settings.json` are guarded
  by default, alongside `check.sh`. `copier update` does not overwrite an existing
  `.pi/check-guard.json`: add these entries to its `guardedFiles` yourself.
- check-guard: bash commands that run `check.sh` are blocked; use the `check` tool.
- `/advised`: oracle is consulted after the second consecutive check failure (or earlier when
  only one failure is left before `PI_CHECK_MAX_FAILURES`); the agent then keeps fixing until
  pi's failure limit instead of stopping after one more attempt.

### Changed

- check-guard: the end-of-run check of guarded files runs once per run (`agent_before_settle`)
  and also after an Esc abort (`agent_settled`). Files reverted there are reported to the model
  with your next message.
- check-guard: the `check` tool no longer adds rules to the system prompt; its description only
  says what it does.
- `AGENTS.md`: run the check only with the `check` tool.
- `.pi/settings.json`: package filters drop the `council-mode` and `prompt-template-authoring`
  skills and the pi-subagents prompts.
- `/advised`: no longer repeats the oracle answer format (`oracle.md` sets it).
- README: install from the latest release instead of `main`; Versioning section.
