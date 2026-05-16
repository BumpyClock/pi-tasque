/**
 * Read-only handoff readiness checker.
 *
 * Collects session todo state and linked durable task statuses to produce a
 * structured ready/not-ready report. Never mutates session todos or durable
 * task state. Uses only read-only `show` CLI calls for linked tasks.
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deriveTaskLinks } from "../bridge/link-store.js";
import { selectVisibleTasks } from "../session-todos/state/selectors.js";
import { getState } from "../session-todos/state/store.js";
import type { Task } from "../session-todos/tool/types.js";
import { resolveProjectRoot } from "./project.js";
import { TsqCommandError, TsqProcessError, runTsqJson } from "./runner.js";
import type { TsqShowData, TsqTaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

/** Durable task statuses that count as "ready" (work complete). */
const READY_STATUSES: ReadonlySet<TsqTaskStatus> = new Set(["closed"]);

/** Durable task statuses that count as "warning" (not blocking). */
const WARNING_STATUSES: ReadonlySet<TsqTaskStatus> = new Set(["canceled"]);

/**
 * Classify a durable task status for handoff readiness.
 *
 * - `"ready"` — closed, work done.
 * - `"blocker"` — open/in_progress/blocked/deferred/unknown/missing.
 * - `"warning"` — canceled (notable but not blocking).
 */
export function classifyDurableStatus(
	status: string | undefined | null,
): "ready" | "blocker" | "warning" {
	if (status == null || status.trim().length === 0) return "blocker";
	if (READY_STATUSES.has(status)) return "ready";
	if (WARNING_STATUSES.has(status)) return "warning";
	return "blocker";
}

// ---------------------------------------------------------------------------
// Read-error classification
// ---------------------------------------------------------------------------

/**
 * Error codes from linked `tsq show` that are *actionable* (user can fix them)
 * rather than infrastructure failures. These become `ok:true, ready:false` with
 * structured `readErrors`, not `ok:false`.
 */
const ACTIONABLE_ERROR_CODES: ReadonlySet<string> = new Set([
	"not_found",
	"task_not_found",
	"validation_error",
	"read_error",
]);

/**
 * Classify a tsq CLI error code from a linked `show` call.
 *
 * - `"actionable"` — not-found, validation, read-envelope → ok:true, ready:false
 * - `"internal"` — process/timeout/abort/invalid-JSON → ok:false
 */
export function classifyReadError(code: string): "actionable" | "internal" {
	return ACTIONABLE_ERROR_CODES.has(code.toLowerCase())
		? "actionable"
		: "internal";
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface HandoffTodoBlocker {
	readonly todoId: number;
	readonly subject: string;
	readonly status: string;
	readonly reason: string;
}

export interface HandoffLinkedBlocker {
	readonly todoId: number;
	readonly tsqId: string;
	readonly status: string;
	readonly classification: "blocker" | "warning";
}

export interface HandoffReadError {
	readonly tsqId: string;
	readonly code: string;
	readonly message: string;
}

export interface HandoffReadyResult {
	readonly ok: true;
	readonly ready: true;
	readonly projectRoot?: string;
}

export interface HandoffNotReadyResult {
	readonly ok: true;
	readonly ready: false;
	readonly projectRoot?: string;
	readonly todoBlockers?: readonly HandoffTodoBlocker[];
	readonly linkedBlockers?: readonly HandoffLinkedBlocker[];
	readonly linkedWarnings?: readonly HandoffLinkedBlocker[];
	readonly readErrors?: readonly HandoffReadError[];
}

export interface HandoffInternalError {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
}

export type HandoffCheckResult =
	| HandoffReadyResult
	| HandoffNotReadyResult
	| HandoffInternalError;

// ---------------------------------------------------------------------------
// Collector options
// ---------------------------------------------------------------------------

export interface CollectHandoffOptions {
	readonly pi: ExtensionAPI;
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Collector implementation
// ---------------------------------------------------------------------------

/**
 * Collect handoff readiness from session todo state and linked durable tasks.
 *
 * Read-only: never mutates session todos or durable task state.
 * Only uses `tsq show <id>` (read-only) for linked tasks.
 */
export async function collectHandoffStatus(
	options: CollectHandoffOptions,
): Promise<HandoffCheckResult> {
	const { pi, cwd, signal } = options;

	// 1. Read session todo state (snapshot, no mutation)
	const state = getState();
	const visibleTodos = selectVisibleTasks(state);

	// 2. Collect todo blockers
	const todoBlockers = collectTodoBlockers(visibleTodos);

	// 3. Derive todo↔task links
	const links = deriveTaskLinks(state);

	// 4. If links exist, resolve project root and read linked task statuses
	if (links.length > 0) {
		let projectRoot: string;
		try {
			projectRoot = await resolveProjectRoot(
				pi,
				cwd,
				signal != null ? { signal } : {},
			);
		} catch (err) {
			return {
				ok: false,
				code: "project_resolution_error",
				message:
					err instanceof Error ? err.message : "Unable to resolve project root",
			};
		}

		const linkedBlockers: HandoffLinkedBlocker[] = [];
		const linkedWarnings: HandoffLinkedBlocker[] = [];
		const readErrors: HandoffReadError[] = [];

		for (const link of links) {
			const result = await readLinkedTaskStatus(
				pi,
				projectRoot,
				link.tsqId,
				link.todoId,
				signal,
			);

			if (result.type === "internal_error") {
				return { ok: false, code: result.code, message: result.message };
			}
			if (result.type === "read_error") {
				readErrors.push(result.error);
			} else if (result.type === "blocker") {
				linkedBlockers.push(result.entry);
			} else if (result.type === "warning") {
				linkedWarnings.push(result.entry);
			}
			// "ready" → no action needed
		}

		const hasBlockers =
			todoBlockers.length > 0 ||
			linkedBlockers.length > 0 ||
			readErrors.length > 0;
		const hasWarnings = linkedWarnings.length > 0;

		if (!hasBlockers && !hasWarnings) {
			return { ok: true, ready: true, projectRoot };
		}

		return {
			ok: true,
			ready: !hasBlockers,
			projectRoot,
			...(todoBlockers.length > 0 ? { todoBlockers } : {}),
			...(linkedBlockers.length > 0 ? { linkedBlockers } : {}),
			...(linkedWarnings.length > 0 ? { linkedWarnings } : {}),
			...(readErrors.length > 0 ? { readErrors } : {}),
		} as HandoffCheckResult;
	}

	// No links: todo-only readiness (no git root needed)
	if (todoBlockers.length > 0) {
		return { ok: true, ready: false, todoBlockers };
	}

	return { ok: true, ready: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectTodoBlockers(todos: readonly Task[]): HandoffTodoBlocker[] {
	const blockers: HandoffTodoBlocker[] = [];

	for (const todo of todos) {
		if (todo.status === "pending") {
			const hasUnresolvedBlockers =
				todo.blockedBy != null && todo.blockedBy.length > 0;
			blockers.push({
				todoId: todo.id,
				subject: todo.subject,
				status: "pending",
				reason: hasUnresolvedBlockers ? "blocked" : "pending",
			});
		} else if (todo.status === "in_progress") {
			blockers.push({
				todoId: todo.id,
				subject: todo.subject,
				status: "in_progress",
				reason: "in_progress",
			});
		}
	}

	return blockers;
}

type LinkedReadResult =
	| { type: "ready" }
	| { type: "blocker"; entry: HandoffLinkedBlocker }
	| { type: "warning"; entry: HandoffLinkedBlocker }
	| { type: "read_error"; error: HandoffReadError }
	| { type: "internal_error"; code: string; message: string };

async function readLinkedTaskStatus(
	pi: ExtensionAPI,
	projectRoot: string,
	tsqId: string,
	todoId: number,
	signal?: AbortSignal,
): Promise<LinkedReadResult> {
	try {
		const data = await runTsqJson<TsqShowData>(
			pi,
			{ cwd: projectRoot },
			["show", tsqId],
			signal != null ? { signal } : {},
		);

		const status = data.task?.status;
		const classification = classifyDurableStatus(status);

		if (classification === "ready") return { type: "ready" };

		return {
			type: classification,
			entry: {
				todoId,
				tsqId,
				status: status ?? "unknown",
				classification,
			},
		};
	} catch (err) {
		if (err instanceof TsqCommandError) {
			const errClass = classifyReadError(err.code);
			if (errClass === "actionable") {
				return {
					type: "read_error",
					error: { tsqId, code: err.code, message: err.message },
				};
			}
			return {
				type: "internal_error",
				code: err.code,
				message: err.message,
			};
		}

		if (err instanceof TsqProcessError) {
			return {
				type: "internal_error",
				code: "process_error",
				message: err.message,
			};
		}

		return {
			type: "internal_error",
			code: "unknown",
			message: err instanceof Error ? err.message : "Unknown error",
		};
	}
}
