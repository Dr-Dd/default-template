/**
 * check-guard: makes ./check.sh the project's single check and keeps guarded files under the
 * user's control.
 *
 * - `check` tool: runs ./check.sh and reports its exit code to pi. After PI_CHECK_MAX_FAILURES
 *   (default 3) failing runs in a row, the agent is stopped until the user sends a new message.
 * - Guarded files (globs in .pi/check-guard.json `guardedFiles`, plus the config and this
 *   extension) are compared with a baseline: their content when the session started or when the
 *   user last sent a message while the agent was idle. Only files committed in HEAD at that point
 *   are in the baseline ("frozen"), so new files, e.g. a ticket's new tests, stay editable until
 *   the user commits them. Without a commit (or outside git) every existing guarded file is frozen.
 *   Changing or deleting a frozen file needs the user's approval; creating a new one is allowed
 *   (except the config and the extension: they are always frozen and creating them needs approval).
 *   - write/edit on a guarded file ask first, with the full diff.
 *   - Every other way of changing files (bash, background processes, symlinks, test runs that
 *     rewrite fixtures) is caught by a gate that compares all guarded files with the baseline
 *     before each check run and when the agent stops. Each unapproved change is shown to the
 *     user; a denied change is reverted to the baseline. A check run with a denied change fails.
 *   The approval dialog shows the full diff (scrollable in the TUI; `c` toggles the whole file).
 *   PI_CHECK_DIFF_CONTEXT sets the context lines (default 4).
 */

import { execFile } from "node:child_process";
import { chmod, glob, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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

/** The project check script run by the `check` tool. */
const CHECK_FILE = "check.sh";
/** Per-project configuration (relative to the project root). */
const CONFIG_FILE = ".pi/check-guard.json";
/** guardedFiles when there is no config file. */
const DEFAULT_GUARDED: readonly string[] = ["check.sh"];
/** Always guarded, and creating them also needs approval: the guard's own configuration and code. */
const ALWAYS_GUARDED: readonly string[] = [CONFIG_FILE, ".pi/extensions/check-guard/**"];
/** Directories never searched for guarded files. */
const GLOB_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", ".tox", "__pycache__"]);
const DEFAULT_MAX_FAILURES = 3;

function maxFailures(): number {
	const n = Number(process.env.PI_CHECK_MAX_FAILURES);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FAILURES;
}

/** Context lines around each change in the review dialog; `c` toggles the whole file. */
function diffContext(): number {
	const raw = process.env.PI_CHECK_DIFF_CONTEXT;
	const n = raw === undefined || raw === "" ? NaN : Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : 4;
}

// ---------------------------------------------------------------- configuration

type Config = {
	guarded: string[];
	/** Problems found while reading the config (shown to the user). */
	errors: string[];
};

/** Read CONFIG_FILE. Problems never weaken protection: an unreadable config keeps the defaults. */
async function loadConfig(cwd: string): Promise<Config> {
	const cfg: Config = { guarded: [...DEFAULT_GUARDED], errors: [] };
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
	const obj = (json ?? {}) as Record<string, unknown>;
	if (obj.guardedFiles !== undefined) {
		const g = globs(obj.guardedFiles);
		if (g) cfg.guarded = g;
		else cfg.errors.push(`${CONFIG_FILE}: guardedFiles must be a list of globs`);
	}
	// Per-unit guarding was removed: guard its files as whole files rather than dropping them.
	if (Array.isArray(obj.unitGuardedFiles) && obj.unitGuardedFiles.length) {
		for (const e of obj.unitGuardedFiles) cfg.guarded.push(...(globs((e as { files?: unknown })?.files) ?? []));
		cfg.errors.push(
			`${CONFIG_FILE}: unitGuardedFiles is no longer supported; its files are guarded as whole files ` +
				"(move them to guardedFiles)",
		);
	}
	return cfg;
}

const allGlobs = (cfg: Config) => [...ALWAYS_GUARDED, ...cfg.guarded];
const isGuarded = (cfg: Config, rel: string) => allGlobs(cfg).some((g) => matchesGlob(rel, g));
/** Guarded files that need approval even to be created. */
const isAlwaysGuarded = (rel: string) => ALWAYS_GUARDED.some((g) => matchesGlob(rel, g));

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
 * Guarded files that exist now. With `frozen`, only frozen ones (the baseline): committed in HEAD
 * (all of them if there is no commit), frozen before (`frozen.sticky`: untracking a file must not
 * unfreeze it), or always guarded. Directories are skipped: use `dir/**` to guard their contents.
 */
async function snapshot(cwd: string, cfg: Config, frozen?: { sticky: ReadonlySet<string> }): Promise<Snapshot> {
	const snap: Snapshot = new Map();
	const sticky = frozen?.sticky ?? new Set<string>();
	const committed = frozen && (await committedFiles(cwd));
	const exclude = (p: string) => p.split(/[\\/]/).some((part) => GLOB_SKIP_DIRS.has(part));
	for await (const rel of glob(allGlobs(cfg), { cwd, exclude })) {
		const name = rel.split(sep).join("/");
		if (committed && !committed.has(name) && !sticky.has(name) && !isAlwaysGuarded(name)) continue;
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

// ---------------------------------------------------------------- diffs and the approval dialog

const text = (s: FileState | undefined) => s?.content.toString("utf8") ?? "";

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

type Review = {
	title: string;
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
 * (Esc does not deny, so a stray keypress cannot answer). Other UIs: confirm with the full diff.
 */
async function reviewChange(ctx: ExtensionContext, r: Review): Promise<boolean> {
	if (ctx.mode !== "tui") return ctx.ui.confirm(r.title, buildDiff(r, diffContext()));

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
			lines = renderDiff(buildDiff(r, full ? Number.MAX_SAFE_INTEGER : diffContext()))
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

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	let failures = 0;
	let stopped = false;

	/**
	 * The configuration and the baseline of guarded files, taken at session start and when the user
	 * sends a message while the agent is idle (never while it works, so it cannot move either).
	 * Approved changes update the baseline.
	 */
	let state: { cwd: string; config: Promise<Config>; baseline: Promise<Snapshot> } | undefined;
	/** Re-read the config and take a new baseline. Await it: the agent must not run before the baseline is taken. */
	const refreshState = async (ctx: ExtensionContext) => {
		const prev = state?.cwd === ctx.cwd ? await state.baseline.catch(() => undefined) : undefined;
		const sticky = new Set(prev?.keys());
		const config = loadConfig(ctx.cwd);
		const baseline = config.then((c) => snapshot(ctx.cwd, c, { sticky }));
		state = { cwd: ctx.cwd, config, baseline };
		const cfg = await config;
		if (ctx.hasUI) for (const e of cfg.errors) ctx.ui.notify(`check-guard: ${e}`, "warning");
		await baseline;
	};
	const stateFor = (ctx: ExtensionContext) => {
		if (state?.cwd !== ctx.cwd) void refreshState(ctx);
		return state!;
	};
	/** write/edit calls the user approved, keyed by tool call id: their result becomes the baseline. */
	const approved = new Map<string, string>();

	const stopReason = () =>
		`The project check (check.sh) has failed ${failures} times in a row. Stop now: do not run more tools. ` +
		"Report to the user what is failing and what you tried, and wait for their instructions.";
	const tellUser = "Do not try to change it another way; tell the user what change you want and why.";

	/**
	 * Compare every guarded file with the baseline. The user approves or denies each change
	 * (without a UI, every change is denied); denied changes are reverted.
	 */
	const gate = async (ctx: ExtensionContext): Promise<{ reverted: string[]; failed: string[] }> => {
		const s = stateFor(ctx);
		const baseline = await s.baseline;
		const current = await snapshot(ctx.cwd, await s.config);
		const reverted: string[] = [];
		const failed: string[] = [];
		for (const name of [...new Set([...baseline.keys(), ...current.keys()])].sort()) {
			const was = baseline.get(name);
			const now = current.get(name);
			if (sameState(was, now) || (!was && !isAlwaysGuarded(name))) continue;
			if (ctx.hasUI) {
				const what = !now ? "deleted" : !was ? "created" : "changed";
				const d = countChanges(text(was), text(now));
				const ok = await reviewChange(ctx, {
					title: `${name} was ${what} without approval (+${d.added}/−${d.removed} lines). Keep?`,
					before: text(was),
					after: text(now),
				});
				if (ok) {
					if (now) baseline.set(name, now);
					else baseline.delete(name);
					continue;
				}
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
		// (agent_end already reconciled the agent's). Messages sent while the agent works do not move it.
		if (!event.streamingBehavior) await refreshState(ctx);
		return { action: "continue" };
	});

	// Last chance to catch changes no write/edit asked about, before the user reads the result.
	pi.on("agent_end", async (_event, ctx) => {
		const { reverted } = await gate(ctx);
		if (reverted.length && ctx.hasUI) {
			ctx.ui.notify(`check-guard reverted unapproved changes to ${reverted.join(", ")}`, "warning");
		}
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
			"Changing or deleting committed guarded files (check.sh and the files listed in .pi/check-guard.json, " +
				"typically tests, fixtures and test configuration) needs the user's approval. New files, and new files " +
				"you created in this task that are not committed yet, are free: put new tests in new files. " +
				"Changes made any other way than write/edit are reverted unless the user approves them.",
		],
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
				return {
					content: [{ type: "text", text: `${notes.join(" ")} The check did not run. ${tellUser}` }],
					details: { exitCode: null, failures, reverted },
					isError: true,
				};
			}

			const file = resolve(ctx.cwd, CHECK_FILE);
			if (!(await readState(file))) {
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
			let out = t.truncated ? `[output truncated to the last ${t.outputLines} lines]\n${t.content}` : t.content;

			if (result.code === 0) {
				failures = 0;
				return {
					content: [{ type: "text", text: `${out}\n\nCheck passed (exit 0).` }],
					details: { exitCode: 0, failures },
				};
			}

			failures++;
			const limit = maxFailures();
			out += `\n\nCheck failed (exit ${result.code}). Consecutive failures: ${failures}/${limit}.`;
			if (failures >= limit) {
				stopped = true;
				out += `\n\n${stopReason()}`;
				if (ctx.hasUI) ctx.ui.notify(`check.sh failed ${failures} times in a row; agent stopped.`, "warning");
			}
			return {
				content: [{ type: "text", text: out }],
				details: { exitCode: result.code, failures },
				isError: true,
				terminate: stopped,
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (stopped) return { block: true, reason: stopReason(), terminate: true };
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return undefined;

		const s = stateFor(ctx);
		const name = await guardedTarget(ctx.cwd, await s.config, event.input.path);
		// Unguarded, or a guarded file that is not in the baseline (new files are free).
		if (name === undefined || !((await s.baseline).has(name) || isAlwaysGuarded(name))) return undefined;

		const before = text(await readState(resolve(ctx.cwd, name))).replace(/\r\n/g, "\n");
		let review: Review;
		if (isToolCallEventType("write", event)) {
			const after = event.input.content;
			const d = countChanges(before, after);
			review = { title: `Allow write ${name}? (+${d.added}/−${d.removed} lines)`, before, after };
		} else {
			const edits = event.input.edits;
			const after = applyEdits(before, edits);
			const n = `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
			if (after !== undefined) {
				const d = countChanges(before, after);
				review = { title: `Allow edit ${name}? (${n}, +${d.added}/−${d.removed} lines)`, before, after };
			} else {
				// oldText does not match exactly: show each replacement on its own (the edit tool may still fuzzy-match).
				const rawDiff = edits
					.map((e, i) => `Edit ${i + 1}/${edits.length}\n${generateDiffString(e.oldText, e.newText, 2).diff}`)
					.join("\n\n");
				review = { title: `Allow edit ${name}? (${n})`, before: "", after: "", rawDiff };
			}
		}

		if (ctx.hasUI && (await reviewChange(ctx, review))) {
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
		const baseline = await stateFor(ctx).baseline;
		const now = await readState(resolve(ctx.cwd, name));
		if (now) baseline.set(name, now);
		else baseline.delete(name);
		return undefined;
	});
}
