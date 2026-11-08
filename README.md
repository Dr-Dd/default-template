# default-template

A skeleton template, not a standalone project. It gives new or existing repositories a common baseline:

- `AGENTS.md`: agent instructions. If you also keep a global `~/.pi/agent/AGENTS.md`, pi loads it next to this one
- `.gitignore`: common ignore rules
- `check.sh`: the project check (tests, type checks, linters, ...) that must pass before a change is done. It ships unconfigured and fails until you replace its placeholder steps with the project's commands
- `.pi/extensions/check-guard/`: gives the agent a `check` tool that runs `check.sh`, stops the agent after 3 consecutive failing checks (set `PI_CHECK_MAX_FAILURES` to change the limit; your next message resets the count), blocks bash commands that run `check.sh` (so the limit and the guard cannot be skipped), and requires your approval for changes to protected files (see [Protecting tests](#protecting-tests))
- `.pi/check-guard.json`: which files are protected. Not overwritten by `copier update`
- `.pi/settings.json`: default pi provider, model and thinking level, plus the packages (`pi-claude-code`, `pi-subagents`, `pi-prompt-template-model`, filtered to the skills and prompts the template uses) and subagent settings that `AGENTS.md` and the prompts rely on
- `.pi/agents/`: the `scout` and `reviewer` subagents that `AGENTS.md` uses, and the `oracle` advisor used by `/advised`
- `tickets.sh`: run several tickets in parallel (see below)
- `.pi/prompts/fanout.md`: `/fanout`, which splits one request into parallel tickets and launches them with `tickets.sh`
- `.pi/prompts/`: the `/solo` (Opus alone) and `/advised` (Sonnet with an Opus `oracle` advisor) ticket commands, plus `/discuss` for talking through choices (reads `SPEC.md` and `.review/diff.patch` but skips the build/test/review workflow)

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
  "guardedFiles": ["check.sh", "AGENTS.md", ".pi/agents/**", ".pi/prompts/**", ".pi/settings.json",
                   "pytest.ini", "tests/**", "**/conftest.py"]
}
```

- `guardedFiles` (default `["check.sh", "AGENTS.md", ".pi/agents/**", ".pi/prompts/**", ".pi/settings.json"]`: the check and the agent's own instructions): globs relative to the project root. Setting it replaces the default, so keep those entries when you add your own. Changing, deleting or renaming a guarded file that already exists needs your approval; creating a new one does not, so the agent can add new test files freely. Use it for tests, fixtures, snapshot files and test runner config. Globs match files: use `dir/**` for everything inside a directory.
- `.pi/check-guard.json` and the extension itself are always guarded, and creating them needs approval too.
- The baseline is the guarded files as they were when the session started or when you last sent a message while the agent was idle. Your own edits between runs become the new baseline.
- Only guarded files committed in `HEAD` are in the baseline ("frozen"). A ticket's new test files stay editable until you commit them, then they are frozen like the rest. Without a commit (or outside git) every existing guarded file is frozen.
- `write` and `edit` ask before changing a guarded file and show the full diff. Changes made any other way (bash, a background process, a symlink, a test run that rewrites fixtures) are caught by a check of every guarded file against the baseline. It runs before each `check` run and once when the agent stops, including after you interrupt it with Esc. You approve or deny each change; denied changes are reverted, and a `check` run with a denied change fails without running `check.sh`. Changes reverted when the agent stops are reported to the model with your next message.
- The config is read at session start and on each of your messages. If it is unreadable or invalid, the default list stays guarded and pi shows a warning.

Limits: the guard protects the text of existing files, not their behaviour. New files can still change how existing tests run, e.g. a new `conftest.py` that overrides a fixture, a monkeypatch in a new test file, or a special case in the code under test. A change made through bash is caught at the next check or at the end of the run, not right away. Review those.

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
./tickets.sh list                 # ticket branches, clean/dirty, commits ahead
./tickets.sh remove <slug>        # after you merged it: removes worktree and branch
```

For each ticket, `start` creates branch `ticket/<slug>` in a worktree at `../worktrees/<project>/<slug>` (override with `TICKETS_WORKTREE_DIR`), writes the ticket to `TICKET.md` there, and launches pi with the ticket prompt. `TICKETS_LAUNCHER` chooses how:

- `tmux` (default): one tmux window per ticket. Inside tmux the windows go into your current session. Otherwise they go into a detached `<project>-tickets` session, and a new Ghostty window attached to it opens (`ghostty +new-window`), so your current terminal and pi stay as they are. No window opens with `TICKETS_ATTACH=0`, over ssh, without a desktop session, without Ghostty, or when the session is already open in a terminal; `start` then prints the `tmux attach` command.
- `print`: starts nothing and prints one `cd <worktree> && pi ...` command per ticket, to run yourself (e.g. one terminal tab each). Needs no multiplexer.

Each session is a normal pi session following `AGENTS.md`: it stops for your spec approval and never merges. The project's `.pi/npm` and `.pi/git` are symlinked into each worktree, so packages are not reinstalled. `tickets.sh remove` deletes only the links.

Or let pi write the list: in a pi session in the main checkout, run `/fanout <request>`, e.g. `/fanout fix the login bug (advised) and add CSV export`. It splits the request into tickets using your wording (no added requirements; each ticket agent details it in its own SPEC.md), checks the list with `--dry-run`, shows it to you and flags tickets that look like they change the same thing. It launches only after you approve, then stops.

Notes:
- Sessions start with `pi --approve` (project trust for that run only), since each worktree is a new directory.
- Tickets run concurrently, so `check.sh` must not depend on fixed ports or shared databases.
- Merging is up to you, e.g. `git merge --no-ff ticket/<slug>` from the main checkout, then `./tickets.sh remove <slug>`. `remove` refuses unmerged branches and worktrees with uncommitted changes.
- `/fanout` runs `tickets.sh` from pi, so it uses the same launcher. Set `TICKETS_LAUNCHER` in the environment pi starts from.

## Versioning

Releases are git tags `vMAJOR.MINOR.PATCH` (semver), listed in [CHANGELOG.md](CHANGELOG.md). The old tags `v1`...`v13` count as `1.0.0`...`13.0.0`, so numbering continues at `v14.0.0`.

- major: a change that breaks an existing project or workflow, e.g. a new ticket file format, more files guarded by default, a removed prompt or agent.
- minor: a new feature that keeps working setups working, e.g. a new prompt or `tickets.sh` option.
- patch: fixes and documentation.

## TODO

- **Run ticket sessions in an isolated environment.** Ticket sessions run `pi --approve` with arbitrary bash and can currently reach the whole home directory (ssh keys, credentials, browser profiles). Plan: a rootless podman container with only the worktree mounted (not distrobox, which shares `$HOME`), tmux inside it, and a `tickets.sh` launcher for it. To solve first: logins inside the container (the Claude CLI used by `pi-claude-code`; narrow git credentials, no personal ssh keys), getting branches out (push from the container or share the git directory), and each project's `check.sh` toolchain in the image. Later, the same setup could move to a VM or remote box.
- **Trial herdr as the ticket session host.** Try [herdr](https://herdr.dev) (`herdr integration install pi`) for a real batch of tickets, with `[update] version_check = false` and `manifest_check = false` in its config. If it stays, add a `herdr` launcher to `tickets.sh` (one tab per ticket via `herdr tab create --cwd ... --label ...`; first confirm how the CLI starts a command in a new tab). Then `~/.pi/agent/extensions/tmux-status.ts` is no longer needed for tickets.
