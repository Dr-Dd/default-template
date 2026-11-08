# check-guard: bash reads this file (through BASH_ENV) before running any script that the
# agent's bash commands start, at any depth: ./check.sh, `bash check.sh`, `nice`, `env`, `make`,
# `xargs`, a subprocess from python, ... If the script is the project's check.sh, or a
# byte-identical copy of it, bash stops here, so the check only runs through the `check` tool
# (which counts failures). A tripwire, not a sandbox: see "Running check.sh" in README.md.
#
# Set by index.ts in front of each bash tool command:
#   PI_CHECK_GUARD_ROOT      project root (unset: this file does nothing but chain)
#   PI_CHECK_GUARD_BASH_ENV  the BASH_ENV pi itself was started with, if any (sourced below)

if [[ -n ${PI_CHECK_GUARD_ROOT-} && -f $0 && -f $PI_CHECK_GUARD_ROOT/check.sh ]]; then
	if [[ $0 -ef $PI_CHECK_GUARD_ROOT/check.sh ]] || cmp -s -- "$0" "$PI_CHECK_GUARD_ROOT/check.sh"; then
		echo "check-guard: do not run check.sh through bash; use the check tool." >&2
		exit 1
	fi
fi

if [[ -n ${PI_CHECK_GUARD_BASH_ENV-} && -f $PI_CHECK_GUARD_BASH_ENV && ! $PI_CHECK_GUARD_BASH_ENV -ef ${BASH_SOURCE[0]} ]]; then
	# shellcheck disable=SC1090
	. "$PI_CHECK_GUARD_BASH_ENV"
fi
