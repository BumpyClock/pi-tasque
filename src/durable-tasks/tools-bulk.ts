/**
 * Bulk lifecycle executor for durable tasks (tsq-6.2).
 *
 * Runs validated BulkItem[] sequentially with fail-fast semantics.
 * Reuses executeTsqChange / executeTsqMarkPlanned — no raw CLI argv
 * in the public contract.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BulkItem, BulkItemAction, BulkResult } from "./bulk-contract.js";
import type { StandardToolDetails } from "../shared/tool-result.js";
import { okToolDetails, textToolResult } from "../shared/tool-result.js";
import {
	executeTsqChange,
	executeTsqMarkPlanned,
	type TsqChangeAction,
} from "./tools-change.js";

// ── Action mapping ─────────────────────────────────────────────────

const BULK_TO_CHANGE_ACTION: Record<
	Exclude<BulkItemAction, "mark_planned">,
	TsqChangeAction
> = {
	start: "start",
	finish: "done",
	reopen: "reopen",
	defer: "defer",
	note: "note",
};

// ── Public executor ────────────────────────────────────────────────

/**
 * Execute a validated bulk lifecycle operation.
 *
 * Items run sequentially via the existing mutation queue.
 * On first failure, remaining items are marked skipped (no rollback).
 * Result details are always `ok: true` — failure info lives in `BulkResult.failed`.
 */
export async function executeBulk(
	pi: ExtensionAPI,
	items: readonly BulkItem[],
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<AgentToolResult<StandardToolDetails<BulkResult>>> {
	const completed: string[] = [];
	let failed: BulkResult["failed"];
	const skipped: string[] = [];

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const result = await executeOneItem(pi, item, signal, ctx);

		if (isResultOk(result)) {
			completed.push(item.task);
		} else {
			failed = { task: item.task, error: extractErrorMessage(result) };
			for (let j = i + 1; j < items.length; j++) {
				skipped.push(items[j]!.task);
			}
			break;
		}
	}

	const bulkResult: BulkResult = {
		completed,
		...(failed !== undefined ? { failed } : {}),
		skipped,
	};

	return textToolResult(
		formatBulkText(bulkResult, items.length),
		okToolDetails(bulkResult),
	);
}

// ── Single-item dispatch ───────────────────────────────────────────

function executeOneItem(
	pi: ExtensionAPI,
	item: BulkItem,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<AgentToolResult<unknown>> {
	if (item.action === "mark_planned") {
		return executeTsqMarkPlanned(pi, item.task, signal, ctx);
	}

	const action = BULK_TO_CHANGE_ACTION[item.action];
	const params = buildChangeParams(action, item);
	return executeTsqChange(pi, params, signal, ctx);
}

function buildChangeParams(
	action: TsqChangeAction,
	item: BulkItem,
): { action: TsqChangeAction; id: string; note?: string } {
	if (item.because !== undefined) {
		return { action, id: item.task, note: item.because };
	}
	return { action, id: item.task };
}

// ── Result inspection ──────────────────────────────────────────────

function isResultOk(result: AgentToolResult<unknown>): boolean {
	const d = result.details;
	return isRecord(d) && d.ok === true;
}

function extractErrorMessage(result: AgentToolResult<unknown>): string {
	const d = result.details;
	if (isRecord(d) && isRecord(d.error)) {
		const msg = d.error.message;
		if (typeof msg === "string") return msg;
	}
	return "unknown error";
}

// ── Formatting ─────────────────────────────────────────────────────

function formatBulkText(result: BulkResult, total: number): string {
	if (result.failed === undefined) {
		return `Bulk: ${result.completed.length}/${total} completed`;
	}

	const parts = [`Bulk: ${result.completed.length}/${total} completed`];
	parts.push("1 failed");
	if (result.skipped.length > 0) {
		parts.push(`${result.skipped.length} skipped`);
	}
	return `${parts.join(", ")}. Failed: ${result.failed.task} \u2014 ${result.failed.error}`;
}

// ── Utilities ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
