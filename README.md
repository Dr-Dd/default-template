# default-template

A skeleton template, not a standalone project. It gives new or existing repositories a common baseline:

- `AGENTS.md`: agent instructions
- `.gitignore`: common ignore rules
- `.pi/settings.json`: default pi provider, model and thinking level, plus the packages (`pi-claude-code`, `pi-subagents`, `pi-prompt-template-model`) and subagent settings that `AGENTS.md` and the prompts rely on
- `.pi/agents/`: the `scout` and `reviewer` subagents that `AGENTS.md` uses, and the `oracle` advisor used by `/advised`
- `.pi/prompts/`: the `/solo` (Opus alone) and `/advised` (Sonnet with an Opus `oracle` advisor) ticket commands, plus `/discuss` for talking through choices (reads `SPEC.md` and `.review/diff.patch` but skips the build/test/review workflow)

## Usage

From the target repository:

```sh
copier copy --vcs-ref main git@github.com:Dr-Dd/default-template.git .
```

Pi only applies `.pi/settings.json` once you trust the project. Other settings still come from `~/.pi/agent/`.
