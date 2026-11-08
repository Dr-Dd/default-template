#!/usr/bin/env bash
# Worktree setup: tickets.sh runs this in every new ticket worktree, before the ticket's pi
# session starts. A worktree holds only committed files, so put here whatever the project needs
# that git does not track: installed dependencies, a local .env, generated files. Without them
# the ticket's first `check` fails.
#
# Configure it for this project: replace `not_configured` below with the project's commands.
# If the project needs nothing, delete that line. Until then `tickets.sh start` refuses to run.
#
# It runs inside the new worktree, with:
#   TICKETS_MAIN_ROOT  the main checkout, to copy untracked files from
#   TICKETS_SLUG       the ticket's slug
# If it fails, tickets.sh removes the worktrees it created for that start.
#
# Install from the lockfile instead of copying or symlinking dependency directories: a symlink
# would let one ticket's installs change every other ticket and the main checkout, and package
# managers install fast from their shared cache. Examples:
#
#   cp "$TICKETS_MAIN_ROOT/.env" .env                 # small untracked files: copy
#   npm ci --prefer-offline --no-audit                # Node (or: pnpm install --frozen-lockfile)
#   uv sync --frozen                                  # Python with uv
#
# In pi, changing this file needs your approval (see .pi/extensions/check-guard/).

set -euo pipefail

not_configured() {
	echo "worktree-setup.sh is not configured for this project" >&2
	return 1
}

not_configured
