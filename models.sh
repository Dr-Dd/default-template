#!/usr/bin/env bash
# Show or switch the models the template's pi files use, by role.
#
#   ./models.sh                         list each role, its model and the files that use it
#   ./models.sh set ROLE PROVIDER/MODEL set the model of every file with that role
#
# Roles:
#   strong    .pi/settings.json (defaultProvider/defaultModel), /solo, /discuss, oracle, reviewer
#   standard  /advised, /fanout, /quick
#   fast      scout
#
# Model IDs are written into each file (pi and its packages read them there); this script keeps
# them in step. The files are guarded by check-guard: run it yourself, not through the agent.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

die() {
	echo "models: $*" >&2
	exit 1
}

roles=(strong standard fast)
# role:file. .json files: defaultProvider/defaultModel; .md files: the frontmatter `model:` line.
files=(
	strong:.pi/settings.json
	strong:.pi/prompts/solo.md
	strong:.pi/prompts/discuss.md
	strong:.pi/agents/oracle.md
	strong:.pi/agents/reviewer.md
	standard:.pi/prompts/advised.md
	standard:.pi/prompts/fanout.md
	standard:.pi/prompts/quick.md
	fast:.pi/agents/scout.md
)

# The provider/model a file uses, or nothing if it has none.
get_model() {
	local file=$1
	if [[ $file == *.json ]]; then
		local provider model
		provider=$(sed -nE 's/^[[:space:]]*"defaultProvider":[[:space:]]*"([^"]*)".*/\1/p' "$file" | head -n1)
		model=$(sed -nE 's/^[[:space:]]*"defaultModel":[[:space:]]*"([^"]*)".*/\1/p' "$file" | head -n1)
		[[ -z $provider || -z $model ]] || echo "$provider/$model"
	else
		# First `model:` line inside the leading --- frontmatter block.
		awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
			NR > 1 && /^model:[[:space:]]/ { sub(/^model:[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); print; exit }' "$file"
	fi
}

set_model() {
	local file=$1 spec=$2 tmp
	tmp=$(mktemp "$file.XXXXXX")
	if [[ $file == *.json ]]; then
		local provider=${spec%%/*} model=${spec#*/}
		sed -E \
			-e "s|^([[:space:]]*\"defaultProvider\":[[:space:]]*\")[^\"]*\"|\1$provider\"|" \
			-e "s|^([[:space:]]*\"defaultModel\":[[:space:]]*\")[^\"]*\"|\1$model\"|" \
			"$file" >"$tmp"
	else
		awk -v spec="$spec" 'NR == 1 && $0 == "---" { fm = 1 } NR > 1 && fm && $0 == "---" { fm = 0 }
			fm && !done && /^model:[[:space:]]/ { $0 = "model: " spec; done = 1 } { print }' "$file" >"$tmp"
	fi
	chmod --reference="$file" "$tmp" 2>/dev/null || true
	mv "$tmp" "$file"
	[[ $(get_model "$file") == "$spec" ]] || die "could not set the model in $file"
}

valid_role() {
	local r
	for r in "${roles[@]}"; do [[ $r == "$1" ]] && return 0; done
	return 1
}

cmd_list() {
	local role entry file model status=0
	for role in "${roles[@]}"; do
		echo "$role:"
		for entry in "${files[@]}"; do
			[[ ${entry%%:*} == "$role" ]] || continue
			file=${entry#*:}
			if [[ ! -f $file ]]; then
				printf '  %-36s (missing)\n' "$file"
				continue
			fi
			model=$(get_model "$file")
			printf '  %-36s %s\n' "$file" "${model:-(no model set)}"
		done
	done
	# Flag roles whose files disagree.
	for role in "${roles[@]}"; do
		local seen=()
		for entry in "${files[@]}"; do
			[[ ${entry%%:*} == "$role" && -f ${entry#*:} ]] || continue
			model=$(get_model "${entry#*:}")
			[[ -n $model ]] && seen+=("$model")
		done
		if ((${#seen[@]})) && [[ $(printf '%s\n' "${seen[@]}" | sort -u | wc -l) -gt 1 ]]; then
			echo "models: warning: role '$role' uses more than one model; run ./models.sh set $role PROVIDER/MODEL" >&2
			status=1
		fi
	done
	return "$status"
}

cmd_set() {
	(($# == 2)) || die "usage: ./models.sh set ROLE PROVIDER/MODEL"
	local role=$1 spec=$2 entry file old
	valid_role "$role" || die "unknown role '$role' (use: ${roles[*]})"
	# `]` first and `-` last: inside a bracket expression a backslash does not escape.
	local valid='^[A-Za-z0-9._-]+/[]A-Za-z0-9._:/[-]+$'
	[[ $spec =~ $valid ]] ||
		die "model must look like provider/model-id, e.g. claude-code/claude-opus-5-5"
	# Check every file before changing any.
	for entry in "${files[@]}"; do
		[[ ${entry%%:*} == "$role" ]] || continue
		file=${entry#*:}
		[[ -f $file ]] || die "$file not found"
		[[ -n $(get_model "$file") ]] || die "$file has no model to replace"
	done
	for entry in "${files[@]}"; do
		[[ ${entry%%:*} == "$role" ]] || continue
		file=${entry#*:}
		old=$(get_model "$file")
		if [[ $old == "$spec" ]]; then
			echo "  $file: already $spec"
		else
			set_model "$file" "$spec"
			echo "  $file: $old -> $spec"
		fi
	done
}

case ${1:-} in
"" | list) cmd_list ;;
set) shift; cmd_set "$@" ;;
-h | --help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
*) die "unknown command '$1' (use: list, set ROLE PROVIDER/MODEL)" ;;
esac
