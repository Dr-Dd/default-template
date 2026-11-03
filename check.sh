#!/usr/bin/env bash
# Project check: the single command that must pass before a change is done.
#
# Configure it for this project: replace each `not_configured <name>` below
# with the command that runs that step (for example `step test npm test`).
# Delete steps that do not apply, or add others (build, format check, ...).
# Until then the check fails on purpose.
#
# In pi, the agent runs this through the `check` tool and needs your approval
# to change this file (see .pi/extensions/check-guard.ts).

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec 2>&1

failed=()

step() {
	local name=$1
	shift
	echo "==> $name: $*"
	if "$@"; then
		echo "==> $name: ok"
	else
		echo "==> $name: FAILED"
		failed+=("$name")
	fi
	echo
}

not_configured() {
	echo "check.sh: \"$1\" is not configured for this project" >&2
	return 1
}

step test not_configured test
step typecheck not_configured typecheck
step lint not_configured lint

if ((${#failed[@]})); then
	echo "check: FAILED (${failed[*]})"
	exit 1
fi
echo "check: passed"
