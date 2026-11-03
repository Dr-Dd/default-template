/**
 * check-guard: makes ./check.sh the project's single, approval-gated check.
 *
 * - `check` tool: runs ./check.sh and reports its exit code to pi.
 * - Running check.sh through bash is blocked, so the exit code cannot be hidden.
 * - After PI_CHECK_MAX_FAILURES (default 3) failing `check` runs in a row, the
 *   agent is stopped until the user sends a new message.
 * - Changing check.sh needs the user's approval: write/edit ask first; changes
 *   made through bash are detected afterwards and reverted unless approved.
 */

import { lstat, readFile, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHECK_FILE = "check.sh";
const DEFAULT_MAX_FAILURES = 3;

/** check.sh invoked as a command: `./check.sh`, `bash check.sh`, `sh -c './check.sh'`, `source check.sh`, ... */
const CHECK_INVOCATION =
	/(?:^|[\n;&|(`]|\$\()\s*(?:(?:\w+=\S*|exec|time|nohup|env|command|nice|timeout(?:\s+(?:-\S+|[A-Z]+))*\s+\S+)\s+)*(?:(?:ba|da|z|k)?sh\s+(?:-\S+\s+)*|source\s+|\.\s+)?["']?(?:\S*\/)?check\.sh(?![\w.-])/;

type Snapshot = { exists: false } | { exists: true; content: Buffer; mode: number };

function maxFailures(): number {
	const raw = process.env.PI_CHECK_MAX_FAILURES;
	const n = raw === undefined ? NaN : Number(raw);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_FAILURES;
}

async function takeSnapshot(file: string): Promise<Snapshot> {
	try {
		const st = await lstat(file);
		if (!st.isFile()) return { exists: true, content: Buffer.alloc(0), mode: -1 };
		return { exists: true, content: await readFile(file), mode: st.mode & 0o7777 };
	} catch {
		return { exists: false };
	}
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
	await writeFile(file, snap.content);
	await chmod(file, snap.mode);
}

/** Absolute, symlink-resolved path a write/edit targets. */
async function targetPath(cwd: string, raw: string): Promise<string> {
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	const abs = resolve(cwd, p);
	try {
		return await realpath(abs);
	} catch {
		return abs;
	}
}

function preview(text: string, max = 1500): string {
	return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

export default function (pi: ExtensionAPI) {
	let failures = 0;
	let stopped = false;
	/** check.sh as it was before each bash call, keyed by tool call id. */
	const bashSnapshots = new Map<string, Snapshot>();

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
		return { action: "continue" };
	});
	pi.on("session_start", async () => reset());

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
			bashSnapshots.set(event.toolCallId, await takeSnapshot(checkFile(ctx)));
			return undefined;
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const file = checkFile(ctx);
			const target = await targetPath(ctx.cwd, event.input.path);
			const real = await targetPath(ctx.cwd, file);
			if (target !== file && target !== real) return undefined;

			const denied = {
				block: true,
				reason: `Changing ${CHECK_FILE} requires the user's approval, which was not given. Do not try to change it another way; tell the user what change you want and why.`,
			};
			if (!ctx.hasUI) return denied;

			const details = isToolCallEventType("write", event)
				? `New content:\n${preview(event.input.content)}`
				: event.input.edits.map((e) => `- ${preview(e.oldText, 600)}\n+ ${preview(e.newText, 600)}`).join("\n\n");
			const ok = await ctx.ui.confirm(`Allow the agent to ${event.toolName} ${CHECK_FILE}?`, details);
			return ok ? undefined : denied;
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const before = bashSnapshots.get(event.toolCallId);
		bashSnapshots.delete(event.toolCallId);
		if (!before) return undefined;

		const file = checkFile(ctx);
		const after = await takeSnapshot(file);
		if (sameSnapshot(before, after)) return undefined;

		if (ctx.hasUI) {
			const what = !after.exists ? "deleted" : !before.exists ? "created" : "changed";
			const shown = after.exists && after.mode !== -1 ? `\n\nNew content:\n${preview(after.content.toString("utf8"))}` : "";
			const ok = await ctx.ui.confirm(
				`The agent's bash command ${what} ${CHECK_FILE}. Keep the change?`,
				`Command: ${preview(String(event.input.command), 500)}${shown}`,
			);
			if (ok) return undefined;
		}

		await restoreSnapshot(file, before);
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: `\n[check-guard] This command changed ${CHECK_FILE} without the user's approval, so the change was reverted. Do not try to change it another way; tell the user what change you want and why.`,
				},
			],
		};
	});
}
