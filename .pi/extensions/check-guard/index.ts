/**
 * check-guard: makes ./check.sh the project's single check and keeps guarded files under the
 * user's control.
 *
 * - `check` tool: runs ./check.sh and reports its exit code to pi. After PI_CHECK_MAX_FAILURES
 *   (default 3) failing runs in a row, the agent is stopped until the user sends a new message.
 *   Running check.sh through bash is blocked, so failing runs cannot dodge the count: a regex blocks
 *   the common forms up front, and every bash command gets BASH_ENV pointing at bash-env.sh, which
 *   stops any bash that would run check.sh (or a copy of it), however it was started (nice, eval,
 *   env, make, xargs, a subprocess...). A tripwire, not a sandbox: clearing BASH_ENV or piping
 *   the script into bash still gets through.
 * - Guarded files (globs in .pi/check-guard.json `strictFiles` and `guardedFiles`, plus the config
 *   and this extension) are compared with a baseline: their content when the session started or
 *   when the user last sent a message while the agent was idle. Files matched by guardedFiles are
 *   in the baseline ("frozen") only once committed in HEAD, so new files, e.g. a ticket's new
 *   tests, stay editable until the user commits them. Without a commit (or outside git) every
 *   existing guarded file is frozen. Changing or deleting a frozen file needs the user's approval;
 *   creating a new one is allowed, except for files that are always frozen and need approval even
 *   to be created: the config, this extension, and files matched by strictFiles.
 *   - write/edit on a guarded file ask first, with the full diff.
 *   - Every other way of changing files (bash, background processes, symlinks, test runs that
 *     rewrite fixtures) is caught by a gate that compares all guarded files with the baseline
 *     before each check run and when the agent settles (agent_before_settle, or agent_settled for
 *     an aborted run, which skips agent_before_settle). All unapproved changes found by one gate
 *     run are shown to the user in one dialog: a list of the files, where each can be kept or
 *     discarded (reverted to the baseline) and its diff expanded. A check run with discarded
 *     changes fails.
 *     Changes reverted when the agent stops are reported to the model with the user's next message.
 *   The approval dialog shows the full diff (scrollable in the TUI; `c` toggles the whole file).
 *   PI_CHECK_DIFF_CONTEXT sets the context lines (default 4).
 * - The check is stopped after `checkTimeoutSeconds` (.pi/check-guard.json, default 600; 0 turns
 *   the timeout off) and counts as a failure. Stopping kills check.sh's whole process group.
 * - Unknown keys in .pi/check-guard.json are reported to the user (and otherwise ignored).
 */

import { execFile, spawn } from "node:child_process";
import { chmod, glob, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

/** The project check script run by the `check` tool. */
const CHECK_FILE = "check.sh";
/** Per-project configuration (relative to the project root). */
const CONFIG_FILE = ".pi/check-guard.json";
/** checkTimeoutSeconds when the config does not set it. */
const DEFAULT_CHECK_TIMEOUT = 600;
/** Keys .pi/check-guard.json may contain; others are reported. */
const CONFIG_KEYS: readonly string[] = ["guardedFiles", "strictFiles", "vulnerableFiles", "checkTimeoutSeconds"];
/** Grace period between SIGTERM and SIGKILL when the check is stopped. */
const KILL_GRACE_MS = 5000;
/** How long to keep reading output after check.sh exits. */
const PIPE_GRACE_MS = 1000;
/** Output kept from a check run (the tail). */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** strictFiles when the config does not set them: the check, the worktree setup and the agent's own instructions. */
const DEFAULT_STRICT: readonly string[] = ["check.sh", "worktree-setup.sh", "AGENTS.md", ".pi/settings.json", ".pi/agents/**", ".pi/prompts/**"];
/** vulnerableFiles when the config does not set them: pi's installed packages, which pi itself rewrites. */
const DEFAULT_VULNERABLE: readonly string[] = [".pi/npm", ".pi/git"];
/** Always guarded, and creating them also needs approval: the guard's own configuration and code. */
const ALWAYS_GUARDED: readonly string[] = [CONFIG_FILE, ".pi/extensions/check-guard/**"];
// Subagent actions that start no child run (read-only, status, or control of a running child).
// Any other action is blocked. A call without an action is a direct launch, validated separately.
const ALLOWED_SUBAGENT_ACTIONS = new Set(["status", "interrupt", "stop", "list", "get", "guide"]);

// Agents the workflow uses for direct launches.
const ALLOW_SUBAGENT_AGENTS = new Set(["scout", "reviewer", "oracle"]);
// Fields that make a call launch other or several agents (scripts, parallel tasks, chains).
const SUBAGENT_MULTI_LAUNCH_FIELDS: readonly string[] = ["workflow", "tasks", "chain"];

/**
 * A bash command that runs check.sh: the script in command position (after the start or a
 * separator, env assignments and wrappers like bash/sh/exec/env/nice/eval/timeout, also by path,
 * e.g. /usr/bin/env). Mentions such as `cat check.sh` or `git diff check.sh` do not match. A first
 * layer with a clear message; bash-env.sh catches what it misses, except shells that skip BASH_ENV
 * (sh, bash --posix/-p), which this regex is the only check for.
 */
const RUNS_CHECK =
	/(?:^|[;&|(`\n]|\$\()\s*(?:(?:[A-Za-z_]\w*=\S*|(?:\S*\/)?(?:env|exec|eval|time|nice|nohup|setsid|stdbuf|ionice|xargs|command|sudo|source|timeout\s+\S+|(?:ba|z|da|k)?sh)|\.)\s+(?:-\S+\s+)*)*['"]?(?:\S*\/)?check\.sh(?=$|[\s;&|)`'"])/;
/** Read by every non-interactive bash the agent's commands start (BASH_ENV); stops bash running check.sh. */
const BASH_ENV_HOOK = fileURLToPath(new URL("./bash-env.sh", import.meta.url));
/** BASH_ENV pi was started with: the hook sources it, so the user's own BASH_ENV keeps working. */
const ORIGINAL_BASH_ENV = process.env.BASH_ENV ?? "";
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Prepended to each bash tool command. POSIX syntax, so it works with any shell pi uses. */
const bashPrefix = (cwd: string) =>
	`export BASH_ENV=${shQuote(BASH_ENV_HOOK)} PI_CHECK_GUARD_ROOT=${shQuote(cwd)} PI_CHECK_GUARD_BASH_ENV=${shQuote(ORIGINAL_BASH_ENV)}\n`;
/** customType of the message that tells the model about changes reverted at the end of a run. */
const REVERT_MESSAGE = "check-guard-reverted";
/** Directories never searched for guarded files. */
const GLOB_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", ".tox", "__pycache__"]);
/** Integer environment variable that is at least `min`, else `fallback`. */
function envInt(name: string, min: number, fallback: number): number {
	const raw = process.env[name];
	const n = raw === undefined || raw === "" ? NaN : Number(raw);
	return Number.isInteger(n) && n >= min ? n : fallback;
}
const maxFailures = () => envInt("PI_CHECK_MAX_FAILURES", 1, 3);
/** Context lines around each change in the review dialog; `c` toggles the whole file. */
const diffContext = () => envInt("PI_CHECK_DIFF_CONTEXT", 0, 4);

// ---------------------------------------------------------------- configuration

type Config = {
	/** Soft: frozen only once committed in HEAD, so new files stay free. */
	guarded: string[];
	/** Strict: always frozen, and creating a file needs approval too. */
	strict: string[];
	/** Never guarded, even if strict or guarded globs match them (a directory covers its contents). */
	vulnerable: string[];
	/** Seconds before a check run is stopped; 0 means no timeout. */
	checkTimeout: number;
	/** Problems found while reading the config (shown to the user). */
	errors: string[];
};

const defaultConfig = (): Config => ({ guarded: [], strict: [...DEFAULT_STRICT], vulnerable: [...DEFAULT_VULNERABLE], checkTimeout: DEFAULT_CHECK_TIMEOUT, errors: [] });

/** Read CONFIG_FILE. Problems never weaken protection: an unreadable config keeps the defaults. */
async function loadConfig(cwd: string): Promise<Config> {
	const cfg = defaultConfig();
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
	const globs = (v: unknown): string[] | undefined =>
		typeof v === "string" ? [v] : Array.isArray(v) && v.every((s) => typeof s === "string") ? v : undefined;
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		cfg.errors.push(`${CONFIG_FILE} must be a JSON object`);
		return cfg;
	}
	const obj = json as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (!CONFIG_KEYS.includes(key)) {
			cfg.errors.push(`${CONFIG_FILE}: unknown key "${key}" is ignored (known keys: ${CONFIG_KEYS.join(", ")})`);
		}
	}
	for (const [key, field] of [["guardedFiles", "guarded"], ["strictFiles", "strict"], ["vulnerableFiles", "vulnerable"]] as const) {
		if (obj[key] === undefined) continue;
		const g = globs(obj[key]);
		// matchesGlob does not match a leading "./" against relative paths, so drop it.
		if (g) cfg[field] = g.map((s) => s.replace(/^(\.\/)+/, ""));
		else cfg.errors.push(`${CONFIG_FILE}: ${key} must be a list of globs`);
	}
	if (obj.checkTimeoutSeconds !== undefined) {
		const t = obj.checkTimeoutSeconds;
		if (typeof t === "number" && Number.isInteger(t) && t >= 0) cfg.checkTimeout = t;
		else {
			cfg.errors.push(
				`${CONFIG_FILE}: checkTimeoutSeconds must be a whole number of seconds (0: no timeout); using ${DEFAULT_CHECK_TIMEOUT}`,
			);
		}
	}
	return cfg;
}

const allGlobs = (cfg: Config) => [...ALWAYS_GUARDED, ...cfg.strict, ...cfg.guarded];
/**
 * Listed in vulnerableFiles (or inside a listed directory): not guarded at all. The config and the
 * extension cannot be made vulnerable, or the guard could be switched off through its own config.
 */
const isVulnerable = (cfg: Config, rel: string) =>
	!ALWAYS_GUARDED.some((g) => matchesGlob(rel, g)) &&
	cfg.vulnerable.some((g) => matchesGlob(rel, g) || matchesGlob(rel, `${g.replace(/\/+$/, "")}/**`));
const isGuarded = (cfg: Config, rel: string) =>
	!isVulnerable(cfg, rel) && allGlobs(cfg).some((g) => matchesGlob(rel, g));
/**
 * Guarded files that are frozen even when new, so creating them needs approval too: the config,
 * the extension, and every file matched by strictFiles. Files matched only by guardedFiles
 * (`tests/**`) are frozen once committed, so a ticket can add new ones freely.
 */
const isAlwaysGuarded = (cfg: Config, rel: string) =>
	!isVulnerable(cfg, rel) && [...ALWAYS_GUARDED, ...cfg.strict].some((g) => matchesGlob(rel, g));

// ---------------------------------------------------------------- files

/** A guarded file's content and permission bits. Symlinks are followed. */
type FileState = { content: Buffer; mode: number };
/** Guarded files that exist, keyed by path relative to the project root. */
type Snapshot = Map<string, FileState>;

/** Path relative to cwd with `/` separators, or undefined if it is outside cwd. */
function relPath(cwd: string, abs: string): string | undefined {
	const rel = relative(cwd, abs);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

/** Absolute path for a write/edit tool path (`@` prefix and `~` expanded as pi does). */
function toolPath(cwd: string, raw: string): string {
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	return resolve(cwd, p);
}

async function readState(file: string): Promise<FileState | undefined> {
	try {
		const st = await stat(file);
		if (!st.isFile()) return undefined;
		return { content: await readFile(file), mode: st.mode & 0o7777 };
	} catch {
		return undefined;
	}
}

/**
 * Files committed in HEAD, relative to cwd, or undefined when there is no commit to go by
 * (not a git repository, no commits yet, or git fails).
 */
function committedFiles(cwd: string): Promise<Set<string> | undefined> {
	return new Promise((done) => {
		const args = ["ls-tree", "-r", "-z", "--name-only", "HEAD"];
		execFile("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (err, out) =>
			done(err ? undefined : new Set(out.split("\0").filter(Boolean))),
		);
	});
}

/**
 * Guarded files that exist now. With `sticky`, only frozen ones (the baseline): committed in HEAD
 * (all of them if there is no commit), in `sticky` (frozen before: untracking a file must not
 * unfreeze it), or always guarded (strictFiles).
 * Directories are skipped: use `dir/**` to guard their contents.
 */
async function snapshot(cwd: string, cfg: Config, sticky?: ReadonlySet<string>): Promise<Snapshot> {
	const snap: Snapshot = new Map();
	const committed = sticky && (await committedFiles(cwd));
	const exclude = (p: string) => p.split(/[\\/]/).some((part) => GLOB_SKIP_DIRS.has(part)) || isVulnerable(cfg, p.split(sep).join("/"));
	for await (const rel of glob(allGlobs(cfg), { cwd, exclude })) {
		const name = rel.split(sep).join("/");
		if (isVulnerable(cfg, name)) continue;
		if (committed && !committed.has(name) && !sticky!.has(name) && !isAlwaysGuarded(cfg, name)) continue;
		const st = await readState(resolve(cwd, name));
		if (st) snap.set(name, st);
	}
	return snap;
}

const sameState = (a: FileState | undefined, b: FileState | undefined) =>
	a === b || (!!a && !!b && a.mode === b.mode && a.content.equals(b.content));

/** Put a file back as it was (`undefined`: it did not exist). */
async function restore(file: string, was: FileState | undefined): Promise<void> {
	await rm(file, { force: true });
	if (!was) return;
	// The parent directory may have been removed too (e.g. `rm -r tests`).
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, was.content);
	await chmod(file, was.mode);
}

/**
 * The guarded file (relative to cwd) a write/edit path targets, if any: the path as given or its
 * symlink-resolved path. Other aliases are caught later by the gate.
 */
async function guardedTarget(cwd: string, cfg: Config, raw: string): Promise<string | undefined> {
	const abs = toolPath(cwd, raw);
	const real = await realpath(abs).catch(() => abs);
	for (const candidate of [abs, real]) {
		const rel = relPath(cwd, candidate);
		if (rel !== undefined && isGuarded(cfg, rel)) return rel;
	}
	return undefined;
}

// ---------------------------------------------------------------- running the check

type CheckResult = {
	output: string;
	code: number | null;
	/** Signal that ended check.sh, if any. */
	exitSignal: NodeJS.Signals | null;
	timedOut: boolean;
	cancelled: boolean;
};

/**
 * Run `bash file` in its own process group, so a timeout or cancel stops everything check.sh started
 * (test runners, servers), not just bash. SIGTERM first, SIGKILL after KILL_GRACE_MS.
 * `timeoutSeconds` 0 means no timeout.
 */
function runCheck(file: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<CheckResult> {
	return new Promise((done) => {
		const detached = process.platform !== "win32";
		// Without PI_CHECK_GUARD_ROOT the BASH_ENV hook does nothing (relevant when pi itself runs under it).
		const env = { ...process.env };
		delete env.PI_CHECK_GUARD_ROOT;
		const proc = spawn("bash", [file], { cwd, env, detached, stdio: ["ignore", "pipe", "pipe"] });
		// Keep only the tail: the result is truncated to its last lines anyway.
		const chunks: Buffer[] = [];
		let bytes = 0;
		const onData = (d: Buffer) => {
			chunks.push(d);
			bytes += d.length;
			while (bytes > MAX_OUTPUT_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);

		let timedOut = false;
		let cancelled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const killGroup = (sig: NodeJS.Signals) => {
			try {
				if (detached && proc.pid) process.kill(-proc.pid, sig);
				else proc.kill(sig);
			} catch {
				// Already gone.
			}
		};
		const stop = () => {
			if (killTimer) return;
			killGroup("SIGTERM");
			killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
		};
		const timer =
			timeoutSeconds > 0
				? setTimeout(() => {
						timedOut = true;
						stop();
					}, timeoutSeconds * 1000)
				: undefined;
		const onAbort = () => {
			cancelled = true;
			stop();
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		let settled = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		const finish = (extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			done({ output: Buffer.concat(chunks).toString("utf8") + extra, code: exitCode, exitSignal, timedOut, cancelled });
		};
		proc.on("error", (err) => finish(`\n${err.message}`));
		proc.on("exit", (code, sig) => {
			exitCode = code;
			exitSignal = sig;
			// Leftovers in the group (e.g. a background server) would keep the pipes open: kill them.
			if (detached) killGroup("SIGKILL");
			// A descendant that left the group can still hold the pipes; stop waiting for it.
			setTimeout(() => {
				proc.stdout.destroy();
				proc.stderr.destroy();
				finish();
			}, PIPE_GRACE_MS).unref();
		});
		proc.on("close", () => finish());
	});
}

// ---------------------------------------------------------------- diffs and the approval dialog

const text = (s: FileState | undefined) => s?.content.toString("utf8") ?? "";
const lf = (s: string) => s.replace(/\r\n/g, "\n");

/** "+added/−removed lines", counted from a real line diff. */
function changeSummary(before: string, after: string): string {
	let removed = 0;
	let added = 0;
	for (const line of generateDiffString(before, after, 0).diff.split("\n")) {
		if (line.startsWith("-")) removed++;
		else if (line.startsWith("+")) added++;
	}
	return `+${added}/−${removed} lines`;
}

/** File content after applying `edits`, or undefined if an oldText does not match exactly once. */
function applyEdits(content: string, edits: { oldText: string; newText: string }[]): string | undefined {
	let out = lf(content);
	for (const e of edits) {
		const oldText = lf(e.oldText);
		const at = out.indexOf(oldText);
		if (at === -1 || out.indexOf(oldText, at + 1) !== -1) return undefined;
		out = out.slice(0, at) + lf(e.newText) + out.slice(at + oldText.length);
	}
	return out;
}

/** A diff with the given number of context lines. */
type DiffFn = (context: number) => string;
const contentDiff =
	(before: string, after: string): DiffFn =>
	(context) =>
		generateDiffString(before, after, context).diff || "(no textual change)";

/**
 * Ask the user to approve a change to a guarded file, showing the full diff.
 * TUI: full-screen scrollable overlay; `y`/`n` pick an answer and Enter confirms it
 * (Esc does not deny, so a stray keypress cannot answer). Other UIs: confirm with the full diff.
 */
async function reviewChange(ctx: ExtensionContext, title: string, diff: DiffFn): Promise<boolean> {
	if (ctx.mode !== "tui") return ctx.ui.confirm(title, diff(diffContext()));

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
			lines = renderDiff(diff(full ? Number.MAX_SAFE_INTEGER : diffContext()))
				.split("\n")
				.flatMap((l) => wrapTextWithAnsi(l, width));
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
					truncateToWidth(theme.fg("warning", theme.bold(title)), width),
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

/** One file in a batch review. */
type BatchItem = { name: string; detail: string; diff: DiffFn };

/**
 * Ask the user to keep or discard each of several changed guarded files. Returns one decision per
 * item (true: keep).
 * TUI: full-screen list of the files. ↑↓ move, Enter toggles keep/discard, Tab shows or hides the
 * file's diff, Shift+V keeps all, Shift+X discards all, Shift+Enter applies once every file is decided
 * (files start undecided, so a stray keypress cannot answer; Esc does nothing).
 * Other UIs: one confirm with every diff; the answer applies to all files.
 */
async function reviewBatch(ctx: ExtensionContext, title: string, items: BatchItem[]): Promise<boolean[]> {
	if (ctx.mode !== "tui") {
		const body = items.map((it) => `=== ${it.name} (${it.detail})\n${it.diff(diffContext())}`).join("\n\n");
		const keep = await ctx.ui.confirm(`${title}. Keep all?`, body);
		return items.map(() => keep);
	}

	return ctx.ui.custom<boolean[]>((tui, theme, keybindings, done) => {
		const decision: (boolean | undefined)[] = items.map(() => undefined);
		const expanded: boolean[] = items.map(() => false);
		let cursor = 0;
		let top = 0;
		let full = false;
		/** Rendered diff lines per item, for diffWidth and the current `full`. */
		let diffCache: (string[] | undefined)[] = [];
		let diffWidth = -1;
		/** Index of each item's header line in the last rendered content. */
		let headerAt: number[] = [];
		let contentLength = 0;

		// Title, rule, rule, status line, help line.
		const CHROME = 5;
		const INDENT = "    ";
		const viewHeight = () => Math.max(1, tui.terminal.rows - CHROME);
		const diffLines = (i: number, width: number): string[] => {
			if (diffWidth !== width) {
				diffCache = [];
				diffWidth = width;
			}
			return (diffCache[i] ??= renderDiff(items[i]!.diff(full ? Number.MAX_SAFE_INTEGER : diffContext()))
				.split("\n")
				.flatMap((l) => wrapTextWithAnsi(l, width)));
		};
		const header = (i: number): string => {
			const d = decision[i];
			const mark =
				d === true
					? theme.fg("success", "✓ keep   ")
					: d === false
						? theme.fg("error", "✗ discard")
						: theme.fg("warning", "? decide ");
			const arrow = expanded[i] ? "▾" : "▸";
			const name = i === cursor ? theme.bold(items[i]!.name) : items[i]!.name;
			const line = `${i === cursor ? theme.fg("accent", "▶") : " "} ${mark} ${arrow} ${name} ${theme.fg("dim", `(${items[i]!.detail})`)}`;
			return line;
		};
		const content = (width: number): string[] => {
			const out: string[] = [];
			headerAt = [];
			items.forEach((_, i) => {
				headerAt.push(out.length);
				out.push(truncateToWidth(header(i), width));
				if (expanded[i]) for (const l of diffLines(i, Math.max(1, width - INDENT.length))) out.push(INDENT + l);
			});
			contentLength = out.length;
			return out;
		};
		const clampTop = () => {
			top = Math.min(Math.max(0, contentLength - viewHeight()), Math.max(0, top));
		};
		/** Scroll so the cursor's header line is on screen (needs headerAt from a render). */
		let followCursor = false;
		const scroll = (delta: number) => {
			top += delta;
			clampTop();
			tui.requestRender();
		};
		const move = (delta: number) => {
			cursor = Math.min(items.length - 1, Math.max(0, cursor + delta));
			followCursor = true;
			tui.requestRender();
		};
		const setAll = (keep: boolean) => {
			decision.fill(keep);
			tui.requestRender();
		};

		return {
			capturesViewportInput: true,
			handleMouse(event) {
				if (event.type !== "wheel" || !event.wheelDelta) return undefined;
				scroll(event.wheelDelta);
				return { handled: true };
			},
			render(width: number): string[] {
				const all = content(width);
				const h = viewHeight();
				if (followCursor) {
					const at = headerAt[cursor]!;
					if (at < top) top = at;
					else if (at >= top + h) top = at - h + 1;
					followCursor = false;
				}
				clampTop();
				const shown = all.slice(top, top + h);
				while (shown.length < h) shown.push("");
				const kept = decision.filter((d) => d === true).length;
				const discarded = decision.filter((d) => d === false).length;
				const open = items.length - kept - discarded;
				const counts =
					`${theme.fg("success", `${kept} keep`)} · ${theme.fg("error", `${discarded} discard`)}` +
					(open ? ` · ${theme.fg("warning", `${open} undecided`)}` : "");
				const status = open
					? theme.fg("warning", "decide every file, then press shift+enter")
					: theme.fg("accent", theme.bold("press shift+enter to apply"));
				const pos = all.length > h ? `[${top + 1}-${top + Math.min(h, all.length - top)}/${all.length}] ` : "";
				const help =
					`${pos}↑↓ move · enter keep/discard · tab diff · shift+v keep all · shift+x discard all · shift+enter/shift+a apply · ` +
					`pgup/pgdn/home/end/wheel scroll · c ${full ? "changes only" : "whole file"}`;
				return [
					truncateToWidth(theme.fg("warning", theme.bold(title)), width),
					theme.fg("dim", "─".repeat(width)),
					...shown,
					theme.fg("dim", "─".repeat(width)),
					truncateToWidth(`${counts}   ${status}`, width),
					truncateToWidth(theme.fg("dim", help), width),
				];
			},
			handleInput(data: string): void {
				// Shift+V / Shift+X: plain "V"/"X" in legacy terminals, CSI-u with the Kitty protocol.
				if (matchesKey(data, "shift+v")) return setAll(true);
				if (matchesKey(data, "shift+x")) return setAll(false);
				// Checked before Enter so a user keybinding that maps confirm to shift+enter cannot toggle.
				// Needs a terminal that reports Shift+Enter (Kitty protocol, xterm modifyOtherKeys, tmux
				// with extended-keys); otherwise it arrives as plain Enter.
				if (matchesKey(data, "shift+enter") || matchesKey(data, "shift+a")) {
					if (decision.every((d) => d !== undefined)) done(decision as boolean[]);
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					decision[cursor] = decision[cursor] !== true;
					return tui.requestRender();
				}
				if (matchesKey(data, "tab")) {
					expanded[cursor] = !expanded[cursor];
					followCursor = true;
					return tui.requestRender();
				}
				if (data === "c" || data === "C") {
					full = !full;
					diffCache = [];
					return tui.requestRender();
				}
				if (keybindings.matches(data, "tui.select.up") || data === "k") return move(-1);
				if (keybindings.matches(data, "tui.select.down") || data === "j") return move(1);
				if (keybindings.matches(data, "tui.select.pageUp")) return scroll(-viewHeight());
				if (keybindings.matches(data, "tui.select.pageDown") || data === " ") return scroll(viewHeight());
				if (matchesKey(data, "home") || data === "g") return scroll(-Infinity);
				if (matchesKey(data, "end") || data === "G") return scroll(Infinity);
			},
			invalidate() {
				diffCache = [];
			},
		};
	}, { overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 } });
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	let failures = 0;
	let stopped = false;

	/**
	 * The configuration and the baseline of guarded files, taken at session start and when the user
	 * sends a message while the agent is idle (never while it works, so it cannot move either).
	 * Approved changes update the baseline. Each session gets a new extension instance and
	 * session_start runs before anything else, so these are always set before they are used.
	 */
	let config: Config = defaultConfig();
	let baseline: Snapshot = new Map();
	/** Re-read the config and take a new baseline. Await it: the agent must not run before the baseline is taken. */
	const refreshState = async (ctx: ExtensionContext) => {
		config = await loadConfig(ctx.cwd);
		if (ctx.hasUI) for (const e of config.errors) ctx.ui.notify(`check-guard: ${e}`, "warning");
		baseline = await snapshot(ctx.cwd, config, new Set(baseline.keys()));
	};
	/** Frozen guarded files: changing, deleting or creating them needs the user's approval. */
	const needsApproval = (name: string) => baseline.has(name) || isAlwaysGuarded(config, name);
	const setBaseline = (name: string, st: FileState | undefined) => {
		if (st) baseline.set(name, st);
		else baseline.delete(name);
	};
	/** write/edit calls the user approved, keyed by tool call id: their result becomes the baseline. */
	const approved = new Map<string, string>();

	const stopReason = () =>
		`The project check (check.sh) has failed ${failures} times in a row. Stop now: do not run more tools. ` +
		"Report to the user what is failing and what you tried, and wait for their instructions.";
	const tellUser = "Do not try to change it another way; tell the user what change you want and why.";

	/**
	 * Compare every guarded file with the baseline. All unapproved changes are shown in one dialog
	 * where the user keeps or discards each file (without a UI, every change is reverted).
	 * Discarded files are reverted to the baseline.
	 */
	const gate = async (ctx: ExtensionContext): Promise<{ reverted: string[]; failed: string[] }> => {
		const current = await snapshot(ctx.cwd, config);
		const reverted: string[] = [];
		const failed: string[] = [];
		const changes: { name: string; was: FileState | undefined; now: FileState | undefined }[] = [];
		for (const name of [...new Set([...baseline.keys(), ...current.keys()])].sort()) {
			const was = baseline.get(name);
			const now = current.get(name);
			if (!sameState(was, now) && needsApproval(name)) changes.push({ name, was, now });
		}
		if (!changes.length) return { reverted, failed };

		let keep: boolean[] = changes.map(() => false);
		if (ctx.hasUI) {
			const what = (c: (typeof changes)[number]) => (!c.now ? "deleted" : !c.was ? "created" : "changed");
			const summary = (c: (typeof changes)[number]) => changeSummary(text(c.was), text(c.now));
			if (changes.length === 1) {
				const c = changes[0]!;
				const title = `${c.name} was ${what(c)} without approval (${summary(c)}). Keep?`;
				keep = [await reviewChange(ctx, title, contentDiff(text(c.was), text(c.now)))];
			} else {
				const title = `${changes.length} guarded files were changed without approval`;
				const items = changes.map((c) => ({
					name: c.name,
					detail: `${what(c)}, ${summary(c)}`,
					diff: contentDiff(text(c.was), text(c.now)),
				}));
				keep = await reviewBatch(ctx, title, items);
			}
		}
		for (const [i, { name, was, now }] of changes.entries()) {
			if (keep[i]) {
				setBaseline(name, now);
				continue;
			}
			try {
				await restore(resolve(ctx.cwd, name), was);
				reverted.push(name);
			} catch (err) {
				failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		if (failed.length && ctx.hasUI) ctx.ui.notify(`check-guard could not restore: ${failed.join("; ")}`, "error");
		return { reverted, failed };
	};

	pi.on("session_start", async (_event, ctx) => {
		failures = 0;
		stopped = false;
		await refreshState(ctx);
	});

	pi.on("input", async (event, ctx) => {
		// A message from the user lets the agent try again after it was stopped.
		if (event.source !== "extension") {
			failures = 0;
			stopped = false;
		}
		// Between runs the baseline moves to the current state, which includes the user's own edits
		// (the end-of-run gate already reconciled the agent's). Messages sent while the agent works do not move it.
		if (!event.streamingBehavior) await refreshState(ctx);
		return { action: "continue" };
	});

	/**
	 * Last chance to catch changes no write/edit asked about, before the user reads the result.
	 * Returns the notice for the model (undefined if nothing was reverted or failed). The model has
	 * already finished, so the notice is saved to the session and reaches it with the user's next
	 * message. Side effect: the notice becomes the session's last message, so `pi -p` (which prints
	 * only a final assistant message) prints nothing for such a run. Use `--mode json` to see it.
	 */
	const endOfRunGate = async (ctx: ExtensionContext) => {
		const { reverted, failed } = await gate(ctx);
		if (reverted.length && ctx.hasUI) {
			ctx.ui.notify(`check-guard reverted unapproved changes to ${reverted.join(", ")}`, "warning");
		}
		if (!reverted.length && !failed.length) return undefined;
		const notes: string[] = [];
		if (reverted.length) {
			notes.push(
				`At the end of your last run, guarded files you changed without the user's approval were reverted: ${reverted.join(", ")}. ` +
					"Your changes to them are gone.",
			);
		}
		if (failed.length) notes.push(`Guarded files were changed and could not be restored: ${failed.join("; ")}.`);
		return {
			customType: REVERT_MESSAGE,
			content: `${notes.join(" ")} ${tellUser}`,
			display: true,
			details: { reverted, failed },
		};
	};

	// Once per run, after retries, compaction retries and queued messages (agent_end fires for each
	// of those). The notice is added as a session entry; no extra turn is requested.
	pi.on("agent_before_settle", async (event, ctx) => {
		const notice = await endOfRunGate(ctx);
		return notice ? { entries: [...event.entries, { type: "custom_message", ...notice }] } : undefined;
	});

	// An aborted run (Esc) skips agent_before_settle: gate it here, or the user's next message would
	// take the agent's changes into the baseline unseen. After a normal run this finds nothing.
	pi.on("agent_settled", async (event, ctx) => {
		if (!event.aborted) return;
		const notice = await endOfRunGate(ctx);
		// The agent is idle: without triggerTurn the message is saved now and starts no turn.
		if (notice) pi.sendMessage(notice, { triggerTurn: false });
	});

	const fail = (text: string, details: Record<string, unknown>) => ({
		content: [{ type: "text" as const, text }],
		details: { failures, ...details },
		isError: true,
	});

	pi.registerTool({
		name: "check",
		label: "Check",
		description:
			"Run the project check (./check.sh: tests, type checks, linters and whatever else the project configured). " +
			"Fails with the output of every failing step.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const { reverted, failed } = await gate(ctx);
			if (reverted.length || failed.length) {
				const notes: string[] = [];
				if (reverted.length) {
					notes.push(`Guarded files were changed without the user's approval and have been reverted: ${reverted.join(", ")}.`);
				}
				if (failed.length) notes.push(`Guarded files were changed and could not be restored: ${failed.join("; ")}.`);
				return fail(`${notes.join(" ")} The check did not run. ${tellUser}`, { exitCode: null, reverted });
			}

			const file = resolve(ctx.cwd, CHECK_FILE);
			if (!(await readState(file))) return fail(`${CHECK_FILE} not found in ${ctx.cwd}.`, { exitCode: null });

			const timeout = config.checkTimeout;
			const result = await runCheck(file, ctx.cwd, timeout, signal);
			if (result.cancelled) return fail("Check cancelled.", { exitCode: result.code });

			const t = truncateTail(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let out = t.truncated ? `[output truncated to the last ${t.outputLines} lines]\n${t.content}` : t.content;

			if (result.code === 0 && !result.timedOut) {
				failures = 0;
				return {
					content: [{ type: "text", text: `${out}\n\nCheck passed (exit 0).` }],
					details: { exitCode: 0, failures },
				};
			}

			failures++;
			const limit = maxFailures();
			const why = result.timedOut
				? `timed out after ${timeout}s and was stopped; checkTimeoutSeconds in ${CONFIG_FILE} sets the limit`
				: result.code === null
					? `killed by ${result.exitSignal ?? "an error"}`
					: `exit ${result.code}`;
			out += `\n\nCheck failed (${why}). Consecutive failures: ${failures}/${limit}.`;
			if (failures >= limit) {
				stopped = true;
				out += `\n\n${stopReason()}`;
				if (ctx.hasUI) ctx.ui.notify(`check.sh failed ${failures} times in a row; agent stopped.`, "warning");
			}
			return { ...fail(out, { exitCode: result.code, timedOut: result.timedOut }), terminate: stopped };
		},
	});

	/** Names of the other tool calls in the assistant message that made `toolCallId`. */
	const siblingCalls = (ctx: ExtensionContext, toolCallId: string): string[] => {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
			const calls = entry.message.content.filter((c: { type?: string }) => c.type === "toolCall") as { id: string; name: string }[];
			if (!calls.some((c) => c.id === toolCallId)) continue;
			return calls.filter((c) => c.id !== toolCallId).map((c) => c.name);
		}
		return [];
	};

	pi.on("tool_call", async (event, ctx) => {
		if (stopped) return { block: true, reason: stopReason(), terminate: true };
		if (event.toolName === "subagent") {
			const input = event.input as Record<string, unknown>;
			const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
			if (action) {
				// Allowed actions start no child, so they need neither the sibling rule nor the gate.
				if (ALLOWED_SUBAGENT_ACTIONS.has(action)) return undefined;
				return {
					block: true,
					reason: `Subagent action "${input.action}" is not allowed: it is not in the allowlist (${[...ALLOWED_SUBAGENT_ACTIONS].join(", ")}). ${tellUser}`,
				};
			}
			// No action: a direct launch. Only the workflow's own agents, one child per call.
			const agent = typeof input.agent === "string" ? input.agent.trim() : "";
			if (!ALLOW_SUBAGENT_AGENTS.has(agent)) {
				return {
					block: true,
					reason: `Subagent "${agent || "(none)"}" is not allowed: launch one of ${[...ALLOW_SUBAGENT_AGENTS].join(", ")}. ${tellUser}`,
				};
			}
			const multi = SUBAGENT_MULTI_LAUNCH_FIELDS.filter((f) => input[f] !== undefined && input[f] !== false);
			if (multi.length) {
				return {
					block: true,
					reason: `Subagent field${multi.length > 1 ? "s" : ""} ${multi.join(", ")} not allowed: launch one agent per call. ${tellUser}`,
				};
			}
			// The tool is not ours, so we cannot make it sequential. Tool calls of one message are
			// preflighted in order but run together afterwards: a bash edit in the same message would
			// land after this gate, while the child starts. A launch must be alone in its message.
			const siblings = siblingCalls(ctx, event.toolCallId);
			if (siblings.length) {
				return {
					block: true,
					reason: `A subagent launch must be the only tool call in its message (also called: ${siblings.join(", ")}). Call it again alone.`,
				};
			}
			// Agent files changed since the baseline (e.g. through bash) would be read by the child.
			const { reverted, failed } = await gate(ctx);
			if (reverted.length || failed.length) {
				const notes: string[] = [];
				if (reverted.length) {
					notes.push(`Guarded files were changed without the user's approval and have been reverted: ${reverted.join(", ")}.`);
				}
				if (failed.length) notes.push(`Guarded files were changed and could not be restored: ${failed.join("; ")}.`);
				return { block: true, reason: `${notes.join(" ")} The subagent was not launched. ${tellUser}` };
			}
			return undefined;
		}
		if (isToolCallEventType("bash", event)) {
			if (RUNS_CHECK.test(event.input.command)) {
				return {
					block: true,
					reason:
						`Do not run ${CHECK_FILE} through bash: use the check tool. ` +
						"Bash runs skip its failure limit and guarded-file check.",
				};
			}
			// Catches the forms the regex misses, when check.sh starts. Only the executed copy of the
			// arguments changes; the transcript keeps the model's command.
			event.input.command = bashPrefix(ctx.cwd) + event.input.command;
			return undefined;
		}
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return undefined;

		const name = await guardedTarget(ctx.cwd, config, event.input.path);
		// Unguarded, or a guarded file that is not in the baseline (new files are free).
		if (name === undefined || !needsApproval(name)) return undefined;

		const before = lf(text(await readState(resolve(ctx.cwd, name))));
		let title: string;
		let diff: DiffFn;
		if (isToolCallEventType("write", event)) {
			const after = event.input.content;
			title = `Allow write ${name}? (${changeSummary(before, after)})`;
			diff = contentDiff(before, after);
		} else {
			const edits = event.input.edits;
			const after = applyEdits(before, edits);
			const n = `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
			if (after !== undefined) {
				title = `Allow edit ${name}? (${n}, ${changeSummary(before, after)})`;
				diff = contentDiff(before, after);
			} else {
				// oldText does not match exactly: show each replacement on its own (the edit tool may still fuzzy-match).
				const raw = edits
					.map((e, i) => `Edit ${i + 1}/${edits.length}\n${generateDiffString(e.oldText, e.newText, 2).diff}`)
					.join("\n\n");
				title = `Allow edit ${name}? (${n})`;
				diff = () => raw;
			}
		}

		if (ctx.hasUI && (await reviewChange(ctx, title, diff))) {
			approved.set(event.toolCallId, name);
			return undefined;
		}
		return { block: true, reason: `Changing ${name} requires the user's approval, which was not given. ${tellUser}` };
	});

	// An approved write/edit moves the baseline of its file to the result.
	pi.on("tool_result", async (event, ctx) => {
		const name = approved.get(event.toolCallId);
		if (name === undefined) return undefined;
		approved.delete(event.toolCallId);
		setBaseline(name, await readState(resolve(ctx.cwd, name)));
		return undefined;
	});
}
