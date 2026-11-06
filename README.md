# default-template

A skeleton template, not a standalone project. It gives new or existing repositories a common baseline:

- `AGENTS.md`: agent instructions
- `.gitignore`: common ignore rules
- `check.sh`: the project check (tests, type checks, linters, ...) that must pass before a change is done. It ships unconfigured and fails until you replace its placeholder steps with the project's commands
- `.pi/extensions/check-guard.ts`: gives the agent a `check` tool that runs `check.sh`, stops the agent after 3 consecutive failing checks (set `PI_CHECK_MAX_FAILURES` to change the limit; your next message resets the count), and requires your approval for any change to `check.sh`
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

For each ticket, `start` creates branch `ticket/<slug>` in a worktree at `../worktrees/<project>/<slug>` (override with `TICKETS_WORKTREE_DIR`), writes the ticket to `TICKET.md` there, and opens a tmux window running pi with the ticket prompt. Inside tmux the windows go into your current session; otherwise into a detached `<project>-tickets` session. Each window is a normal pi session following `AGENTS.md`: it stops for your spec approval and never merges. The project's `.pi/npm` and `.pi/git` are symlinked into each worktree, so packages are not reinstalled.

Or let pi write the list: in a pi session in the main checkout, run `/fanout <request>`, e.g. `/fanout fix the login bug (advised) and add CSV export`. It splits the request into tickets using your wording (no added requirements; each ticket agent details it in its own SPEC.md), checks the list with `--dry-run`, shows it to you and flags tickets that look like they change the same thing. It launches only after you approve, then stops.

Notes:
- Sessions start with `pi --approve` (project trust for that run only), since each worktree is a new directory.
- Tickets run concurrently, so `check.sh` must not depend on fixed ports or shared databases.
- Merging is up to you, e.g. `git merge --no-ff ticket/<slug>` from the main checkout, then `./tickets.sh remove <slug>`. `remove` refuses unmerged branches and worktrees with uncommitted changes.
