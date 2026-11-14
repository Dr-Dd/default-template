#!/usr/bin/env bash
# Show or switch the models the template's pi files use, by role.
#
#   ./models.sh                                list each role, its files and their model and thinking level
#   ./models.sh set ROLE PROVIDER/MODEL [LEVEL] set the model (and, with LEVEL, the thinking level)
#                                              of every file with that role
#   ./models.sh thinking ROLE|FILE LEVEL       set the thinking level of every file with that role,
#                                              or of one file ./models.sh lists
#
# Levels: off minimal low medium high xhigh max. Only the name is checked: pi clamps a level the
# model does not support to the nearest one it does at runtime (non-reasoning models run off).
#
# Roles:
#   strong    .pi/settings.json (defaultProvider/defaultModel, defaultThinkingLevel), /solo, /discuss, oracle, reviewer
#   standard  /advised, /fanout, /quick
#   fast      scout
#
# Model IDs and thinking levels are written into each file (pi and its packages read them there);
# this script keeps them in step. The files are guarded by check-guard: run it yourself, not through the agent.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

die() {
	echo "models: $*" >&2
	exit 1
}

roles=(strong standard fast)
levels=(off minimal low medium high xhigh max)
# role:file. .json files: defaultProvider/defaultModel and defaultThinkingLevel; .md files: the
# frontmatter `model:` and `thinking:` lines.
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

# The value of the first `KEY:` line inside the leading --- frontmatter block, or nothing.
get_fm() {
	awk -v key="$2" 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
		NR > 1 && index($0, key ":") == 1 && substr($0, length(key) + 2, 1) ~ /[[:space:]]/ {
			sub(/^[^:]*:[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); print; exit }' "$1"
}

# The string value of a top-level-looking `"KEY": "..."` line in a JSON file, or nothing.
get_json() {
	sed -nE "s/^[[:space:]]*\"$2\":[[:space:]]*\"([^\"]*)\".*/\1/p" "$1" | head -n1
}

# The provider/model a file uses, or nothing if it has none.
get_model() {
	local file=$1
	if [[ $file == *.json ]]; then
		local provider model
		provider=$(get_json "$file" defaultProvider)
		model=$(get_json "$file" defaultModel)
		[[ -z $provider || -z $model ]] || echo "$provider/$model"
	else
		get_fm "$file" model
	fi
}

# The thinking level a file uses, or nothing if it has none.
get_thinking() {
	if [[ $1 == *.json ]]; then get_json "$1" defaultThinkingLevel; else get_fm "$1" thinking; fi
}

# The key names shown in change logs.
model_key() { if [[ $1 == *.json ]]; then echo defaultProvider/defaultModel; else echo model; fi; }
thinking_key() { if [[ $1 == *.json ]]; then echo defaultThinkingLevel; else echo thinking; fi; }

# Rewrite FILE through the command after it (which reads FILE, writes stdout), keeping its mode.
rewrite() {
	local file=$1 tmp
	shift
	tmp=$(mktemp "$file.XXXXXX")
	"$@" "$file" >"$tmp"
	chmod --reference="$file" "$tmp" 2>/dev/null || true
	mv "$tmp" "$file"
}

# Replace the first `KEY:` line of the frontmatter with `KEY: VALUE`. Args: key value file.
fm_sub() {
	awk -v key="$1" -v val="$2" 'NR == 1 && $0 == "---" { fm = 1 } NR > 1 && fm && $0 == "---" { fm = 0 }
		fm && !done && index($0, key ":") == 1 && substr($0, length(key) + 2, 1) ~ /[[:space:]]/ {
			$0 = key ": " val; done = 1 } { print }' "$3"
}

set_model() {
	local file=$1 spec=$2
	if [[ $file == *.json ]]; then
		local provider=${spec%%/*} model=${spec#*/}
		rewrite "$file" sed -E \
			-e "s|^([[:space:]]*\"defaultProvider\":[[:space:]]*\")[^\"]*\"|\1$provider\"|" \
			-e "s|^([[:space:]]*\"defaultModel\":[[:space:]]*\")[^\"]*\"|\1$model\"|"
	else
		rewrite "$file" fm_sub model "$spec"
	fi
	[[ $(get_model "$file") == "$spec" ]] || die "could not set the model in $file"
}

set_thinking() {
	local file=$1 level=$2
	if [[ $file == *.json ]]; then
		rewrite "$file" sed -E \
			-e "s|^([[:space:]]*\"defaultThinkingLevel\":[[:space:]]*\")[^\"]*\"|\1$level\"|"
	else
		rewrite "$file" fm_sub thinking "$level"
	fi
	[[ $(get_thinking "$file") == "$level" ]] || die "could not set the thinking level in $file"
}

valid_level() {
	local l
	for l in "${levels[@]}"; do [[ $l == "$1" ]] && return 0; done
	die "unknown thinking level '$1' (use: ${levels[*]})"
}

# Log and apply one change. Args: file key old new setter.
apply() {
	local file=$1 key=$2 old=$3 new=$4 setter=$5
	if [[ $old == "$new" ]]; then
		echo "  $file: $key: already $new"
	else
		"$setter" "$file" "$new"
		echo "  $file: $key: $old -> $new"
	fi
}

valid_role() {
	local r
	for r in "${roles[@]}"; do [[ $r == "$1" ]] && return 0; done
	return 1
}

cmd_list() {
	local role entry file model thinking status=0
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
			thinking=$(get_thinking "$file")
			printf '  %-36s %-30s %s\n' "$file" "${model:-(no model set)}" \
				"${thinking:+thinking: }${thinking:-(no thinking set)}"
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

# The managed files of TARGET (a role, or one managed file path), one per line.
target_files() {
	local target=${1#./} entry
	if valid_role "$target"; then
		for entry in "${files[@]}"; do
			[[ ${entry%%:*} == "$target" ]] && echo "${entry#*:}"
		done
		return 0
	fi
	for entry in "${files[@]}"; do
		[[ ${entry#*:} == "$target" ]] && echo "$target" && return 0
	done
	die "'$1' is neither a role (${roles[*]}) nor a file models.sh manages (see ./models.sh)"
}

cmd_set() {
	(($# == 2 || $# == 3)) || die "usage: ./models.sh set ROLE PROVIDER/MODEL [LEVEL]"
	local role=$1 spec=$2 level=${3:-} file
	valid_role "$role" || die "unknown role '$role' (use: ${roles[*]})"
	# `]` first and `-` last: inside a bracket expression a backslash does not escape.
	local valid='^[A-Za-z0-9._-]+/[]A-Za-z0-9._:/[-]+$'
	[[ $spec =~ $valid ]] ||
		die "model must look like provider/model-id, e.g. claude-code/claude-opus-5-5"
	[[ -z $level ]] || valid_level "$level"
	local targets=()
	mapfile -t targets < <(target_files "$role")
	# Check every file before changing any.
	for file in "${targets[@]}"; do
		[[ -f $file ]] || die "$file not found"
		[[ -n $(get_model "$file") ]] || die "$file has no model to replace"
		[[ -z $level || -n $(get_thinking "$file") ]] || die "$file has no thinking level to replace"
	done
	for file in "${targets[@]}"; do
		apply "$file" "$(model_key "$file")" "$(get_model "$file")" "$spec" set_model
		[[ -z $level ]] ||
			apply "$file" "$(thinking_key "$file")" "$(get_thinking "$file")" "$level" set_thinking
	done
}

cmd_thinking() {
	(($# == 2)) || die "usage: ./models.sh thinking ROLE|FILE LEVEL"
	local level=$2 file list targets=()
	valid_level "$level"
	# Not `< <(...)`: a die inside process substitution would not stop this shell.
	list=$(target_files "$1") || exit 1
	mapfile -t targets <<<"$list"
	for file in "${targets[@]}"; do
		[[ -f $file ]] || die "$file not found"
		[[ -n $(get_thinking "$file") ]] || die "$file has no thinking level to replace"
	done
	for file in "${targets[@]}"; do
		apply "$file" "$(thinking_key "$file")" "$(get_thinking "$file")" "$level" set_thinking
	done
}

case ${1:-} in
"" | list) cmd_list ;;
set) shift; cmd_set "$@" ;;
thinking) shift; cmd_thinking "$@" ;;
-h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}" ;;
*) die "unknown command '$1' (use: list, set ROLE PROVIDER/MODEL [LEVEL], thinking ROLE|FILE LEVEL)" ;;
esac
