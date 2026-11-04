---
agent:
  - code
  - advised
  - discuss
---

AGENTS.md is shared with another harness (pi). In ECA, read its terms as follows:
- The `scout` subagent is ECA's built-in `explorer` subagent: spawn it with `eca__spawn_agent` and agent `explorer`.
- The `check` tool is `eca__check`.
- A `reviewer` "with fresh context" is a new `eca__spawn_agent` call with agent `reviewer` and no `chat_id`. Never continue an earlier reviewer.
- "If pi stops you because the check keeps failing" means a check-guard hook stopped your turn after repeated failing checks. The user's next message lets you continue.
- "The ticket template" is the instructions for your current agent.
