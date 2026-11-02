# default-template

A skeleton template, not a standalone project. It gives new or existing repositories a common baseline:

- `AGENTS.md`: agent instructions
- `.gitignore`: common ignore rules
- `.pi/settings.json`: default pi provider, model and thinking level, plus the packages (`pi-claude-code`, `pi-subagents`) and subagent settings that `AGENTS.md` relies on
- `.pi/agents/`: the `scout` and `reviewer` subagents that `AGENTS.md` uses

## Usage

From the target repository:

```sh
copier copy --vcs-ref main git@github.com:Dr-Dd/default-template.git .
```

Pi only applies `.pi/settings.json` once you trust the project. Other settings still come from `~/.pi/agent/`.
