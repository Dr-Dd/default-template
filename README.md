# default-template

A skeleton template, not a standalone project. It gives new or existing repositories a common baseline:

- `AGENTS.md`: agent instructions
- `.gitignore`: common ignore rules
- `check.sh`: the project check (tests, type checks, linters, ...) that must pass before a change is done. It ships unconfigured and fails until you replace its placeholder steps with the project's commands
- `.pi/extensions/check-guard.ts`: gives the agent a `check` tool that runs `check.sh`, stops the agent after 3 consecutive failing checks (set `PI_CHECK_MAX_FAILURES` to change the limit; your next message resets the count), and requires your approval for any change to `check.sh`
- `.pi/settings.json`: default pi provider, model and thinking level, plus the packages (`pi-claude-code`, `pi-subagents`, `pi-prompt-template-model`) and subagent settings that `AGENTS.md` and the prompts rely on
- `.pi/agents/`: the `scout` and `reviewer` subagents that `AGENTS.md` uses, and the `oracle` advisor used by `/advised`
- `tickets.sh` and `.pi/extensions/ticket-status.ts`: run several tickets in parallel (see below)
- `.pi/prompts/fanout.md`: `/fanout`, which splits one request into parallel tickets and launches them with `tickets.sh`
- `.pi/prompts/`: the `/solo` (Opus alone) and `/advised` (Sonnet with an Opus `oracle` advisor) ticket commands, plus `/discuss` for talking through choices (reads `SPEC.md` and `.review/diff.patch` but skips the build/test/review workflow)
- `.eca/`: the same workflow for ECA (see [ECA](#eca))

## Usage

From the target repository:

```sh
copier copy --vcs-ref main git@github.com:Dr-Dd/default-template.git .
```

Pi only applies `.pi/settings.json` once you trust the project. Other settings still come from `~/.pi/agent/`.

## ECA

The same workflow also runs in [ECA](https://eca.dev) (Editor Code Assistant), configured in `.eca/`. Both tools read the same `AGENTS.md`; `.eca/rules/workflow.md` maps its pi terms to ECA. Log in once with `/login anthropic` and choose `max` to use a Claude Pro/Max subscription.

Pick the ticket mode by choosing the **agent** before the first message (in Emacs: `C-c C-b` cycles, `C-c C-S-b` selects). ECA keeps a chat's model once it has started, so start a new chat to switch mode.

| pi | ECA | Model |
|---|---|---|
| `/solo <ticket>` | `code` agent (the default), then type the ticket | Opus, medium |
| `/advised <ticket>` | `advised` agent | Sonnet, medium; `oracle` subagent on Opus |
| `/discuss <topic>` | `discuss` agent | Opus, high; can write only SPEC.md |
| `/fanout <request>` | `/fanout <request>` command | launches pi tickets with `tickets.sh` |
| `scout` subagent | built-in `explorer` subagent | Haiku |
| `reviewer` subagent | `reviewer` subagent | Opus, high |

The check is the `check` tool (`.eca/config.json` `customTools`). `.eca/hooks/check-guard.sh` (needs `jq`) adds the guards from pi's `check-guard.ts`:

- edits to `check.sh` through the file tools always ask you, even in trust mode;
- running `check.sh` through the shell is rejected;
- a shell or git command that changes `check.sh` is reverted, since an ECA hook cannot ask you mid-command;
- after 3 consecutive failing checks the turn stops (`ECA_CHECK_MAX_FAILURES` in ECA's environment changes the limit); your next message resets the count.

ECA's built-in `general` subagent can edit files, so it is hidden from every agent (`spawnableBy: "none"`, like `disableBuiltins` in pi).

Differences from pi: ECA subagents always start from an empty conversation, so the `oracle` gets its context from the task the agent writes, not from a fork. ECA also gives subagents the project's `AGENTS.md` and any rules without an agent filter, so the `reviewer` is fresh with respect to the conversation but not to the project instructions. Parallel tickets (`tickets.sh`, tmux window status) stay pi-only.

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

The window name shows each ticket's state: `▶ slug` working, `? slug` a dialog waits for your answer, `✋ slug` the agent stopped and waits for you.

Notes:
- Sessions start with `pi --approve` (project trust for that run only), since each worktree is a new directory.
- Tickets run concurrently, so `check.sh` must not depend on fixed ports or shared databases.
- Merging is up to you, e.g. `git merge --no-ff ticket/<slug>` from the main checkout, then `./tickets.sh remove <slug>`. `remove` refuses unmerged branches and worktrees with uncommitted changes.
