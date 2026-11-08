#!/usr/bin/env bash
# Run several tickets in parallel: one git worktree, branch and pi session per ticket.
#
#   ./tickets.sh start [--prompt solo|advised] [--base REF] [--dry-run] FILE|-
#   ./tickets.sh list
#   ./tickets.sh remove SLUG      (after you merged it: removes worktree and branch)
#
# FILE (or stdin with "-") holds one ticket per "## <slug> [prompt]" heading; the text below the heading
# (up to the next "## ") is the ticket:
#
#   ## fix-login
#   Login fails when the email has uppercase letters. ...
#
#   ## csv-export advised
#   Add CSV export to the reports page. ...
#
# For each ticket this creates branch ticket/<slug> from --base (default HEAD) in
# $TICKETS_WORKTREE_DIR/<project>/<slug> (default: ../worktrees next to the repo),
# writes the ticket to TICKET.md there (gitignored), and launches `pi "/<prompt> ..."`
# in it. Each session is a normal interactive pi session that follows AGENTS.md: it
# stops for spec approval and never merges.
#
# TICKETS_LAUNCHER chooses how sessions are launched:
#   tmux   (default) one tmux window named <slug> per ticket. Inside tmux the windows go
#          into the current session; otherwise into a detached session
#          "<project>-tickets" that you attach to.
#   print  start nothing: print one command per ticket to run yourself (e.g. one
#          terminal tab each). Needs no multiplexer.
#
# --dry-run runs every check and prints what would start, without creating anything.
# The /fanout prompt uses it to validate a ticket list before you confirm.
#
# Merging is up to you, e.g. from the main checkout:
#   git merge --no-ff ticket/<slug> && ./tickets.sh remove <slug>

set -euo pipefail

die() {
	echo "tickets: $*" >&2
	exit 1
}

usage() {
	sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	exit "${1:-1}"
}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
# Always work from the main checkout, even if run from inside a ticket worktree.
common_dir=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
main_root=$(dirname "$common_dir")
project=$(basename "$main_root")
wt_base=${TICKETS_WORKTREE_DIR:-$(dirname "$main_root")/worktrees}
wt_root="$wt_base/$project"
pi_cmd=${TICKETS_PI_CMD:-pi}
launcher=${TICKETS_LAUNCHER:-tmux}

valid_slug() { [[ $1 =~ ^[a-z0-9][a-z0-9._-]{0,47}$ ]]; }

# Parse FILE into parallel arrays slugs/prompts/bodies.
parse_tickets() {
	local file=$1 default_prompt=$2 label=$1 line slug="" prompt="" body="" in_ticket=0
	if [[ $file == - ]]; then
		file=/dev/stdin label=stdin
	fi
	slugs=() prompts=() bodies=()
	flush() {
		if ((in_ticket)); then
			# Trim leading/trailing blank lines.
			body=$(printf '%s' "$body" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')
			[[ -n $body ]] || die "ticket '$slug' has no text"
			slugs+=("$slug") prompts+=("$prompt") bodies+=("$body")
		fi
	}
	while IFS= read -r line || [[ -n $line ]]; do
		if [[ $line =~ ^##[[:space:]]+([^[:space:]]+)([[:space:]]+([^[:space:]]+))?[[:space:]]*$ ]]; then
			flush
			slug=${BASH_REMATCH[1]} prompt=${BASH_REMATCH[3]:-$default_prompt} body="" in_ticket=1
			valid_slug "$slug" || die "invalid slug '$slug' (use lowercase letters, digits, . _ -)"
		elif ((in_ticket)); then
			body+="$line"$'\n'
		elif [[ -n ${line//[[:space:]]/} ]]; then
			die "text before the first '## <slug>' heading in $label"
		fi
	done <"$file"
	flush
	((${#slugs[@]})) || die "no tickets found in $label (expected '## <slug>' headings)"

	local i j
	for i in "${!slugs[@]}"; do
		[[ -f "$main_root/.pi/prompts/${prompts[i]}.md" ]] ||
			die "ticket '${slugs[i]}': no prompt .pi/prompts/${prompts[i]}.md"
		for ((j = i + 1; j < ${#slugs[@]}; j++)); do
			[[ ${slugs[i]} != "${slugs[j]}" ]] || die "duplicate slug '${slugs[i]}'"
		done
	done
}

# Quote for bash and zsh: wrap in single quotes, escaping embedded ones.
shell_quote() {
	local q="'\\''"
	printf "'%s'" "${1//\'/$q}"
}

# The pi command for a ticket, to run inside its worktree.
# PI_TICKET goes on the command, not `tmux -e`: new-session -e would set it for the
# whole tmux session.
pi_command() {
	local slug=$1 prompt=$2
	local msg="/$prompt My ticket text is in TICKET.md at the repository root (I launched this session with tickets.sh). Read it first; it is the ticket."
	printf 'PI_TICKET=%s %s --approve %s' "$(shell_quote "$slug")" "$(shell_quote "$pi_cmd")" "$(shell_quote "$msg")"
}

launch() {
	case $launcher in
	tmux) launch_tmux "$@" ;;
	print) launch_print "$@" ;;
	esac
}

launch_print() {
	local slug=$1 dir=$2 prompt=$3
	printf '  cd %s && %s\n' "$(shell_quote "$dir")" "$(pi_command "$slug" "$prompt")"
}

launch_tmux() {
	local slug=$1 dir=$2 prompt=$3
	local cmd
	# Keep the window open in a shell in the worktree after pi exits.
	cmd="$(pi_command "$slug" "$prompt"); exec \"\${SHELL:-bash}\""
	if [[ -n ${TMUX:-} ]]; then
		tmux new-window -d -n "$slug" -c "$dir" "$cmd"
	else
		local session="$project-tickets"
		if tmux has-session -t "=$session" 2>/dev/null; then
			tmux new-window -d -t "=$session:" -n "$slug" -c "$dir" "$cmd"
		else
			tmux new-session -d -s "$session" -n "$slug" -c "$dir" "$cmd"
		fi
	fi
}

# Gitignored installs under .pi/ that worktrees share with the main checkout through symlinks.
pi_installs=(npm git)

# Share pi's installed project packages with the worktree instead of reinstalling them.
link_pi_packages() {
	local dir=$1 sub
	for sub in "${pi_installs[@]}"; do
		if [[ -d "$main_root/.pi/$sub" && ! -e "$dir/.pi/$sub" && ! -L "$dir/.pi/$sub" ]]; then
			mkdir -p "$(dirname "$dir/.pi/$sub")"
			ln -s "$main_root/.pi/$sub" "$dir/.pi/$sub"
		fi
	done
}

cmd_start() {
	local default_prompt=solo base=HEAD file="" dry_run=0
	while (($#)); do
		case $1 in
		--prompt) default_prompt=${2:?--prompt needs a value}; shift 2 ;;
		--base) base=${2:?--base needs a value}; shift 2 ;;
		--dry-run) dry_run=1; shift ;;
		-h | --help) usage 0 ;;
		-) [[ -z $file ]] || die "only one FILE"; file=-; shift ;;
		-*) die "unknown option $1" ;;
		*) [[ -z $file ]] || die "only one FILE"; file=$1; shift ;;
		esac
	done
	[[ -n $file ]] || usage
	[[ $file == - || -f $file ]] || die "no such file: $file"
	case $launcher in
	tmux) ((dry_run)) || command -v tmux >/dev/null ||
		die "tmux not found; install it or set TICKETS_LAUNCHER=print" ;;
	print) ;;
	*) die "unknown TICKETS_LAUNCHER '$launcher' (use tmux or print)" ;;
	esac

	parse_tickets "$file" "$default_prompt"

	local base_commit
	base_commit=$(git -C "$main_root" rev-parse --verify --quiet "$base^{commit}") || die "unknown ref '$base'"
	if ! git -C "$main_root" diff --quiet HEAD -- 2>/dev/null; then
		echo "tickets: warning: uncommitted changes in $main_root are not part of the tickets" >&2
	fi
	git -C "$main_root" check-ignore -q TICKET.md ||
		die "TICKET.md is not gitignored in $project; add it to .gitignore first"

	# Check everything before creating anything.
	local i slug dir
	for slug in "${slugs[@]}"; do
		git -C "$main_root" show-ref --verify --quiet "refs/heads/ticket/$slug" &&
			die "branch ticket/$slug already exists"
		[[ ! -e "$wt_root/$slug" ]] || die "$wt_root/$slug already exists"
	done

	if ((dry_run)); then
		for i in "${!slugs[@]}"; do
			echo "would start ${slugs[i]} (/${prompts[i]}) on ticket/${slugs[i]} in $wt_root/${slugs[i]}"
		done
		echo "dry run: all checks passed, nothing created (launcher: $launcher)"
		return 0
	fi

	mkdir -p "$wt_root"
	for i in "${!slugs[@]}"; do
		slug=${slugs[i]} dir="$wt_root/$slug"
		git -C "$main_root" worktree add --quiet -b "ticket/$slug" "$dir" "$base_commit"
		link_pi_packages "$dir"
		printf '%s\n' "${bodies[i]}" >"$dir/TICKET.md"
		if [[ $launcher == print ]]; then
			echo "created $slug (/${prompts[i]}) on ticket/$slug in $dir; start it with:"
			launch "$slug" "$dir" "${prompts[i]}"
		else
			launch "$slug" "$dir" "${prompts[i]}"
			echo "started $slug (/${prompts[i]}) on ticket/$slug in $dir"
		fi
	done

	if [[ $launcher == tmux && -z ${TMUX:-} ]]; then
		echo
		echo "attach with: tmux attach -t '$project-tickets'"
	fi
}

cmd_list() {
	local path="" branch="" line
	printf '%-24s %-10s %s\n' TICKET STATUS WORKTREE
	while IFS= read -r line; do
		case $line in
		"worktree "*) path=${line#worktree } branch="" ;;
		"branch refs/heads/ticket/"*) branch=${line#branch refs/heads/ticket/} ;;
		"")
			if [[ -n $branch ]]; then
				local status=clean
				[[ -z $(git -C "$path" status --porcelain 2>/dev/null) ]] || status=dirty
				local ahead
				ahead=$(git -C "$main_root" rev-list --count "HEAD..ticket/$branch" 2>/dev/null || echo "?")
				printf '%-24s %-10s %s (%s commits ahead of HEAD)\n' "$branch" "$status" "$path" "$ahead"
			fi
			path="" branch=""
			;;
		esac
	done < <(git -C "$main_root" worktree list --porcelain; echo)
}

cmd_remove() {
	local slug=${1:-}
	[[ -n $slug ]] || usage
	valid_slug "$slug" || die "invalid slug '$slug'"
	local dir="$wt_root/$slug"
	git -C "$main_root" show-ref --verify --quiet "refs/heads/ticket/$slug" ||
		die "no branch ticket/$slug"
	git -C "$main_root" merge-base --is-ancestor "ticket/$slug" HEAD ||
		die "ticket/$slug is not merged into $(git -C "$main_root" branch --show-current); merge it first"
	if [[ -d $dir ]]; then
		# TICKET.md and the package symlinks are gitignored, so they do not count here.
		[[ -z $(git -C "$dir" status --porcelain) ]] ||
			die "worktree $dir has uncommitted changes; commit or discard them first"
		local sub
		for sub in "${pi_installs[@]}"; do
			# rm on a symlink removes only the link, never the shared install.
			if [[ -L "$dir/.pi/$sub" ]]; then rm "$dir/.pi/$sub"; fi
		done
		rm -f "$dir/TICKET.md"
		git -C "$main_root" worktree remove "$dir"
	fi
	git -C "$main_root" branch -d "ticket/$slug"
}

case ${1:-} in
start) shift; cmd_start "$@" ;;
list) shift; cmd_list ;;
remove) shift; cmd_remove "$@" ;;
-h | --help) usage 0 ;;
*) usage ;;
esac
