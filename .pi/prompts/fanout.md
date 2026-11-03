---
description: Split a request into parallel tickets and launch them with tickets.sh
model: claude-code/claude-sonnet-5-5
thinking: low
restore: false
---
Do not follow the workflow in AGENTS.md and do not edit files. Turn my request below into tickets for ./tickets.sh.

- One ticket per separate change I asked for. Use my wording; do not add requirements, criteria or details I did not give. If the split is unclear, ask me instead of guessing.
- Format: `## <slug> <mode>` then the ticket text. Slugs: lowercase letters, digits, `.`, `_`, `-`. Mode is the one I name for that ticket, otherwise `solo`.
- Always pass the list through a quoted heredoc so nothing is expanded:

  ./tickets.sh start [--dry-run] - <<'TICKETS_EOF'
  ...
  TICKETS_EOF

1. Preview: run it with `--dry-run`; if it fails, fix the list and run it again. Then show me the ticket list exactly as it passed, and say if two tickets look like they change the same thing. Stop and wait for my approval. If I ask for changes, apply them and preview again.
2. Launch: run the same list without `--dry-run`. Report the output and stop.

Request:
$@
