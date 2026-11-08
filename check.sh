#!/usr/bin/env bash
# Project check: the single command that must pass before a change is done.
#
# Configure it for this project: replace each `not_configured <name>` below
# with the command that runs that step (for example `step test npm test`).
# Delete steps that do not apply, or add others (build, format check, ...).
# Until then the check fails on purpose. It also fails until `guardedFiles` in
# .pi/check-guard.json lists your tests, fixtures and test runner config.
#
# In pi, the agent runs this through the `check` tool and needs your approval
# to change this file (see .pi/extensions/check-guard/).

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

# Fails while `guardedFiles` in .pi/check-guard.json is missing or empty: until you list your
# tests, fixtures and test runner config there, the agent may rewrite them freely. Delete this
# step only if the project has nothing to guard.
guarded_files_set() {
	node -e '
		let g;
		try { g = JSON.parse(require("fs").readFileSync(".pi/check-guard.json", "utf8")).guardedFiles; }
		catch (e) { console.error("cannot read .pi/check-guard.json: " + e.message); process.exit(1); }
		if (!Array.isArray(g) || g.length === 0) {
			console.error("guardedFiles in .pi/check-guard.json is not set: list your tests, fixtures and test runner config");
			process.exit(1);
		}
	'
}

step guarded-files guarded_files_set
step test not_configured test
step typecheck not_configured typecheck
step lint not_configured lint

if ((${#failed[@]})); then
	echo "check: FAILED (${failed[*]})"
	exit 1
fi
echo "check: passed"
