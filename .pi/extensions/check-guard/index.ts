/**
 * check-guard: makes ./check.sh the project's single, approval-gated check.
 *
 * - `check` tool: runs ./check.sh and reports its exit code to pi.
 * - Running check.sh through bash is blocked, so the exit code cannot be hidden.
 * - After PI_CHECK_MAX_FAILURES (default 3) failing `check` runs in a row, the
 *   agent is stopped until the user sends a new message.
 * - Protected files are configured in .pi/check-guard.json (read at session start and on each
 *   user message; see the README):
 *   - `guardedFiles`: changing or deleting an existing file needs the user's approval. Creating
 *     one that does not exist yet is allowed. check-guard.json itself is always guarded.
 *   - `unitGuardedFiles`: only changes to code that exists in the base commit (HEAD when the
 *     session started or the user last sent a message) need approval: modifying, removing or
 *     renaming a function/test/class/statement from that commit, or adding code that changes how
 *     existing tests run (focused tests, new hooks in existing suites, mocks, ...). New code is
 *     free. Files are parsed with tree-sitter (see units.ts; install with .pi/check-guard/setup.sh).
 *     If parsing is unavailable they are guarded like `guardedFiles`.
 *   write/edit ask first; changes made through bash are detected afterwards and the whole file is
 *   reverted unless approved.
 *   The approval dialog shows the full diff (scrollable in the TUI; `c` toggles
 *   the whole file). PI_CHECK_DIFF_CONTEXT sets the context lines (default 4).
 */

import { execFile } from "node:child_process";
import { chmod, glob, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	generateDiffString,
	isToolCallEventType,
	renderDiff,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { compare, type Extracted, type Issue, PRESETS, type Preset, parserFor } from "./units.ts";

/** The project check script run by the `check` tool. */
const CHECK_FILE = "check.sh";
/** Per-project configuration (relative to the project root). Always guarded as a whole file. */
const CONFIG_FILE = ".pi/check-guard.json";
/** guardedFiles when there is no config file. */
const DEFAULT_GUARDED: readonly string[] = ["check.sh"];
/** Always guarded as whole files: the guard's own configuration and code. */
const ALWAYS_GUARDED: readonly string[] = [CONFIG_FILE, ".pi/extensions/check-guard/**", ".pi/check-guard/**"];
/** Guarded files whose creation also needs approval (a new config could drop guards). */
const GUARD_CREATION: readonly string[] = [CONFIG_FILE];
/** Directories never searched for guarded files. */
const GLOB_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", ".tox", "__pycache__"]);
const DEFAULT_MAX_FAILURES = 3;

/** check.sh invoked as a command: `./check.sh`, `bash check.sh`, `sh -c './check.sh'`, `source check.sh`, ... */
const CHECK_INVOCATION =
	/(?:^|[\n;&|(`]|\$\()\s*(?:(?:\w+=\S*|exec|time|nohup|env|command|nice|timeout(?:\s+(?:-\S+|[A-Z]+))*\s+\S+)\s+)*(?:(?:ba|da|z|k)?sh\s+(?:-\S+\s+)*|source\s+|\.\s+)?["']?(?:\S*\/)?check\.sh(?![\w.-])/;

/** lstat fields that change whenever a file's content or mode changes (ctime cannot be set by user programs). */
type Stamp = { dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint };

type Snapshot =
	| { exists: false }
	| {
			exists: true;
			content: Buffer;
			mode: number;
			/** lstat taken before reading; undefined when it cannot be trusted to detect changes. */
			stamp?: Stamp;
		};

/**
 * A file changed this close to the snapshot may be changed again without its timestamps moving
 * (coarse filesystem clocks, e.g. 2 s on FAT), so its stamp is not trusted, as git does for "racy" files.
 */
const RACY_WINDOW_NS = 2_000_000_000n;

function maxFailures(): number {
	const raw = process.env.PI_CHECK_MAX_FAILURES;
	const n = raw === undefined ? NaN : Number(raw);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FAILURES;
}

async function takeSnapshot(file: string): Promise<Snapshot> {
	const takenAtNs = BigInt(Date.now()) * 1_000_000n;
	try {
		// Stat before reading: if the file changes in between, the stamp is older than the content,
		// which only causes an extra read later, never a missed change.
		const st = await lstat(file, { bigint: true });
		if (!st.isFile()) return { exists: true, content: Buffer.alloc(0), mode: -1 };
		const stamp: Stamp = {
			dev: st.dev,
			ino: st.ino,
			size: st.size,
			mode: st.mode,
			mtimeNs: st.mtimeNs,
			ctimeNs: st.ctimeNs,
		};
		const racy = st.mtimeNs >= takenAtNs - RACY_WINDOW_NS || st.ctimeNs >= takenAtNs - RACY_WINDOW_NS;
		return {
			exists: true,
			content: await readFile(file),
			mode: Number(st.mode & 0o7777n),
			stamp: racy ? undefined : stamp,
		};
	} catch {
		return { exists: false };
	}
}

function sameStamp(a: Stamp, b: Stamp): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mode === b.mode &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

/** `prev` itself if lstat shows the file is untouched (no read), otherwise a fresh snapshot. */
async function resnapshot(file: string, prev: Snapshot | undefined): Promise<Snapshot> {
	if (prev?.exists && prev.stamp) {
		try {
			const st = await lstat(file, { bigint: true });
			const now: Stamp = {
				dev: st.dev,
				ino: st.ino,
				size: st.size,
				mode: st.mode,
				mtimeNs: st.mtimeNs,
				ctimeNs: st.ctimeNs,
			};
			if (st.isFile() && sameStamp(prev.stamp, now)) return prev;
		} catch {
			// Gone or unreadable: fall through to a full snapshot.
		}
	}
	return takeSnapshot(file);
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
	if (!a.exists || !b.exists) return a.exists === b.exists;
	return a.mode === b.mode && a.content.equals(b.content);
}

async function restoreSnapshot(file: string, snap: Snapshot): Promise<void> {
	// Not a regular file before (symlink, directory): nothing we can restore faithfully, so leave it.
	if (snap.exists && snap.mode === -1) return;
	await rm(file, { recursive: true, force: true });
	if (!snap.exists) return;
	// The parent directory may have been removed too (e.g. `rm -r dir`).
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, snap.content);
	await chmod(file, snap.mode);
}

/** Path relative to cwd with `/` separators, or undefined if it is outside cwd. */
function relPath(cwd: string, abs: string): string | undefined {
	const rel = relative(cwd, abs);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

/** How a file is protected: as a whole, or per unit of code from the base commit. */
type Rule = { kind: "file" } | { kind: "units"; preset: Preset; grammar?: string };

type Config = {
	guarded: string[];
	units: { files: string[]; preset: Preset; grammar?: string }[];
	/** Problems found while reading the config (shown to the user). */
	errors: string[];
};

const WHOLE_FILE: Rule = { kind: "file" };

function ruleFor(cfg: Config, rel: string | undefined): Rule | undefined {
	if (rel === undefined) return undefined;
	if ([...ALWAYS_GUARDED, ...cfg.guarded].some((g) => matchesGlob(rel, g))) return WHOLE_FILE;
	const u = cfg.units.find((e) => e.files.some((g) => matchesGlob(rel, g)));
	return u && { kind: "units", preset: u.preset, grammar: u.grammar };
}

const isGuardedRel = (cfg: Config, rel: string | undefined): rel is string => ruleFor(cfg, rel) !== undefined;

/**
 * Read CONFIG_FILE. Problems never weaken protection: an invalid unit entry guards its files as
 * whole files, and an unreadable config keeps the default guardedFiles.
 */
async function loadConfig(cwd: string): Promise<Config> {
	const cfg: Config = { guarded: [...DEFAULT_GUARDED], units: [], errors: [] };
	let raw: string;
	try {
		raw = await readFile(resolve(cwd, CONFIG_FILE), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") cfg.errors.push(`cannot read ${CONFIG_FILE}: ${String(err)}`);
		return cfg;
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		cfg.errors.push(`${CONFIG_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
		return cfg;
	}
	const strings = (v: unknown): string[] | undefined =>
		typeof v === "string" ? [v] : Array.isArray(v) && v.every((s) => typeof s === "string") ? v : undefined;
	const obj = (json ?? {}) as Record<string, unknown>;
	if (obj.guardedFiles !== undefined) {
		const g = strings(obj.guardedFiles);
		if (g) cfg.guarded = g;
		else cfg.errors.push(`${CONFIG_FILE}: guardedFiles must be a list of globs`);
	}
	const entries = obj.unitGuardedFiles ?? [];
	if (!Array.isArray(entries)) {
		cfg.errors.push(`${CONFIG_FILE}: unitGuardedFiles must be a list`);
		return cfg;
	}
	for (const [i, e] of entries.entries()) {
		const entry = (e ?? {}) as Record<string, unknown>;
		const files = strings(entry.files);
		const preset = typeof entry.preset === "string" ? PRESETS[entry.preset] : undefined;
		const grammar = typeof entry.grammar === "string" ? entry.grammar : undefined;
		if (!files) {
			cfg.errors.push(`${CONFIG_FILE}: unitGuardedFiles[${i}] needs "files"`);
			continue;
		}
		if (!preset || (entry.preset === "generic" && !grammar)) {
			cfg.errors.push(
				`${CONFIG_FILE}: unitGuardedFiles[${i}] has no valid "preset"` +
					`${entry.preset === "generic" ? ' ("generic" needs "grammar")' : ` (one of ${Object.keys(PRESETS).join(", ")})`}; ` +
					"its files are guarded as whole files",
			);
			cfg.guarded.push(...files);
			continue;
		}
		cfg.units.push({ files, preset, grammar });
	}
	return cfg;
}

/**
 * Guarded files that currently exist, relative to cwd. Directories are skipped: a glob guards
 * files (use `dir/**` for everything inside a directory), and a directory cannot be restored.
 */
async function guardedFiles(cwd: string, cfg: Config): Promise<string[]> {
	const found = new Set<string>();
	const exclude = (p: string) => p.split(/[\\/]/).some((part) => GLOB_SKIP_DIRS.has(part));
	const patterns = [...ALWAYS_GUARDED, ...cfg.guarded, ...cfg.units.flatMap((u) => u.files)];
	for await (const rel of glob(patterns, { cwd, exclude })) {
		const st = await lstat(resolve(cwd, rel)).catch(() => undefined);
		if (st && !st.isDirectory()) found.add(rel.split(sep).join("/"));
	}
	return [...found].sort();
}

/** Whether a tool path (as given to write/edit) exists, without following a final symlink. */
async function exists(cwd: string, raw: string): Promise<boolean> {
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	try {
		await lstat(resolve(cwd, p));
		return true;
	} catch {
		return false;
	}
}

async function realOrSelf(abs: string): Promise<string> {
	try {
		return await realpath(abs);
	} catch {
		return abs;
	}
}

/**
 * Guarded files reached through a symlink (the file itself or a parent directory), keyed by the
 * real path they resolve to. Only these can hide behind an unguarded path: a guarded file that is
 * not behind a symlink is its own real path, which guardedTarget matches against the globs directly.
 */
type Aliases = Map<string, string>;

async function findAliases(cwd: string, cfg: Config): Promise<Aliases> {
	const aliases: Aliases = new Map();
	for (const rel of await guardedFiles(cwd, cfg)) {
		const abs = resolve(cwd, rel);
		const real = await realOrSelf(abs);
		if (real !== abs && !aliases.has(real)) aliases.set(real, rel);
	}
	return aliases;
}

/**
 * The guarded file (relative to cwd) a write/edit path targets, if any. Matches the path as
 * given, its symlink-resolved path, and existing guarded files that resolve to the same file.
 * `aliases` is called only when the target exists and matches no glob itself.
 */
async function guardedTarget(
	cwd: string,
	cfg: Config,
	raw: string,
	aliases: () => Promise<Aliases>,
): Promise<string | undefined> {
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	const abs = resolve(cwd, p);
	const real = await realOrSelf(abs);
	for (const candidate of [abs, real]) {
		const rel = relPath(cwd, candidate);
		if (isGuardedRel(cfg, rel)) return rel;
	}
	// A target that does not exist cannot be the resolved path of an existing guarded file.
	try {
		await lstat(real);
	} catch {
		return undefined;
	}
	return (await aliases()).get(real);
}

/** Snapshots of every guarded file that exists now; files whose lstat matches `before` are reused without being read. */
async function resnapshotGuarded(
	cwd: string,
	cfg: Config,
	before: Map<string, Snapshot>,
): Promise<Map<string, Snapshot>> {
	const snaps = new Map<string, Snapshot>();
	for (const rel of await guardedFiles(cwd, cfg)) snaps.set(rel, await resnapshot(resolve(cwd, rel), before.get(rel)));
	return snaps;
}

/** Output of a git command, or undefined if it fails. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((done) => {
		execFile("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (err, stdout) =>
			done(err ? undefined : stdout),
		);
	});
}

/** The base commit: HEAD, null if the repository has no commits yet, or an error message. */
type Base = { sha: string | null } | { error: string };

async function readBase(cwd: string): Promise<Base> {
	const sha = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	if (sha) return { sha: sha.trim() };
	if ((await git(cwd, ["rev-parse", "--git-dir"])) !== undefined) return { sha: null };
	return { error: "not a git repository, so there is no base commit" };
}

/** A file's content in commit `sha` (rel is relative to cwd), or undefined if it is not in it. */
async function baseContent(cwd: string, sha: string, rel: string): Promise<string | undefined> {
	const spec = `${sha}:./${rel}`;
	if ((await git(cwd, ["cat-file", "-e", spec])) === undefined) return undefined;
	const out = await git(cwd, ["cat-file", "blob", spec]);
	if (out === undefined) throw new Error(`cannot read ${rel} from the base commit`);
	return out;
}

const snapText = (s: Snapshot | undefined) => (s?.exists && s.mode !== -1 ? s.content.toString("utf8") : undefined);

/** Dialog/denial wording for unit issues. */
function describeIssues(issues: Issue[]): { short: string; long: string } {
	const first = issues.slice(0, 2).map((i) => i.text);
	const short = first.join(", ") + (issues.length > 2 ? `, +${issues.length - 2} more` : "");
	const long = issues.map((i) => `line ${i.line}: ${i.text}`).join("\n");
	return { short, long };
}

/** Added/removed line counts from a real line diff. */
function countChanges(before: string, after: string): { removed: number; added: number } {
	let removed = 0;
	let added = 0;
	for (const line of generateDiffString(before, after, 0).diff.split("\n")) {
		if (line.startsWith("-")) removed++;
		else if (line.startsWith("+")) added++;
	}
	return { removed, added };
}

/** File content after applying `edits`, or undefined if an oldText does not match exactly once. */
function applyEdits(content: string, edits: { oldText: string; newText: string }[]): string | undefined {
	let out = content.replace(/\r\n/g, "\n");
	for (const e of edits) {
		const oldText = e.oldText.replace(/\r\n/g, "\n");
		const at = out.indexOf(oldText);
		if (at === -1 || out.indexOf(oldText, at + 1) !== -1) return undefined;
		out = out.slice(0, at) + e.newText.replace(/\r\n/g, "\n") + out.slice(at + oldText.length);
	}
	return out;
}

/** Context lines around each change in the review dialog; `c` toggles the whole file. */
function diffContext(): number {
	const n = Number(process.env.PI_CHECK_DIFF_CONTEXT);
	return Number.isInteger(n) && n >= 0 ? n : 4;
}

type Review = {
	title: string;
	/** Extra lines shown above the diff (e.g. the bash command). */
	header?: string;
	before: string;
	after: string;
	/** Used instead of before/after when the edit cannot be applied to the current file. */
	rawDiff?: string;
};

function buildDiff(r: Review, context: number): string {
	if (r.rawDiff !== undefined) return r.rawDiff;
	return generateDiffString(r.before, r.after, context).diff || "(no textual change)";
}

/**
 * Ask the user to approve a change to a guarded file, showing the full diff.
 * TUI: full-screen scrollable overlay; `y`/`n` pick an answer and Enter confirms it
 * (Esc does not deny, so a stray keypress cannot answer). RPC: confirm with the full diff.
 */
async function reviewChange(ctx: ExtensionContext, r: Review): Promise<boolean> {
	if (ctx.mode !== "tui") {
		const body = [r.header, buildDiff(r, diffContext())].filter(Boolean).join("\n\n");
		return ctx.ui.confirm(r.title, body);
	}

	return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
		let full = false;
		let top = 0;
		let choice: boolean | undefined;
		let lines: string[] | undefined;
		let linesWidth = -1;

		// Title, rule, rule, choice line, help line.
		const CHROME = 5;
		const viewHeight = () => Math.max(1, tui.terminal.rows - CHROME);
		const content = (width: number): string[] => {
			if (lines && linesWidth === width) return lines;
			const header = r.header ? r.header.split("\n").flatMap((l) => wrapTextWithAnsi(theme.fg("muted", l), width)) : [];
			const diff = renderDiff(buildDiff(r, full ? Number.MAX_SAFE_INTEGER : diffContext()))
				.split("\n")
				.flatMap((l) => wrapTextWithAnsi(l, width));
			lines = header.length ? [...header, "", ...diff] : diff;
			linesWidth = width;
			return lines;
		};
		const scroll = (delta: number) => {
			const max = Math.max(0, (lines?.length ?? 0) - viewHeight());
			top = Math.min(max, Math.max(0, top + delta));
			tui.requestRender();
		};

		return {
			// Fullscreen mode: receive PgUp/PgDn/Home/End instead of the transcript scrolling.
			capturesViewportInput: true,
			// Fullscreen mode: mouse wheel / touchpad scrolls the diff, not the transcript.
			handleMouse(event) {
				if (event.type !== "wheel" || !event.wheelDelta) return undefined;
				scroll(event.wheelDelta);
				return { handled: true };
			},
			render(width: number): string[] {
				const all = content(width);
				const h = viewHeight();
				top = Math.min(top, Math.max(0, all.length - h));
				const shown = all.slice(top, top + h);
				// Fill the screen so the chat behind the overlay is hidden.
				while (shown.length < h) shown.push("");
				const pos = all.length > h ? `[${top + 1}-${top + Math.min(h, all.length - top)}/${all.length}] ` : "";
				const opt = (label: string, value: boolean, color: "success" | "error") =>
					choice === value ? theme.fg(color, theme.bold(`▶ ${label}`)) : theme.fg("dim", `  ${label}`);
				const status =
					choice === undefined
						? theme.fg("warning", "press y or n, then Enter")
						: theme.fg("accent", `Enter to ${choice ? "allow" : "deny"}`);
				const help =
					`${pos}y allow · n deny · enter confirm · ↑↓/pgup/pgdn/home/end/wheel scroll · ` +
					`c ${full ? "changes only" : "whole file"}`;
				return [
					truncateToWidth(theme.fg("warning", theme.bold(r.title)), width),
					theme.fg("dim", "─".repeat(width)),
					...shown,
					theme.fg("dim", "─".repeat(width)),
					truncateToWidth(`${opt("Allow (y)", true, "success")}   ${opt("Deny (n)", false, "error")}   ${status}`, width),
					truncateToWidth(theme.fg("dim", help), width),
				];
			},
			handleInput(data: string): void {
				if (data === "y" || data === "Y" || data === "n" || data === "N") {
					choice = data === "y" || data === "Y";
					return tui.requestRender();
				}
				// Only Enter answers, and only once y or n was picked. Esc/Ctrl+C are ignored.
				if (keybindings.matches(data, "tui.select.confirm")) {
					if (choice !== undefined) done(choice);
					return;
				}
				if (data === "c" || data === "C") {
					full = !full;
					lines = undefined;
					top = 0;
					return tui.requestRender();
				}
				if (keybindings.matches(data, "tui.select.up") || data === "k") return scroll(-1);
				if (keybindings.matches(data, "tui.select.down") || data === "j") return scroll(1);
				if (keybindings.matches(data, "tui.select.pageUp")) return scroll(-viewHeight());
				if (keybindings.matches(data, "tui.select.pageDown") || data === " ") return scroll(viewHeight());
				if (matchesKey(data, "home") || data === "g") return scroll(-Infinity);
				if (matchesKey(data, "end") || data === "G") return scroll(Infinity);
			},
			invalidate() {
				lines = undefined;
			},
		};
	}, { overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 } });
}

/**
 * What a change to a unit-guarded file does to code from the base commit.
 * `issues` is empty when the change only adds code; `error` means it could not be analysed,
 * in which case the change is treated like a change to a whole guarded file.
 */
type UnitVerdict = { issues: Issue[]; error?: undefined } | { issues?: undefined; error: string };

export default function (pi: ExtensionAPI) {
	let failures = 0;
	let stopped = false;
	/** Guarded files as they were before each bash call, keyed by tool call id. */
	const bashSnapshots = new Map<string, Map<string, Snapshot>>();
	/** The latest guarded-file snapshots, reused (by lstat) so unchanged files are not read again. */
	let lastSnapshots = new Map<string, Snapshot>();

	/**
	 * The configuration and base commit, read at session start and on each user message (not while
	 * the agent works, so it cannot move either: e.g. by committing or editing the config).
	 */
	let state: { cwd: string; config: Promise<Config>; base: Promise<Base> } | undefined;
	/** Parsed base-commit files, keyed by `sha:path`. */
	let baseCache = new Map<string, Promise<Extracted | undefined>>();
	const refreshState = (ctx: ExtensionContext) => {
		const config = loadConfig(ctx.cwd);
		const base = readBase(ctx.cwd);
		state = { cwd: ctx.cwd, config, base };
		baseCache = new Map();
		if (ctx.hasUI) {
			void config.then((c) => {
				for (const e of c.errors) ctx.ui.notify(`check-guard: ${e}`, "warning");
			});
		}
	};
	const stateFor = (ctx: ExtensionContext) => {
		if (state?.cwd !== ctx.cwd) refreshState(ctx);
		return state!;
	};
	const configFor = (ctx: ExtensionContext) => stateFor(ctx).config;
	/** Unit-analysis problems already shown to the user, so each is shown once per refresh. */
	let notified = new Set<string>();

	/**
	 * Cached guarded-file aliases, built on first need. Dropped whenever symlinks or guarded files
	 * may have changed: a new turn or user message (you may have changed files yourself), a `!` command,
	 * a `write` that created a file, and any tool not known to leave files alone (bash, check, other
	 * extensions' tools).
	 */
	let aliasCache: { cwd: string; aliases: Promise<Aliases> } | undefined;
	const aliasesFor = (cwd: string, cfg: Config) => () => {
		if (aliasCache?.cwd !== cwd) {
			const aliases = findAliases(cwd, cfg);
			aliasCache = { cwd, aliases };
			// Never cache a failed scan.
			aliases.catch(() => {
				if (aliasCache?.aliases === aliases) aliasCache = undefined;
			});
		}
		return aliasCache.aliases;
	};
	const dropAliases = () => {
		aliasCache = undefined;
	};
	/** Tools that never create, delete or relink files. `write` is handled via createdByWrite. */
	const LINK_SAFE_TOOLS = new Set(["read", "edit", "grep", "find", "ls"]);
	/** write calls whose target did not exist yet, keyed by tool call id. */
	const createdByWrite = new Set<string>();

	const checkFile = (ctx: ExtensionContext) => resolve(ctx.cwd, CHECK_FILE);
	const stopReason = () =>
		`The project check (check.sh) has failed ${failures} times in a row. Stop now: do not run more tools. ` +
		"Report to the user what is failing and what you tried, and wait for their instructions.";

	const reset = () => {
		failures = 0;
		stopped = false;
	};

	/**
	 * Judge a change of unit-guarded file `rel` from `cur` to `next` (undefined: does not exist).
	 * Deleting a file that is in the base commit removes all of its units.
	 */
	const judgeUnits = async (
		ctx: ExtensionContext,
		rel: string,
		rule: Extract<Rule, { kind: "units" }>,
		cur: string | undefined,
		next: string | undefined,
	): Promise<UnitVerdict> => {
		try {
			const b = await stateFor(ctx).base;
			if ("error" in b) throw new Error(b.error);
			const parse = await parserFor(ctx.cwd, rule.preset, rel, rule.grammar);
			let base: Promise<Extracted | undefined> | undefined;
			if (b.sha !== null) {
				const key = `${b.sha}:${rel}`;
				base = baseCache.get(key);
				if (!base) {
					base = baseContent(ctx.cwd, b.sha, rel).then((src) => (src === undefined ? undefined : parse(src)));
					baseCache.set(key, base);
					base.catch(() => baseCache.delete(key));
				}
			}
			const baseUnits = await base;
			if (next === undefined) {
				if (!baseUnits) return { issues: [] };
				return { issues: [{ line: 1, text: "deletes a file from the base commit" }] };
			}
			const empty = parse("");
			return { issues: compare(baseUnits, cur === undefined ? empty : parse(cur), parse(next), rule.preset) };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI && !notified.has(error)) {
				notified.add(error);
				ctx.ui.notify(`check-guard: ${error}; guarding ${rel} as a whole file`, "warning");
			}
			return { error };
		}
	};

	// A new message from the user lets the agent try again, and moves the base to the current HEAD.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") {
			reset();
			refreshState(ctx);
			notified = new Set();
		}
		dropAliases();
		return { action: "continue" };
	});
	pi.on("session_start", async (_event, ctx) => {
		reset();
		refreshState(ctx);
		notified = new Set();
		dropAliases();
	});
	pi.on("turn_start", async () => dropAliases());
	pi.on("user_bash", async () => {
		dropAliases();
		return undefined;
	});
	pi.on("tool_execution_end", async (event) => {
		const created = createdByWrite.delete(event.toolCallId);
		if (created || (event.toolName !== "write" && !LINK_SAFE_TOOLS.has(event.toolName))) dropAliases();
	});

	pi.registerTool({
		name: "check",
		label: "Check",
		description:
			"Run the project check (./check.sh: tests, type checks, linters and whatever else the project configured). " +
			"Fails with the output of every failing step.",
		promptSnippet: "Run the project check (./check.sh)",
		promptGuidelines: [
			"Use the check tool to run the project check; do not run check.sh through bash.",
			"A change is done only when the check tool passes.",
			"Changing code that existed in the last commit of guarded test files (modifying, removing or renaming " +
				"existing tests, fixtures, helpers, hooks or setup statements, or adding focused tests, hooks or mocks " +
				"that change how existing tests run) needs the user's approval; adding new tests does not. " +
				"Keep such changes in separate edits from new code, since a denied edit is rejected as a whole.",
		],
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const file = checkFile(ctx);
			const snap = await takeSnapshot(file);
			if (!snap.exists) {
				return {
					content: [{ type: "text", text: `${CHECK_FILE} not found in ${ctx.cwd}.` }],
					details: { exitCode: null, failures },
					isError: true,
				};
			}

			const result = await pi.exec("bash", [file], { cwd: ctx.cwd, signal });
			if (result.killed && signal?.aborted) {
				return {
					content: [{ type: "text", text: "Check cancelled." }],
					details: { exitCode: result.code, failures },
					isError: true,
				};
			}

			const output = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
			const t = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = t.truncated ? `[output truncated to the last ${t.outputLines} lines]\n${t.content}` : t.content;

			if (result.code === 0) {
				failures = 0;
				return {
					content: [{ type: "text", text: `${text}\n\nCheck passed (exit 0).` }],
					details: { exitCode: 0, failures },
				};
			}

			failures++;
			const limit = maxFailures();
			text += `\n\nCheck failed (exit ${result.code}). Consecutive failures: ${failures}/${limit}.`;
			if (failures >= limit) {
				stopped = true;
				text += `\n\n${stopReason()}`;
				if (ctx.hasUI) ctx.ui.notify(`check.sh failed ${failures} times in a row; agent stopped.`, "warning");
			}
			return {
				content: [{ type: "text", text }],
				details: { exitCode: result.code, failures },
				isError: true,
				terminate: stopped,
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (stopped) return { block: true, reason: stopReason(), terminate: true };

		if (isToolCallEventType("bash", event)) {
			if (CHECK_INVOCATION.test(event.input.command)) {
				return {
					block: true,
					reason: "Do not run check.sh through bash. Use the check tool to run the project check.",
				};
			}
			const cfg = await configFor(ctx);
			lastSnapshots = await resnapshotGuarded(ctx.cwd, cfg, lastSnapshots);
			bashSnapshots.set(event.toolCallId, lastSnapshots);
			return undefined;
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const cfg = await configFor(ctx);
			const name = await guardedTarget(ctx.cwd, cfg, event.input.path, aliasesFor(ctx.cwd, cfg));
			const file = name === undefined ? undefined : resolve(ctx.cwd, name);
			// Unguarded, or a guarded file that does not exist yet: creating it is allowed
			// (unit-guarded files are judged below, as a new file may still add e.g. a pytest hook).
			const rule = ruleFor(cfg, name);
			// A new file may sit under a symlinked directory and so add a guarded alias.
			if (isToolCallEventType("write", event) && !(await exists(ctx.cwd, event.input.path))) {
				createdByWrite.add(event.toolCallId);
			}
			const mayCreate = rule?.kind !== "units" && !GUARD_CREATION.includes(name ?? "");
			if (file === undefined || (mayCreate && !(await exists(ctx.cwd, file)))) return undefined;

			const current = await takeSnapshot(file);
			const before = snapText(current) ?? "";
			let after: string | undefined;
			let review: Review;
			if (isToolCallEventType("write", event)) {
				after = event.input.content;
				const d = countChanges(before, after);
				review = { title: `Allow write ${name}? (+${d.added}/−${d.removed} lines)`, before, after };
			} else {
				const edits = event.input.edits;
				after = applyEdits(before, edits);
				const n = `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
				if (after !== undefined) {
					const d = countChanges(before.replace(/\r\n/g, "\n"), after);
					review = {
						title: `Allow edit ${name}? (${n}, +${d.added}/−${d.removed} lines)`,
						before: before.replace(/\r\n/g, "\n"),
						after,
					};
				} else {
					// oldText does not match exactly: show each replacement on its own (the edit tool may still fuzzy-match).
					const rawDiff = edits
						.map((e, i) => `Edit ${i + 1}/${edits.length}\n${generateDiffString(e.oldText, e.newText, 2).diff}`)
						.join("\n\n");
					review = { title: `Allow edit ${name}? (${n})`, before: "", after: "", rawDiff };
				}
			}

			let what = `Changing ${name}`;
			if (rule?.kind === "units") {
				// An edit that cannot be applied exactly cannot be analysed: guard it as a whole file.
				const verdict: UnitVerdict =
					after === undefined
						? { error: "edit does not apply exactly" }
						: await judgeUnits(ctx, name!, rule, current.exists ? review.before : undefined, after);
				if (verdict.issues) {
					if (!verdict.issues.length) return undefined;
					const { short, long } = describeIssues(verdict.issues);
					review.title = review.title.replace(/\?/, `? It ${short}.`);
					review.header = long;
					what = `This change to ${name} ${short}, which`;
				} else if (!current.exists) {
					return undefined;
				}
			}

			const denied = {
				block: true,
				reason:
					`${what} requires the user's approval, which was not given. Do not try to change it another way; ` +
					"tell the user what change you want and why.",
			};
			if (!ctx.hasUI) return denied;
			const ok = await reviewChange(ctx, review);
			return ok ? undefined : denied;
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const before = bashSnapshots.get(event.toolCallId);
		bashSnapshots.delete(event.toolCallId);
		if (!before) return undefined;

		const cfg = await configFor(ctx);
		const after = await resnapshotGuarded(ctx.cwd, cfg, before);
		const names = [...new Set([...before.keys(), ...after.keys()])].sort();
		const reverted: string[] = [];
		const failed: string[] = [];
		for (const name of names) {
			const was = before.get(name) ?? { exists: false };
			const now = after.get(name) ?? { exists: false };
			if (was === now || sameSnapshot(was, now)) continue;

			const rule = ruleFor(cfg, name);
			let header = `$ ${String(event.input.command)}`;
			let detail = "";
			if (rule?.kind === "units") {
				const cur = was.exists ? snapText(was) : undefined;
				const next = now.exists ? snapText(now) : undefined;
				const notText = (was.exists && cur === undefined) || (now.exists && next === undefined);
				const verdict: UnitVerdict = notText
					? { error: "not a regular file" }
					: await judgeUnits(ctx, name, rule, cur, next);
				if (verdict.issues) {
					if (!verdict.issues.length) continue;
					const { short, long } = describeIssues(verdict.issues);
					detail = ` It ${short}.`;
					header += `\n\n${long}`;
				} else if (!was.exists) {
					continue;
				}
			} else if (!was.exists && !GUARD_CREATION.includes(name)) {
				// Creating a guarded file that did not exist before is allowed.
				continue;
			}

			if (ctx.hasUI) {
				const what = !now.exists ? "deleted" : !was.exists ? "created" : "changed";
				const text = (s: Snapshot) => snapText(s) ?? "";
				const d = countChanges(text(was), text(now));
				const ok = await reviewChange(ctx, {
					title: `bash ${what} ${name} (+${d.added}/−${d.removed} lines).${detail} Keep?`,
					header,
					before: text(was),
					after: text(now),
				});
				if (ok) continue;
			}
			try {
				await restoreSnapshot(resolve(ctx.cwd, name), was);
				reverted.push(name);
			} catch (err) {
				failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		if (!reverted.length && !failed.length) return undefined;

		const notes: string[] = [];
		if (reverted.length) {
			notes.push(
				`This command changed ${reverted.join(", ")} without the user's approval, so the whole file was reverted ` +
					"(including any new code the command added to it).",
			);
		}
		if (failed.length) {
			notes.push(`This command changed guarded files that could not be restored: ${failed.join("; ")}.`);
			if (ctx.hasUI) ctx.ui.notify(`check-guard could not restore: ${failed.join("; ")}`, "error");
		}
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: `\n[check-guard] ${notes.join(" ")} Do not try to change it another way; tell the user what change you want and why.`,
				},
			],
		};
	});
}
