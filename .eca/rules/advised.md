---
agent: advised
---

Advisor rule: consult the `oracle` subagent (through `eca__spawn_agent`) at exactly these points:
- after writing SPEC.md, before asking me to approve it.
- when the check has failed twice in a row. Consult oracle first; if it still fails after one more attempt with its advice, stop and tell me as AGENTS.md says.

Do not consult it otherwise. The oracle starts with no conversation history, so its task must carry what it needs: the ticket text, the paths of SPEC.md and of the files you touched, and for a failing check the relevant check output. Ask one short, specific question, and end every oracle task with: "Answer in under 200 words: your verdict first, then the single most important reason or correction."

To ask a follow-up about the same question, continue the same oracle with the `chat_id` it returned instead of starting a new one.
