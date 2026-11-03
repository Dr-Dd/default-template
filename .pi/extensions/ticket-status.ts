/**
 * ticket-status: shows each parallel ticket's state in its tmux window name, so you can
 * see from the tmux status bar which tickets need you.
 *
 *   ▶ slug   the agent is working
 *   ? slug   a dialog is waiting for your answer (for example a check.sh change)
 *   ✋ slug  the agent stopped and is waiting for you (spec approval, done, failure)
 *
 * Active only in sessions started by tickets.sh (PI_TICKET set) inside tmux; does nothing
 * in normal sessions and in subagent processes. Restores the plain name when pi quits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const slug = process.env.PI_TICKET;
	const pane = process.env.TMUX_PANE;
	if (!slug || !pane || !process.env.TMUX || process.env.PI_SUBAGENT_CHILD === "1") return;

	let running = false;
	let last = "";
	const show = async (name: string) => {
		if (name === last) return;
		last = name;
		try {
			await pi.exec("tmux", ["rename-window", "-t", pane, name], { timeout: 2000 });
		} catch {
			// Best effort: never disturb the session over a window name.
		}
	};

	pi.on("session_start", async () => show(`✋ ${slug}`));
	pi.on("agent_start", async () => {
		running = true;
		await show(`▶ ${slug}`);
	});
	pi.on("ui_prompt_start", async () => show(`? ${slug}`));
	pi.on("ui_prompt_end", async () => show(running ? `▶ ${slug}` : `✋ ${slug}`));
	pi.on("agent_settled", async () => {
		running = false;
		await show(`✋ ${slug}`);
	});
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await show(slug);
	});
}
