import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorToolDetails, textToolResult } from "../shared/tool-result.js";
import {
	collectHandoffStatus,
	type HandoffCheckResult,
} from "./handoff-guard.js";

export async function executeHandoffCheck(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const result = await collectHandoffStatus({
		pi,
		cwd: ctx.cwd,
		...(signal != null ? { signal } : {}),
	});

	if (!result.ok) {
		return textToolResult(
			`Error: ${result.message}`,
			errorToolDetails({ code: result.code, message: result.message }),
		);
	}

	return textToolResult(formatHandoffText(result), {
		ok: true,
		ready: result.ready,
		...formatHandoffDetails(result),
	});
}

function formatHandoffText(result: HandoffCheckResult & { ok: true }): string {
	const lines: string[] = [
		result.ready
			? "Handoff ready: all session todos complete and linked tasks resolved."
			: "Handoff not ready.",
	];

	if ("todoBlockers" in result && result.todoBlockers?.length) {
		lines.push("", "Todo blockers:");
		for (const b of result.todoBlockers) {
			lines.push(`- #${b.todoId} "${b.subject}" — ${b.reason}`);
		}
	}

	if ("linkedBlockers" in result && result.linkedBlockers?.length) {
		lines.push("", "Linked task blockers:");
		for (const b of result.linkedBlockers) {
			lines.push(`- ${b.tsqId} (todo #${b.todoId}) — ${b.status}`);
		}
	}

	if ("linkedWarnings" in result && result.linkedWarnings?.length) {
		lines.push("", "Warnings:");
		for (const w of result.linkedWarnings) {
			lines.push(`- ${w.tsqId} (todo #${w.todoId}) — ${w.status}`);
		}
	}

	if ("readErrors" in result && result.readErrors?.length) {
		lines.push("", "Read errors:");
		for (const e of result.readErrors) {
			lines.push(`- ${e.tsqId} — ${e.code}: ${e.message}`);
		}
	}

	return lines.join("\n");
}

function formatHandoffDetails(
	result: HandoffCheckResult & { ok: true },
): Record<string, unknown> {
	const details: Record<string, unknown> = {};
	if (result.projectRoot !== undefined) {
		details.projectRoot = result.projectRoot;
	}
	if ("todoBlockers" in result && result.todoBlockers?.length) {
		details.todoBlockers = result.todoBlockers;
	}
	if ("linkedBlockers" in result && result.linkedBlockers?.length) {
		details.linkedBlockers = result.linkedBlockers;
	}
	if ("linkedWarnings" in result && result.linkedWarnings?.length) {
		details.linkedWarnings = result.linkedWarnings;
	}
	if ("readErrors" in result && result.readErrors?.length) {
		details.readErrors = result.readErrors;
	}
	return details;
}
