/**
 * workflow-reminder: re-inserts the agent workflow from AGENTS.md into the conversation every N
 * steps, so it keeps its weight as the context grows.
 *
 * Evidence: "From Plan to Action: How Well Do Agents Follow the Plan?" (ASE 2026) re-inserted the
 * prescribed plan every five steps and saw success rates improve for every model tested.
 *
 * - A step is one model response that called at least one tool. The count restarts with each run
 *   (each message of yours).
 * - The reminder is a hidden custom message appended after the step's tool results, so the prompt
 *   cache of everything before it stays valid. It holds the "## Agent workflow" section of
 *   AGENTS.md, read at that moment.
 * - Off when AGENTS.md has no "## Agent workflow" section, in subagent processes
 *   (PI_SUBAGENT_CHILD=1), and for runs started by /discuss.
 * - PI_WORKFLOW_REMINDER_EVERY sets the interval (default 5; 0 turns it off).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_EVERY = 5;
const HEADING = "## Agent workflow";
/** First line of .pi/prompts/discuss.md: runs started by /discuss do not follow the workflow. */
const DISCUSS_MARKER = "This is a discussion, not a ticket.";

function interval(): number {
	const raw = process.env.PI_WORKFLOW_REMINDER_EVERY;
	if (raw === undefined || raw === "") return DEFAULT_EVERY;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : DEFAULT_EVERY;
}

/** The "## Agent workflow" section of AGENTS.md (up to the next "## " heading), or undefined. */
function workflowSection(cwd: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(join(cwd, "AGENTS.md"), "utf8");
	} catch {
		return undefined;
	}
	const start = text.split("\n").findIndex((l) => l.startsWith(HEADING));
	if (start < 0) return undefined;
	const lines = text.split("\n").slice(start);
	const end = lines.findIndex((l, i) => i > 0 && l.startsWith("## "));
	return (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let steps = 0;
	let active = true;

	// Once per run you start (not on pi's internal retries or compaction restarts, which fire agent_start).
	pi.on("before_agent_start", (event) => {
		steps = 0;
		if (event.messageType === "user") active = !event.prompt?.startsWith(DISCUSS_MARKER);
	});

	pi.on("turn_end", (event, ctx) => {
		const every = interval();
		if (!active || every === 0) return;
		if (event.outcome !== "completed" || event.toolResults.length === 0) return;
		steps++;
		if (steps % every !== 0) return;
		const section = workflowSection(ctx.cwd);
		if (!section) return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "workflow-reminder",
					content:
						`Reminder (step ${steps}): the workflow you are following. ` +
						`Continue from where you are; do not restart it.\n\n${section}`,
					display: false,
				},
			],
		};
	});
}
