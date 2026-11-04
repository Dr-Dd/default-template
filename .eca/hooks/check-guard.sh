#!/usr/bin/env bash
# check-guard: keeps ./check.sh the project's single, approval-gated check in ECA.
#
# Wired up in .eca/config.json; ECA runs it from the workspace root with the
# hook payload as JSON on stdin. Subcommands:
#
#   file-approval  preToolCall on edit/write/move_file: touching check.sh always
#                  asks the user, even in trust mode or after "approve and remember".
#   shell-pre      preToolCall on shell_command: rejects running check.sh directly
#                  (use the `check` tool) and snapshots check.sh.
#   shell-post     postToolCall on shell_command: if the command changed check.sh,
#                  restores the snapshot (hooks cannot ask the user mid-call).
#   check-post     postToolCall on the `check` tool: counts consecutive failures and
#                  stops the turn at ECA_CHECK_MAX_FAILURES (default 3).
#   reset          preRequest: a new user message resets the failure count.
#
# Requires jq. State lives under ${TMPDIR:-/tmp}, never in the repository.

set -uo pipefail

CHECK_FILE=check.sh

if ! command -v jq >/dev/null; then
	echo "check-guard: jq is not installed, so check.sh is not protected. Install jq." >&2
	# Fail closed where a hook can block (exit 2 rejects the tool call); elsewhere just log.
	case ${1:-} in file-approval | shell-pre) exit 2 ;; *) exit 1 ;; esac
fi

input=$(cat)
field() { jq -r "$1 // empty" <<<"$input"; }

root=$(field .cwd)
root=${root:-$PWD}
check="$root/$CHECK_FILE"
session=$(field .session_id)
chat=$(field .chat_id)
state="${TMPDIR:-/tmp}/eca-check-guard-$(id -u)/${session:-default}"
mkdir -p "$state"

max_failures() {
	local n=${ECA_CHECK_MAX_FAILURES:-}
	if [[ $n =~ ^[1-9][0-9]*$ ]]; then echo "$n"; else echo 3; fi
}

# Resolved absolute path, following symlinks where they exist.
resolve() { realpath -m -- "$1" 2>/dev/null || printf '%s\n' "$1"; }

# Print a JSON object built from jq --arg pairs: emit key value [key value ...]
emit() {
	local args=() filter="{" sep=""
	while (($#)); do
		args+=(--arg "$1" "$2")
		filter+="$sep\"$1\": \$$1"
		sep=", "
		shift 2
	done
	jq -nc "${args[@]}" "$filter}"
}

# check.sh invoked as a command: ./check.sh, bash check.sh, sh -c './check.sh', source check.sh, ...
invocation_re='(?:^|[\n;&|(`]|\$\()\s*(?:(?:\w+=\S*|exec|time|nohup|env|command|nice|timeout(?:\s+(?:-\S+|[A-Z]+))*\s+\S+)\s+)*(?:(?:ba|da|z|k)?sh\s+(?:-\S+\s+)*|source\s+|\.\s+)?["'"'"']?(?:\S*/)?check\.sh(?![\w.-])'

snap_name() { printf '%s/snap-%s' "$state" "$(field .tool_call_id | tr -c 'A-Za-z0-9_-' _)"; }

case ${1:-} in
file-approval)
	target=$(resolve "$check")
	for key in path source destination; do
		p=$(field ".tool_input.$key")
		[[ -n $p ]] || continue
		[[ $p = /* ]] || p="$root/$p"
		if [[ $(resolve "$p") == "$target" ]]; then
			emit approval ask
			exit 0
		fi
	done
	;;

shell-pre)
	if jq -e --arg re "$invocation_re" '.tool_input.command // "" | test($re)' <<<"$input" >/dev/null; then
		echo "Do not run $CHECK_FILE through the shell. Use the check tool to run the project check." >&2
		exit 2
	fi
	snap=$(snap_name)
	if [[ -L $check || (-e $check && ! -f $check) ]]; then
		: >"$snap.special" # not a regular file: nothing we could restore faithfully
	elif [[ -f $check ]]; then
		cp -p -- "$check" "$snap"
	else
		: >"$snap.absent"
	fi
	;;

shell-post)
	snap=$(snap_name)
	if [[ -e $snap.special ]]; then
		rm -f -- "$snap.special"
		exit 0
	fi
	if [[ -e $snap.absent ]]; then
		rm -f -- "$snap.absent"
		[[ -e $check || -L $check ]] || exit 0
		what=created
		rm -rf -- "$check"
	elif [[ -f $snap ]]; then
		if [[ -f $check && ! -L $check ]] && cmp -s -- "$snap" "$check" &&
			[[ $(stat -c %a -- "$snap") == "$(stat -c %a -- "$check")" ]]; then
			rm -f -- "$snap"
			exit 0
		fi
		if [[ -e $check || -L $check ]]; then what=changed; else what=deleted; fi
		rm -rf -- "$check"
		mv -- "$snap" "$check"
	else
		exit 0
	fi
	emit \
		additionalContext "[check-guard] This command $what $CHECK_FILE, so the change was reverted. Changes to $CHECK_FILE need the user's approval: tell the user what you want to change and why, or use the file edit tools, which ask the user first." \
		systemMessage "Reverted: a shell command $what $CHECK_FILE."
	;;

check-post)
	count_file="$state/failures-${chat:-default}"
	if [[ $(field .error) != true ]]; then
		rm -f -- "$count_file"
		exit 0
	fi
	count=$(($(cat -- "$count_file" 2>/dev/null || echo 0) + 1))
	echo "$count" >"$count_file"
	limit=$(max_failures)
	if ((count < limit)); then
		emit additionalContext "Check failed. Consecutive failures: $count/$limit."
		exit 0
	fi
	jq -nc --arg n "$count" '{
		continue: false,
		stopReason: ("The project check (check.sh) failed \($n) times in a row, so the agent was stopped. Your next message lets it try again.")
	}'
	;;

reset)
	rm -f -- "$state/failures-${chat:-default}"
	# Snapshots of shell calls that never finished (rejected or cancelled before running).
	find "$state" -maxdepth 1 -name 'snap-*' -mmin +1440 -delete 2>/dev/null
	;;

*)
	echo "check-guard: unknown subcommand '${1:-}'" >&2
	exit 1
	;;
esac
exit 0
