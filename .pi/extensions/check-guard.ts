/**
 * check-guard: makes ./check.sh the project's single, approval-gated check.
 *
 * - `check` tool: runs ./check.sh and reports its exit code to pi.
 * - Running check.sh through bash is blocked, so the exit code cannot be hidden.
 * - After PI_CHECK_MAX_FAILURES (default 3) failing `check` runs in a row, the
 *   agent is stopped until the user sends a new message.
 * - Changing or deleting an existing guarded file (GUARDED_FILES globs, by default
 *   just check.sh) needs the user's approval: write/edit ask first; changes made
 *   through bash are detected afterwards and reverted unless approved. Creating a
 *   guarded file that does not exist yet is always allowed.
 *   The approval dialog shows the full diff (scrollable in the TUI; `c` toggles
 *   the whole file). PI_CHECK_DIFF_CONTEXT sets the context lines (default 4).
 */

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

/** The project check script run by the `check` tool. */
const CHECK_FILE = "check.sh";
/**
 * Files (globs relative to the project root) that need the user's approval to change or delete.
 * Globs match files only: use `dir/**` to guard every file inside a directory.
 */
const GUARDED_FILES: readonly string[] = ["check.sh"];
/** Directories never searched for guarded files. */
const GLOB_SKIP_DIRS = new Set([".git", "node_modules"]);
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

function isGuardedRel(rel: string | undefined): rel is string {
	return rel !== undefined && GUARDED_FILES.some((g) => matchesGlob(rel, g));
}

/**
 * Guarded files that currently exist, relative to cwd. Directories are skipped: a glob guards
 * files (use `dir/**` for everything inside a directory), and a directory cannot be restored.
 */
async function guardedFiles(cwd: string): Promise<string[]> {
	const found = new Set<string>();
	const exclude = (p: string) => p.split(/[\\/]/).some((part) => GLOB_SKIP_DIRS.has(part));
	for await (const rel of glob([...GUARDED_FILES], { cwd, exclude })) {
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

async function findAliases(cwd: string): Promise<Aliases> {
	const aliases: Aliases = new Map();
	for (const rel of await guardedFiles(cwd)) {
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
	raw: string,
	aliases: () => Promise<Aliases>,
): Promise<string | undefined> {
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	const abs = resolve(cwd, p);
	const real = await realOrSelf(abs);
	for (const candidate of [abs, real]) {
		const rel = relPath(cwd, candidate);
		if (isGuardedRel(rel)) return rel;
	}
	// A target that does not exist cannot be the resolved path of an existing guarded file.
	try {
		await lstat(real);
	} catch {
		return undefined;
	}
	return (await aliases()).get(real);
}

/** Snapshots of every guarded file that exists now. */
async function snapshotGuarded(cwd: string): Promise<Map<string, Snapshot>> {
	const snaps = new Map<string, Snapshot>();
	for (const rel of await guardedFiles(cwd)) snaps.set(rel, await takeSnapshot(resolve(cwd, rel)));
	return snaps;
}

/** Like snapshotGuarded, but files whose lstat matches `before` are reused without being read. */
async function resnapshotGuarded(cwd: string, before: Map<string, Snapshot>): Promise<Map<string, Snapshot>> {
	const snaps = new Map<string, Snapshot>();
	for (const rel of await guardedFiles(cwd)) snaps.set(rel, await resnapshot(resolve(cwd, rel), before.get(rel)));
	return snaps;
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

export default function (pi: ExtensionAPI) {
	let failures = 0;
	let stopped = false;
	/** Guarded files as they were before each bash call, keyed by tool call id. */
	const bashSnapshots = new Map<string, Map<string, Snapshot>>();

	/**
	 * Cached guarded-file aliases, built on first need. Dropped whenever symlinks or guarded files
	 * may have changed: a new turn or user message (you may have changed files yourself), a `!` command,
	 * a `write` that created a file, and any tool not known to leave files alone (bash, check, other
	 * extensions' tools).
	 */
	let aliasCache: { cwd: string; aliases: Promise<Aliases> } | undefined;
	const aliasesFor = (cwd: string) => () => {
		if (aliasCache?.cwd !== cwd) {
			const aliases = findAliases(cwd);
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

	// A new message from the user lets the agent try again.
	pi.on("input", async (event) => {
		if (event.source !== "extension") reset();
		dropAliases();
		return { action: "continue" };
	});
	pi.on("session_start", async () => {
		reset();
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
			bashSnapshots.set(event.toolCallId, await snapshotGuarded(ctx.cwd));
			return undefined;
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const name = await guardedTarget(ctx.cwd, event.input.path, aliasesFor(ctx.cwd));
			const file = name === undefined ? undefined : resolve(ctx.cwd, name);
			// Unguarded, or a guarded file that does not exist yet: creating it is allowed.
			if (file === undefined || !(await exists(ctx.cwd, file))) {
				// A new file may sit under a symlinked directory and so add a guarded alias.
				if (isToolCallEventType("write", event) && !(await exists(ctx.cwd, event.input.path))) {
					createdByWrite.add(event.toolCallId);
				}
				return undefined;
			}

			const denied = {
				block: true,
				reason: `Changing ${name} requires the user's approval, which was not given. Do not try to change it another way; tell the user what change you want and why.`,
			};
			if (!ctx.hasUI) return denied;

			const current = await takeSnapshot(file);
			const before = current.exists && current.mode !== -1 ? current.content.toString("utf8") : "";
			let review: Review;
			if (isToolCallEventType("write", event)) {
				const d = countChanges(before, event.input.content);
				review = {
					title: `Allow write ${name}? (+${d.added}/−${d.removed} lines)`,
					before,
					after: event.input.content,
				};
			} else {
				const edits = event.input.edits;
				const after = applyEdits(before, edits);
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

		const after = await resnapshotGuarded(ctx.cwd, before);
		const names = [...new Set([...before.keys(), ...after.keys()])].sort();
		const reverted: string[] = [];
		const failed: string[] = [];
		for (const name of names) {
			const was = before.get(name) ?? { exists: false };
			const now = after.get(name) ?? { exists: false };
			if (was === now || sameSnapshot(was, now)) continue;
			// Creating a guarded file that did not exist before is allowed.
			if (!was.exists) continue;

			if (ctx.hasUI) {
				const what = !now.exists ? "deleted" : !was.exists ? "created" : "changed";
				const text = (s: Snapshot) => (s.exists && s.mode !== -1 ? s.content.toString("utf8") : "");
				const d = countChanges(text(was), text(now));
				const ok = await reviewChange(ctx, {
					title: `bash ${what} ${name} (+${d.added}/−${d.removed} lines). Keep?`,
					header: `$ ${String(event.input.command)}`,
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
				`This command changed ${reverted.join(", ")} without the user's approval, so the change was reverted.`,
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
