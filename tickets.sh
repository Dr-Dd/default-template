#!/usr/bin/env bash
# Run several tickets in parallel: one git worktree, branch and pi session per ticket.
#
#   ./tickets.sh start [--prompt solo|advised] [--base REF] [--dry-run] FILE|-
#   ./tickets.sh list             (status, open tmux session, commits since the ticket started)
#   ./tickets.sh remove SLUG      (after you merged it: removes worktree and branch; refuses
#                                  while SPEC.md or .review/ exists or a tmux pane is open there)
#
# FILE (or stdin with "-") holds one ticket per "## ticket: <slug> [prompt]" line; the text below it
# (up to the next "## ticket:" line) is the ticket. Other lines, including "## " headings, are
# ticket text:
#
#   ## ticket: fix-login
#   Login fails when the email has uppercase letters. ...
#
#   ## ticket: csv-export advised
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
#          "<project>-tickets", and a new Ghostty window attached to it opens (see
#          TICKETS_ATTACH).
#   TICKETS_ATTACH=0 turns that window off. It also stays off over ssh, without a
#          desktop session, without ghostty, or when a client is already attached;
#          then attach yourself with the printed `tmux attach` command.
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
	sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
# Detached tmux session for tickets started outside tmux.
# tmux reads "." and ":" in a target as window/pane separators, so keep only safe characters
# (a project "my.app" gets session "my_app-tickets").
session="${project//[^A-Za-z0-9_-]/_}-tickets"

# The character set keeps slugs readable; check-ref-format rejects the rest git refuses as a
# branch name ("..", a trailing "." or ".lock", ...).
valid_slug() {
	[[ $1 =~ ^[a-z0-9][a-z0-9._-]{0,47}$ ]] &&
		git check-ref-format --branch "ticket/$1" >/dev/null 2>&1
}

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
		if [[ $line =~ ^##[[:space:]]+ticket:[[:space:]]*([^[:space:]]+)([[:space:]]+([^[:space:]]+))?[[:space:]]*$ ]]; then
			flush
			slug=${BASH_REMATCH[1]} prompt=${BASH_REMATCH[3]:-$default_prompt} body="" in_ticket=1
			valid_slug "$slug" ||
				die "invalid slug '$slug' (use lowercase letters, digits, . _ -; no '..', no trailing '.' or '.lock')"
		elif ((in_ticket)); then
			body+="$line"$'\n'
		elif [[ -n ${line//[[:space:]]/} ]]; then
			die "text before the first '## ticket: <slug>' line in $label"
		fi
	done <"$file"
	flush
	((${#slugs[@]})) || die "no tickets found in $label (expected '## ticket: <slug>' lines)"

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

# `env` arguments that give a tmux-launched session this shell's environment where it matters.
# tmux starts windows with the environment its server had when it started, not this shell's,
# so an activated venv/nvm (PATH) or a changed variable would otherwise not reach the ticket.
# Run from pi (/fanout), check-guard's BASH_ENV hook is set for this script: hand the session
# the BASH_ENV pi itself was started with instead, and drop check-guard's variables.
session_env() {
	local bash_env=${BASH_ENV-} unset=(-u PI_CHECK_GUARD_ROOT -u PI_CHECK_GUARD_BASH_ENV) set=("PATH=$PATH") a out=""
	[[ -z ${PI_CHECK_GUARD_ROOT-} ]] || bash_env=${PI_CHECK_GUARD_BASH_ENV-}
	if [[ -n $bash_env ]]; then set+=("BASH_ENV=$bash_env"); else unset+=(-u BASH_ENV); fi
	if [[ -n ${PI_CHECK_MAX_FAILURES+x} ]]; then
		set+=("PI_CHECK_MAX_FAILURES=$PI_CHECK_MAX_FAILURES")
	else
		unset+=(-u PI_CHECK_MAX_FAILURES)
	fi
	# env takes options only before the first NAME=VALUE.
	for a in "${unset[@]}" "${set[@]}"; do out+=" $(shell_quote "$a")"; done
	printf 'env%s' "$out"
}

# The pi command for a ticket, to run inside its worktree.
pi_command() {
	local prompt=$1
	local msg="/$prompt My ticket text is in TICKET.md at the repository root (I launched this session with tickets.sh). Read it first; it is the ticket."
	printf '%s --approve %s' "$(shell_quote "$pi_cmd")" "$(shell_quote "$msg")"
}

launch() {
	case $launcher in
	tmux) launch_tmux "$@" ;;
	print) launch_print "$@" ;;
	esac
}

launch_print() {
	local slug=$1 dir=$2 prompt=$3
	printf '  cd %s && %s\n' "$(shell_quote "$dir")" "$(pi_command "$prompt")"
}

launch_tmux() {
	local slug=$1 dir=$2 prompt=$3
	local cmd
	# Keep the window open in a shell in the worktree after pi exits.
	cmd="$(session_env) $(pi_command "$prompt"); exec \"\${SHELL:-bash}\""
	if [[ -n ${TMUX:-} ]]; then
		tmux new-window -d -n "$slug" -c "$dir" "$cmd"
	else
		if tmux has-session -t "=$session" 2>/dev/null; then
			tmux new-window -d -t "=$session:" -n "$slug" -c "$dir" "$cmd"
		else
			tmux new-session -d -s "$session" -n "$slug" -c "$dir" "$cmd"
		fi
	fi
}

# After launching outside tmux: open a Ghostty window attached to the tickets session,
# so the tickets show up without attaching by hand. `ghostty +new-window` asks the
# running Ghostty (over D-Bus) for one more window and returns right away.
# Prints why when it doesn't open one; the caller then prints the attach command.
open_attach_window() {
	[[ ${TICKETS_ATTACH:-1} != 0 ]] || { echo "no window: TICKETS_ATTACH=0"; return 1; }
	[[ -z ${SSH_CONNECTION:-} ]] || { echo "no window: running over ssh"; return 1; }
	[[ -n ${WAYLAND_DISPLAY:-}${DISPLAY:-} ]] || { echo "no window: no desktop session"; return 1; }
	command -v ghostty >/dev/null || { echo "no window: ghostty not found"; return 1; }
	local attached
	attached=$(tmux display-message -p -t "=$session:" '#{session_attached}' 2>/dev/null) || attached=0
	if ((attached > 0)); then
		echo "session $session is already open in a terminal"
		return 0
	fi
	if ghostty +new-window -e tmux attach-session -t "=$session" >/dev/null 2>&1; then
		echo "opened a Ghostty window attached to $session"
		return 0
	fi
	echo "no window: ghostty +new-window failed"
	return 1
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

# Refuse if $wt_root already holds worktrees of another repository: two projects with the same
# directory name and a shared TICKETS_WORKTREE_DIR would otherwise mix their tickets.
check_wt_root_owner() {
	[[ -d $wt_root ]] || return 0
	local entry other
	for entry in "$wt_root"/*/; do
		[[ -e $entry.git ]] || continue
		other=$(git -C "$entry" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
		[[ $other -ef $common_dir ]] ||
			die "$wt_root holds worktrees of another repository ($(dirname "$other")); set TICKETS_WORKTREE_DIR to a different directory for one of them"
	done
}

# Slugs whose branch/worktree this run is creating, for rollback_created.
created=()
base_commit=""
created_wt_root=0

# Undo a start that failed (or was interrupted) before any session launched. Removes only what
# this run created: the pre-checks guarantee none of these branches or paths existed before.
rollback_created() {
	local slug dir sub
	((${#created[@]})) || return 0
	set +e
	echo "tickets: start failed; rolling back ${#created[@]} ticket(s)" >&2
	for slug in "${created[@]}"; do
		dir="$wt_root/$slug"
		if [[ -d $dir ]]; then
			for sub in "${pi_installs[@]}"; do
				if [[ -L "$dir/.pi/$sub" ]]; then rm "$dir/.pi/$sub"; fi
			done
			# --force: the fresh worktree holds only TICKET.md, which is untracked.
			git -C "$main_root" worktree remove --force "$dir" >/dev/null 2>&1 ||
				echo "tickets: could not remove $dir; remove it by hand" >&2
		fi
		# git can leave the branch behind when `worktree add -b` fails. Delete it only if it
		# still points at the base commit, i.e. nothing was committed on it.
		local head
		head=$(git -C "$main_root" rev-parse --verify --quiet "refs/heads/ticket/$slug")
		if [[ $head == "$base_commit" ]]; then
			git -C "$main_root" branch -D "ticket/$slug" >/dev/null 2>&1 ||
				echo "tickets: could not delete branch ticket/$slug" >&2
		elif [[ -n $head ]]; then
			echo "tickets: kept branch ticket/$slug: it has commits not in the base" >&2
		fi
		echo "tickets: rolled back $slug" >&2
	done
	if ((created_wt_root)); then rmdir "$wt_root" 2>/dev/null; fi
	created=()
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

	base_commit=$(git -C "$main_root" rev-parse --verify --quiet "$base^{commit}") || die "unknown ref '$base'"
	# A readable name for the base, for `list`: the branch for HEAD, else the ref as given.
	local base_name=$base
	if [[ $base == HEAD ]]; then
		base_name=$(git -C "$main_root" branch --show-current)
		[[ -n $base_name ]] || base_name=HEAD
	fi
	if ! git -C "$main_root" diff --quiet HEAD -- 2>/dev/null; then
		echo "tickets: warning: uncommitted changes in $main_root are not part of the tickets" >&2
	fi
	git -C "$main_root" check-ignore -q TICKET.md ||
		die "TICKET.md is not gitignored in $project; add it to .gitignore first"

	# Check everything before creating anything.
	check_wt_root_owner
	# git stores branches as files under refs/heads/: a branch named exactly "ticket" is a file
	# where the ticket/ folder would go, so no ticket/<slug> branch can be created.
	! git -C "$main_root" show-ref --verify --quiet refs/heads/ticket ||
		die "a branch named 'ticket' exists, so no ticket/<slug> branch can be created; rename it (git branch -m ticket <new-name>)"
	local i slug dir
	for slug in "${slugs[@]}"; do
		# Same in reverse: an existing ticket/<slug>/... branch blocks ticket/<slug>.
		[[ -z $(git -C "$main_root" for-each-ref --count=1 --format=x "refs/heads/ticket/$slug/") ]] ||
			die "branches under ticket/$slug/ exist, so branch ticket/$slug cannot be created; rename them or choose another slug"
		git -C "$main_root" show-ref --verify --quiet "refs/heads/ticket/$slug" &&
			die "branch ticket/$slug already exists"
		[[ ! -e "$wt_root/$slug" ]] || die "$wt_root/$slug already exists"
		# A worktree deleted by hand stays registered until pruned, and `worktree add` refuses it.
		! git -C "$main_root" worktree list --porcelain | grep -qxF "worktree $wt_root/$slug" ||
			die "$wt_root/$slug is still registered as a worktree; run 'git worktree prune' first"
	done

	if ((dry_run)); then
		for i in "${!slugs[@]}"; do
			echo "would start ${slugs[i]} (/${prompts[i]}) on ticket/${slugs[i]} in $wt_root/${slugs[i]}"
		done
		echo "dry run: all checks passed, nothing created (launcher: $launcher)"
		return 0
	fi

	# Phase 1: create every worktree. Any failure (or Ctrl-C) rolls back all of them, so a
	# start either sets up every ticket or none.
	trap rollback_created EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	[[ -d $wt_root ]] || created_wt_root=1
	mkdir -p "$wt_root"
	for i in "${!slugs[@]}"; do
		slug=${slugs[i]} dir="$wt_root/$slug"
		created+=("$slug")
		git -C "$main_root" worktree add --quiet -b "ticket/$slug" "$dir" "$base_commit"
		# Remembered for `list`; git deletes branch config together with the branch.
		git -C "$main_root" config "branch.ticket/$slug.ticketsBase" "$base_commit"
		git -C "$main_root" config "branch.ticket/$slug.ticketsBaseRef" "$base_name"
		link_pi_packages "$dir"
		printf '%s\n' "${bodies[i]}" >"$dir/TICKET.md"
	done
	created=()
	trap - EXIT INT TERM

	# Phase 2: launch. Sessions that started are not undone if a later launch fails: a failed
	# launch is reported and the rest still start. Its worktree stays, to start by hand or remove.
	local not_started=()
	for i in "${!slugs[@]}"; do
		slug=${slugs[i]} dir="$wt_root/$slug"
		if [[ $launcher == print ]]; then
			echo "created $slug (/${prompts[i]}) on ticket/$slug in $dir; start it with:"
			launch "$slug" "$dir" "${prompts[i]}"
		elif launch "$slug" "$dir" "${prompts[i]}"; then
			echo "started $slug (/${prompts[i]}) on ticket/$slug in $dir"
		else
			echo "tickets: could not start a session for $slug (error above)" >&2
			not_started+=("$i")
		fi
	done
	if ((${#not_started[@]})); then
		echo >&2
		echo "tickets: ${#not_started[@]} ticket(s) were created but not started. Start each by hand, or remove it with ./tickets.sh remove <slug>:" >&2
		for i in "${not_started[@]}"; do
			launch_print "${slugs[i]}" "$wt_root/${slugs[i]}" "${prompts[i]}" >&2
		done
	fi

	if [[ $launcher == tmux && -z ${TMUX:-} ]] && ((${#not_started[@]} < ${#slugs[@]})); then
		echo
		open_attach_window || echo "attach with: tmux attach -t '$session'"
	fi
	# Non-zero so callers (/fanout) notice; the worktrees above are kept either way.
	((${#not_started[@]} == 0))
}

# Where a ticket started: the commit and ref name `start` stored in the branch's config (git
# deletes it with the branch). Tickets started before that fall back to the merge base with the
# main checkout's HEAD. Prints "<commit> <ref>".
ticket_base() {
	local slug=$1 commit ref
	commit=$(git -C "$main_root" config --get "branch.ticket/$slug.ticketsBase" 2>/dev/null) || commit=""
	ref=$(git -C "$main_root" config --get "branch.ticket/$slug.ticketsBaseRef" 2>/dev/null) || ref=""
	if [[ -z $commit ]]; then
		commit=$(git -C "$main_root" merge-base HEAD "ticket/$slug" 2>/dev/null) || commit=""
		ref=""
	fi
	printf '%s %s' "${commit:-?}" "${ref:-?}"
}

cmd_list() {
	local path="" branch="" line panes="" have_tmux=0
	# Working directories of all tmux panes, read once (none if no server runs). Without tmux the
	# session column shows "?". Sessions started with TICKETS_LAUNCHER=print are never visible.
	if command -v tmux >/dev/null; then
		have_tmux=1
		panes=$(tmux list-panes -a -F '#{pane_current_path}' 2>/dev/null) || panes=""
	fi
	printf '%-24s %-7s %-8s %-8s %-24s %s\n' TICKET STATUS SESSION COMMITS BASE WORKTREE
	while IFS= read -r line; do
		case $line in
		"worktree "*) path=${line#worktree } branch="" ;;
		"branch refs/heads/ticket/"*) branch=${line#branch refs/heads/ticket/} ;;
		"")
			if [[ -n $branch ]]; then
				local status=clean session="?" base commit ref commits
				[[ -z $(git -C "$path" status --porcelain 2>/dev/null) ]] || status=dirty
				if ((have_tmux)); then
					session=-
					panes_in "$path" <<<"$panes" && session=open
				fi
				base=$(ticket_base "$branch") commit=${base%% *} ref=${base#* }
				# Commits on the ticket since it started: the same whatever the main checkout has
				# checked out now.
				commits=$(git -C "$main_root" rev-list --count "$commit..ticket/$branch" 2>/dev/null) || commits="?"
				[[ $commit == "?" ]] || commit=${commit:0:7}
				printf '%-24s %-7s %-8s %-8s %-24s %s\n' "$branch" "$status" "$session" "$commits" "$ref@$commit" "$path"
			fi
			path="" branch=""
			;;
		esac
	done < <(git -C "$main_root" worktree list --porcelain; echo)
	printf '\nSESSION: open = a tmux pane is in the worktree, - = none (sessions not run in tmux are not seen).\n'
	printf 'COMMITS: commits on the ticket since it started from BASE (ref@commit).\n'
}

# True if a path read from stdin (one per line) is dir or inside it.
panes_in() {
	local dir
	dir=$(cd "$1" 2>/dev/null && pwd -P) || return 1
	D=$dir awk '$0 == ENVIRON["D"] || index($0, ENVIRON["D"] "/") == 1 { found = 1 } END { exit !found }'
}

# Refuse while a tmux pane (pi, or the shell left after it) has its working directory inside the
# worktree: removing it would leave that session in a deleted directory. Only tmux panes are
# visible here; sessions started with TICKETS_LAUNCHER=print are not.
check_no_pane() {
	local dir here
	dir=$(cd "$1" && pwd -P)
	here=$(pwd -P)
	if [[ $here == "$dir" || $here == "$dir"/* ]]; then
		die "you are inside $1; run remove from the main checkout"
	fi
	command -v tmux >/dev/null || return 0
	if tmux list-panes -a -F '#{pane_current_path}' 2>/dev/null | panes_in "$dir"; then
		die "a tmux pane is still open in $1; quit pi there and close the window first"
	fi
}

# The slug argument of remove: valid, with an existing ticket branch.
check_slug_arg() {
	local slug=$1
	[[ -n $slug ]] || usage
	valid_slug "$slug" || die "invalid slug '$slug'"
	git -C "$main_root" show-ref --verify --quiet "refs/heads/ticket/$slug" ||
		die "no branch ticket/$slug"
}

# Refuse while the ticket's worktree (if it still exists) holds unfinished work or an open session.
check_ticket_done() {
	local dir=$1 f
	[[ -d $dir ]] || return 0
	# AGENTS.md deletes SPEC.md and .review/ only after the ticket's commit succeeded. Both are
	# gitignored, so the status check below would not see them.
	for f in SPEC.md .review; do
		[[ ! -e $dir/$f ]] ||
			die "$dir/$f exists, so the ticket did not finish; finish it, or delete $f if you are sure"
	done
	check_no_pane "$dir"
	# TICKET.md and the package symlinks are gitignored, so they do not count here.
	[[ -z $(git -C "$dir" status --porcelain) ]] ||
		die "worktree $dir has uncommitted changes; commit or discard them first"
}

cmd_remove() {
	local slug=${1:-}
	check_slug_arg "$slug"
	local dir="$wt_root/$slug"
	git -C "$main_root" merge-base --is-ancestor "ticket/$slug" HEAD ||
		die "ticket/$slug is not merged into $(git -C "$main_root" branch --show-current); merge it first"
	check_ticket_done "$dir"
	if [[ -d $dir ]]; then
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
