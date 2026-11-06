# default-template

A skeleton template, not a standalone project. It gives new or existing repositories a common baseline:

- `AGENTS.md`: agent instructions
- `.gitignore`: common ignore rules
- `check.sh`: the project check (tests, type checks, linters, ...) that must pass before a change is done. It ships unconfigured and fails until you replace its placeholder steps with the project's commands
- `.pi/extensions/check-guard/`: gives the agent a `check` tool that runs `check.sh`, stops the agent after 3 consecutive failing checks (set `PI_CHECK_MAX_FAILURES` to change the limit; your next message resets the count), and requires your approval for changes to protected files (see [Protecting tests](#protecting-tests))
- `.pi/check-guard.json`: which files are protected, and how. Not overwritten by `copier update`
- `.pi/settings.json`: default pi provider, model and thinking level, plus the packages (`pi-claude-code`, `pi-subagents`, `pi-prompt-template-model`) and subagent settings that `AGENTS.md` and the prompts rely on
- `.pi/agents/`: the `scout` and `reviewer` subagents that `AGENTS.md` uses, and the `oracle` advisor used by `/advised`
- `tickets.sh`: run several tickets in parallel (see below)
- `.pi/prompts/fanout.md`: `/fanout`, which splits one request into parallel tickets and launches them with `tickets.sh`
- `.pi/prompts/`: the `/solo` (Opus alone) and `/advised` (Sonnet with an Opus `oracle` advisor) ticket commands, plus `/discuss` for talking through choices (reads `SPEC.md` and `.review/diff.patch` but skips the build/test/review workflow)

## Usage

From the target repository:

```sh
copier copy --vcs-ref main git@github.com:Dr-Dd/default-template.git .
```

Pi only applies `.pi/settings.json` once you trust the project. Other settings still come from `~/.pi/agent/`.

## Protecting tests

`.pi/check-guard.json` sets what the agent may not change without your approval:

```json
{
  "guardedFiles": ["check.sh", "pytest.ini", "tests/fixtures/**"],
  "unitGuardedFiles": [
    { "files": ["tests/**/*.py", "**/conftest.py"], "preset": "pytest" },
    { "files": ["**/*.test.ts", "**/*.test.tsx"], "preset": "vitest" }
  ]
}
```

- `guardedFiles` (default `["check.sh"]`): changing or deleting an existing file needs approval. Use it for test runner config, fixtures and snapshot files.
- `unitGuardedFiles`: only changes to code from the **base commit** (`HEAD` when the session started or you last sent a message) need approval. The file is split with tree-sitter into units (functions, classes, methods, `describe`/`it` blocks, fixtures, hooks) and statements (imports, constants, setup code). Approval is needed to modify, remove or rename any of them, to delete a file from the base commit, or to add code that changes how existing tests run: focused tests (`.only`, `fit`), new hooks in existing suites, a second definition of an existing name, pytest hooks, `autouse` fixtures, `pytestmark`, `jest.mock`/`vi.mock`, Go `TestMain`/`init`. New tests, helpers and files are free. Formatting and ordinary comments are ignored.
- Presets: `pytest`, `jest` (also `vitest`, `mocha`, `javascript`, `typescript`), `go`, `rust`, `junit`, `busted` (Lua), and `generic` (every named top-level definition; needs `"grammar": "<npm package>/<file>.wasm"`).
- `.pi/check-guard.json`, `.pi/check-guard/` and the extension itself are always guarded.
- The config is read at session start and on each of your messages.

Set up unit guarding once per project, in the main checkout:

```sh
.pi/check-guard/setup.sh python typescript   # also: javascript go rust java lua, or any npm grammar package
```

This installs `web-tree-sitter` and the grammars (prebuilt WebAssembly, nothing is compiled) into `.pi/check-guard/node_modules` (gitignored). Commit `.pi/check-guard/package.json` and `package-lock.json`. If the runtime or a grammar is missing, or a file cannot be analysed, those files are guarded as whole files and pi shows a warning, so a setup mistake makes the guard stricter, not weaker.

Bash commands are checked after they run. If one changes protected code and you deny it, the whole file is restored to how it was before the command, including any new code that command added.

Limits: the guard protects the text of existing code, not its behaviour. New code can still change how existing tests behave, e.g. a monkeypatch inside a new test file, test helpers outside the configured globs, or a special case in the code under test. Review those.

## Parallel tickets

A single ticket works as before: start `pi` in the repo and run `/solo` or `/advised`.

To run several at once, write a tickets file with one `## <slug> [prompt]` heading per ticket (prompt defaults to `solo`):

```markdown
## fix-login
Login fails when the email has uppercase letters.

## csv-export advised
Add CSV export to the reports page.
```

```sh
./tickets.sh start tickets.md     # --prompt advised, --base <ref> to change defaults
./tickets.sh start --dry-run - < tickets.md   # read stdin; check everything, create nothing
./tickets.sh list                 # ticket branches, clean/dirty, commits ahead
./tickets.sh remove <slug>        # after you merged it: removes worktree and branch
```

For each ticket, `start` creates branch `ticket/<slug>` in a worktree at `../worktrees/<project>/<slug>` (override with `TICKETS_WORKTREE_DIR`), writes the ticket to `TICKET.md` there, and opens a tmux window running pi with the ticket prompt. Inside tmux the windows go into your current session; otherwise into a detached `<project>-tickets` session. Each window is a normal pi session following `AGENTS.md`: it stops for your spec approval and never merges. The project's `.pi/npm`, `.pi/git` and `.pi/check-guard/node_modules` are symlinked into each worktree, so packages are not reinstalled. `tickets.sh remove` deletes only the links.

Or let pi write the list: in a pi session in the main checkout, run `/fanout <request>`, e.g. `/fanout fix the login bug (advised) and add CSV export`. It splits the request into tickets using your wording (no added requirements; each ticket agent details it in its own SPEC.md), checks the list with `--dry-run`, shows it to you and flags tickets that look like they change the same thing. It launches only after you approve, then stops.

Notes:
- Sessions start with `pi --approve` (project trust for that run only), since each worktree is a new directory.
- Tickets run concurrently, so `check.sh` must not depend on fixed ports or shared databases.
- Merging is up to you, e.g. `git merge --no-ff ticket/<slug>` from the main checkout, then `./tickets.sh remove <slug>`. `remove` refuses unmerged branches and worktrees with uncommitted changes.
