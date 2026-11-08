# Changelog

Releases follow [semver](https://semver.org) (see Versioning in README.md). Tags `v1`...`v13`
predate this file and count as `1.0.0`...`13.0.0`.

## v15.0.0 (unreleased)

### Breaking

- check-guard: a file named explicitly in `guardedFiles` (no glob syntax, e.g. `check.sh`) now
  needs approval even to be created, like the config. Files matched only by a wildcard
  (`tests/**`) stay free to create until committed, as before.

### Added

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

## v14.0.0 (2026-11-08)

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
