# default-template

A skeleton template, not a standalone project. It gives new or existing repositories a common baseline:

- `AGENTS.md`: agent instructions. If you also keep a global `~/.pi/agent/AGENTS.md`, pi loads it next to this one
- `.gitignore`: common ignore rules
- `check.sh`: the project check (tests, type checks, linters, ...) that must pass before a change is done. It ships unconfigured and fails until `guardedFiles` in `.pi/check-guard.json` is set (its `guarded-files` step, which needs `node`) and you replace its placeholder steps with the project's commands
- `worktree-setup.sh`: what a new `tickets.sh` worktree needs that git does not track (installed dependencies, `.env`, ...). It ships unconfigured, like `check.sh`, and `tickets.sh start` refuses to run until you configure it
- `.pi/extensions/check-guard/`: gives the agent a `check` tool that runs `check.sh` (stopped after 10 minutes by default, see `checkTimeoutSeconds` below), stops the agent after 3 consecutive failing checks (set `PI_CHECK_MAX_FAILURES` to change the limit; your next message resets the count), blocks bash commands that run `check.sh` (see [Running check.sh](#running-checksh)), and requires your approval for changes to protected files (see [Protecting tests](#protecting-tests))
- `.pi/check-guard.json`: which files are protected, and the check timeout. Not overwritten by `copier update`
- `models.sh`: show or switch the models the pi files use, by role (see [Models](#models))
- `.pi/settings.json`: default pi provider, model and thinking level, plus the packages (`pi-claude-code`, `pi-subagents`, `pi-prompt-template-model`, filtered to the skills and prompts the template uses) and subagent settings that `AGENTS.md` and the prompts rely on
- `.pi/agents/`: the `scout` and `reviewer` subagents that `AGENTS.md` uses, and the `oracle` advisor used by `/advised`
- `tickets.sh`: run several tickets in parallel (see below)
- `.pi/prompts/fanout.md`: `/fanout`, which splits one request into parallel tickets and launches them with `tickets.sh`
- `.pi/prompts/`: the `/solo` (strong model alone) and `/advised` (standard model with a strong-model `oracle` advisor) ticket commands, plus `/discuss` for talking through choices (reads `SPEC.md` and `.review/diff.patch` but skips the build/test/review workflow)
- `.pi/prompts/quick.md`: `/quick` (standard model) for small changes: no `SPEC.md` and no approval stop (it states a short plan instead), and the review runs only if you ask for one. In a tickets file (`## ticket: <slug> quick`) it runs without stopping for approval

## Usage

From the target repository:

```sh
copier copy git@github.com:Dr-Dd/default-template.git .
```

This uses the latest release tag. Later, `copier update` moves the project to the newest release; read [CHANGELOG.md](CHANGELOG.md) first for breaking changes. Add `--vcs-ref main` to either command to use unreleased changes instead.

Pi only applies `.pi/settings.json` once you trust the project. Other settings still come from `~/.pi/agent/`.

## Protecting tests

`.pi/check-guard.json` lists the files the agent may not change without your approval:

```json
{
  "strictFiles": ["check.sh", "worktree-setup.sh", "AGENTS.md", ".pi/settings.json", ".pi/agents/**", ".pi/prompts/**"],
  "guardedFiles": ["pytest.ini", "tests/**", "**/conftest.py"],
  "vulnerableFiles": [".pi/npm", ".pi/git"]
}
```

- `strictFiles` (default `["check.sh", "worktree-setup.sh", "AGENTS.md", ".pi/settings.json", ".pi/agents/**", ".pi/prompts/**"]`: the check, the worktree setup, the agent's own instructions and the pi files that define agents and prompts): globs relative to the project root. Always protected: changing, deleting or renaming an existing file needs your approval, and so does creating one. Setting it replaces the default, so keep those entries when you add your own. Globs match files: use `dir/**` for everything inside a directory.
- `guardedFiles` (default `[]`): globs like `strictFiles`, but for files that are protected only once committed in `HEAD`. A new file matched here does not need approval, so the agent can add new test files freely. Use it for tests, fixtures, snapshot files and test runner config. If a file matches both lists, `strictFiles` wins.
- `vulnerableFiles` (default `[".pi/npm", ".pi/git"]`: pi's installed packages, which pi rewrites itself): globs that are not guarded at all, even if `strictFiles` or `guardedFiles` (or both) match them. A directory covers everything inside it. Use it to carve exceptions out of broad patterns like `.pi/**`. It cannot exempt `.pi/check-guard.json` or the extension.
- `.pi/check-guard.json` and the extension itself are always strict.
- The baseline is the guarded files as they were when the session started or when you last sent a message while the agent was idle. Your own edits between runs become the new baseline.
- Files matched by `guardedFiles` are in the baseline ("frozen") only once committed in `HEAD`. A ticket's new test files stay editable until you commit them, then they are frozen like the rest. Strict files are always frozen. Without a commit (or outside git) every existing guarded file is frozen.
- `write` and `edit` ask before changing a guarded file and show the full diff. Changes made any other way (bash, a background process, a symlink, a test run that rewrites fixtures) are caught by a check of every guarded file against the baseline. It runs before each `check` run and once when the agent stops, including after you interrupt it with Esc. All changes it finds are shown in one dialog (e.g. 40 rewritten snapshot files are one dialog, not 40). For several files it lists their paths; every file starts undecided:
  - `↑`/`↓` select a file, `Enter` toggles it between keep and discard, `Tab` shows or hides its diff
  - `Shift+V` keeps all, `Shift+X` discards all
  - `Shift+Enter` (or `Shift+A`) applies once every file is decided (`Esc` does nothing, so a stray key cannot answer). Your terminal must report Shift+Enter as its own key: Ghostty, Kitty and other terminals with the Kitty keyboard protocol do; inside tmux set `extended-keys on` (and `extended-keys-format csi-u`)

  A single file gets the `y`/`n` dialog with its diff. Discarded changes are reverted, and a `check` run with discarded changes fails without running `check.sh`. Changes reverted when the agent stops are reported to the model with your next message.
- `checkTimeoutSeconds` (default `600`, `0` for no timeout): a `check` run that takes longer is stopped and counts as a failing check. Stopping kills `check.sh` and every process it started.
- The config is read at session start and on each of your messages. If it is unreadable or invalid, the default `strictFiles` stay guarded and pi shows a warning. Unknown keys (e.g. a misspelled `strictFiles`) are ignored with a warning.

The `subagent` tool is allowlisted in the extension:

- Actions that start no child run are allowed: `status`, `interrupt`, `stop`, `list`, `get`, `guide`. Every other action is blocked, including agent management (`create`, `update`, `delete`, ...), `resume`, schedules and workflow actions.
- A call without an action is a direct launch. It may only start `scout`, `reviewer` or `oracle`, one agent per call: `workflow`, `tasks` and `chain` are blocked.
- A launch must be the only tool call of its message, and first runs the guarded-file check. If the check reverts changes, the launch is refused.

The allowed actions and agents are constants at the top of `.pi/extensions/check-guard/index.ts` (`ALLOWED_SUBAGENT_ACTIONS`, `ALLOW_SUBAGENT_AGENTS`). To use other agents, add them there; the extension is always guarded, so this needs your approval.

Limits: the guard protects the text of existing files, not their behaviour. New files can still change how existing tests run, e.g. a new `conftest.py` that overrides a fixture, a monkeypatch in a new test file, or a special case in the code under test. A change made through bash is caught at the next check or at the end of the run, not right away. Review those.

## Running check.sh

The agent runs the check with the `check` tool, which counts failures and checks guarded files first. Running `check.sh` through bash would skip both, so check-guard blocks it in two layers:

- Before a bash command runs, a pattern match blocks the common forms (`./check.sh`, `bash check.sh`, `nice ./check.sh`, `eval ./check.sh`, `/usr/bin/env bash check.sh`, ...) with a clear message.
- Every bash command also runs with `BASH_ENV` pointing at `.pi/extensions/check-guard/bash-env.sh`. Bash reads that file before running any script, so a bash that would run `check.sh` (or a byte-identical copy of it) exits with status 1, however it was started: `make check`, `xargs`, `find -exec`, a symlink, a subprocess from Python. A `BASH_ENV` you started pi with still runs, after the check.

This is a tripwire, not a sandbox. Deliberate dodges still work: clearing `BASH_ENV` (`env -i`, `env -u BASH_ENV`, `unset`), feeding the script to bash on stdin or with `-c` (`cat check.sh | bash`), running it with `sh` or `bash --posix`/`-p` hidden from the pattern match (e.g. inside `make`), or running an edited copy. Running the project's own steps (`npm test`, ...) is allowed and normal while debugging. Either way the guarded-file check still runs when the agent stops.

## Models

Pi and its packages read the model from each file (`.pi/settings.json`, the prompts' and agents' `model:` frontmatter), so the IDs are written in nine places. `models.sh` keeps them in step by role:

| Role | Files |
|---|---|
| `strong` | `.pi/settings.json` (`defaultProvider`/`defaultModel`), `/solo`, `/discuss`, `oracle`, `reviewer` |
| `standard` | `/advised`, `/fanout`, `/quick` |
| `fast` | `scout` |

```sh
./models.sh                                        # each role, its model and files; warns if a role is mixed
./models.sh set strong claude-code/claude-opus-5-5 # switch every file of a role
```

The files are guarded, so run it yourself rather than through the agent (or approve the changes when check-guard asks). Prompt and agent descriptions name roles (strong, standard, fast), not models, so they stay correct after a switch.

## Parallel tickets

A single ticket works as before: start `pi` in the repo and run `/solo` or `/advised`.

To run several at once, write a tickets file with one `## ticket: <slug> [prompt]` line per ticket (prompt defaults to `solo`). Everything up to the next `## ticket:` line is the ticket, so ticket text can contain its own `##` headings:

```markdown
## ticket: fix-login
Login fails when the email has uppercase letters.

## ticket: csv-export advised
Add CSV export to the reports page.
```

```sh
./tickets.sh start tickets.md     # --prompt advised, --base <ref> to change defaults
./tickets.sh start --dry-run - < tickets.md   # read stdin; check everything, create nothing
./tickets.sh list                 # tickets: clean/dirty, tmux session open, commits since start, base
./tickets.sh merge <slug>         # merge into the current branch, run check.sh, then remove
./tickets.sh remove <slug>        # after you merged it: removes worktree and branch
```

For each ticket, `start` creates branch `ticket/<slug>` in a worktree at `../worktrees/<project>/<slug>` (override with `TICKETS_WORKTREE_DIR`), writes the ticket to `TICKET.md` there, runs `worktree-setup.sh` there, and launches pi with the ticket prompt. The worktrees are all created and set up before any session starts; if one fails (or you press Ctrl-C), the ones already created are removed again. `TICKETS_LAUNCHER` chooses how:

- `tmux` (default): one tmux window per ticket. Inside tmux the windows go into your current session. Otherwise they go into a detached `<project>-tickets` session (characters other than letters, digits, `_` and `-` become `_`), and a new terminal window attached to it opens, so your current terminal and pi stay as they are. The terminal is `$TERMINAL` (a command name or path; arguments in it are ignored), else the first found of `ghostty kitty alacritty foot wezterm konsole gnome-terminal xterm`. Ghostty opens the window in the running instance (`ghostty +new-window`); others are started detached with the command flag they take (`-e` unless known otherwise). No window opens with `TICKETS_ATTACH=0`, over ssh, without a desktop session, without a terminal found, or when the session is already open in a terminal; `start` then prints the `tmux attach` command.
- `print`: starts nothing and prints one `cd <worktree> && pi ...` command per ticket, to run yourself (e.g. one terminal tab each). Needs no multiplexer.

Each session is a normal pi session following `AGENTS.md`: it stops for your spec approval and never merges. The project's `.pi/npm` and `.pi/git` are symlinked into each worktree, so packages are not reinstalled. `tickets.sh remove` deletes only the links.

### Worktree setup

A worktree holds only committed files: no `node_modules`, no `.venv`, no `.env`. Without them a ticket's first `check` fails and the session stops. `worktree-setup.sh` fills that gap. `start` runs it in each new worktree, with `TICKETS_MAIN_ROOT` (the main checkout) and `TICKETS_SLUG` set. It ships unconfigured: until you replace its `not_configured` line, `start` refuses to run. If the project needs nothing, delete the line.

```bash
cp "$TICKETS_MAIN_ROOT/.env" .env
npm ci --prefer-offline --no-audit
```

Install dependencies from the lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --frozen`, ...) rather than symlinking or copying them from the main checkout. With a symlink, an install in one ticket would change every other ticket and the main checkout; package managers install quickly from their shared cache. Copy small untracked files such as `.env`. `copier update` does not overwrite the script, and changing it needs your approval in pi (it runs on your machine at every `start`).

Or let pi write the list: in a pi session in the main checkout, run `/fanout <request>`, e.g. `/fanout fix the login bug (advised) and add CSV export`. It splits the request into tickets using your wording (no added requirements; each ticket agent details it in its own SPEC.md), checks the list with `--dry-run`, shows it to you and flags tickets that look like they change the same thing. It launches only after you approve, then stops.

Notes:
- Sessions start with `pi --approve` (project trust for that run only), since each worktree is a new directory.
- Tickets run concurrently, so `check.sh` must not depend on fixed ports or shared databases.
- Merging is up to you. `./tickets.sh merge <slug>`, run from your own shell (agents never merge; under pi it refuses), merges with `--no-ff` into the main checkout's current branch, runs `check.sh` on the result and removes the ticket if it passes. Each ticket passed the check on its own, but two tickets can break each other, so the check runs again on every merge. It refuses a dirty main checkout. On a conflict it aborts the merge, leaving the branch unchanged, and you merge that ticket by hand. If the check fails, the merge stays for you to fix, or undo it with `git reset --hard ORIG_HEAD`. By hand: `git merge --no-ff ticket/<slug> && ./check.sh && ./tickets.sh remove <slug>`. Merging on GitHub instead (squash or rebase) is not supported yet: `remove` would see the branch as unmerged. `remove` refuses unmerged branches, worktrees with uncommitted changes, worktrees where `SPEC.md` or `.review/` still exists (the ticket did not finish), and worktrees with a tmux pane still open in them (it cannot see sessions started with the `print` launcher).
- When launched with tmux, a ticket session gets this shell's `PATH`, `BASH_ENV` and `PI_CHECK_MAX_FAILURES`, not the tmux server's (which keeps the environment it started with). Under `/fanout`, check-guard's own `BASH_ENV` hook is left out.
- `/fanout` runs `tickets.sh` from pi, so it uses the same launcher. Set `TICKETS_LAUNCHER` in the environment pi starts from.

## Versioning

Releases are git tags `v0.MINOR.PATCH` (semver), listed in [CHANGELOG.md](CHANGELOG.md). The project is pre-1.0 and not stable: anything may change in any release. Earlier tags (`v1`...`v15.0.0`) were deleted and numbering restarted at `v0.15.0`.

- minor: a change that breaks an existing project or workflow, e.g. a new ticket file format, more files guarded by default, a removed prompt or agent. Also new features.
- patch: fixes and documentation.

`1.0.0` comes once the template is stable.

## License

[WTFPL](LICENSE). The license covers this template repository only; `copier copy` does not add it to your project.
