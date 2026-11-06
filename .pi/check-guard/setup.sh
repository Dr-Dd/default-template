#!/usr/bin/env bash
# Install the tree-sitter runtime and grammars that check-guard uses for `unitGuardedFiles`
# (see .pi/check-guard.json). Run it in the main checkout; ticket worktrees share the install
# through a symlink that tickets.sh creates.
#
#   .pi/check-guard/setup.sh LANGUAGE...     e.g. setup.sh python typescript
#
# LANGUAGE is one of: python javascript typescript go rust java lua,
# or an npm package name that ships a grammar .wasm (for the "generic" preset).
#
# Writes package.json and package-lock.json here (commit them) and installs into node_modules
# (gitignored). Install scripts are skipped: only the prebuilt .wasm files are needed.

set -euo pipefail

die() {
	echo "check-guard setup: $*" >&2
	exit 1
}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
(($#)) || die "usage: $0 LANGUAGE... (python javascript typescript go rust java lua, or an npm package)"
command -v npm >/dev/null || die "npm not found"
[[ ! -L "$here/node_modules" ]] ||
	die "$here/node_modules is a symlink to a shared install (a ticket worktree?); run this in the main checkout"

# Versions tested with web-tree-sitter 0.27 (grammar ABI 14-15).
pkgs=("web-tree-sitter@~0.27.1")
for lang in "$@"; do
	case $lang in
	python) pkgs+=("tree-sitter-python@~0.25.0") ;;
	javascript) pkgs+=("tree-sitter-javascript@~0.25.0") ;;
	typescript) pkgs+=("tree-sitter-typescript@~0.23.2" "tree-sitter-javascript@~0.25.0") ;;
	go) pkgs+=("tree-sitter-go@~0.25.0") ;;
	rust) pkgs+=("tree-sitter-rust@~0.24.0") ;;
	java) pkgs+=("tree-sitter-java@~0.23.5") ;;
	lua) pkgs+=("@tree-sitter-grammars/tree-sitter-lua@~0.4.1") ;;
	-*) die "unknown option $lang" ;;
	*) pkgs+=("$lang") ;;
	esac
done

cd "$here"
[[ -f package.json ]] || printf '{\n  "name": "check-guard-grammars",\n  "private": true\n}\n' >package.json
npm install --ignore-scripts --no-audit --no-fund --save "${pkgs[@]}"
echo "check-guard setup: installed ${pkgs[*]}"
echo "Commit $here/package.json and package-lock.json; node_modules stays untracked."
