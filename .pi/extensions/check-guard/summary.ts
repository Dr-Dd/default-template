/**
 * Shortens the output of a failing check to its failing steps.
 *
 * check.sh frames each step with a start line `==> NAME: COMMAND` and an end line
 * `==> NAME: ok` or `==> NAME: FAILED`. Passing steps are dropped. A failing step, or one that
 * never finished (timeout, kill), keeps its start line and:
 * - for TAP output (node --test, bats and others print TAP when not on a terminal), every line
 *   except the passing tests, so failures are kept wherever they are in the run;
 * - then, if still long, the head and tail of its output: other runners put failures first or in
 *   a summary at the end (pytest, the spec reporters), with the passing tests in between.
 * Lines outside any step (e.g. the final `check: FAILED (...)`) are kept.
 */

/** Output lines kept from the start of each failing step. */
export const STEP_HEAD_LINES = 60;
/** Output lines kept from the end of each failing step. */
export const STEP_TAIL_LINES = 140;

type Step = { start: string; name: string; lines: string[]; status?: "ok" | "FAILED" };

const indent = (line: string) => line.length - line.trimStart().length;

/**
 * Without the passing tests if `lines` is TAP (has a plan line `1..N`): drops `# Subtest:` lines
 * (each result line repeats the name), `ok N` lines and the more indented diagnostics under them.
 */
function dropPassingTap(lines: string[]): string[] {
	if (!lines.some((l) => /^\s*1\.\.\d+\s*$/.test(l))) return lines;
	const kept: string[] = [];
	let skipDeeperThan = -1;
	for (const line of lines) {
		if (skipDeeperThan >= 0) {
			if (line.trim() === "" || indent(line) > skipDeeperThan) continue;
			skipDeeperThan = -1;
		}
		if (/^\s*# Subtest: /.test(line)) continue;
		if (/^\s*ok \d+\b/.test(line)) {
			skipDeeperThan = indent(line);
			continue;
		}
		kept.push(line);
	}
	return kept;
}

/** The failing steps of `output`, or undefined when it has no step frames (check.sh without step()). */
export function failingSteps(output: string): string | undefined {
	const parts: (string | Step)[] = [];
	let open: Step | undefined;
	for (const line of output.split("\n")) {
		if (open) {
			if (line === `==> ${open.name}: ok`) open.status = "ok";
			else if (line === `==> ${open.name}: FAILED`) open.status = "FAILED";
			else {
				open.lines.push(line);
				continue;
			}
			open = undefined;
			continue;
		}
		const m = /^==> (.+?): /.exec(line);
		if (m) {
			open = { start: line, name: m[1]!, lines: [] };
			parts.push(open);
		} else if (line.trim()) {
			parts.push(line);
		}
	}
	if (!parts.some((p) => typeof p !== "string")) return undefined;

	const out: string[] = [];
	for (const p of parts) {
		if (typeof p === "string") {
			out.push(p);
			continue;
		}
		if (p.status === "ok") continue;
		let body = dropPassingTap(p.lines);
		while (body.length && !body[body.length - 1]!.trim()) body = body.slice(0, -1);
		out.push(p.start);
		if (body.length > STEP_HEAD_LINES + STEP_TAIL_LINES) {
			const omitted = body.length - STEP_HEAD_LINES - STEP_TAIL_LINES;
			out.push(
				...body.slice(0, STEP_HEAD_LINES),
				`[... ${omitted} lines of this step omitted; run check with verbose: true for the full output ...]`,
				...body.slice(-STEP_TAIL_LINES),
			);
		} else {
			out.push(...body);
		}
		out.push(p.status === "FAILED" ? `==> ${p.name}: FAILED` : `==> ${p.name}: did not finish`, "");
	}
	return out.join("\n").trimEnd();
}
