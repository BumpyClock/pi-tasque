import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../shared/error-utils.js";
import {
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
} from "../guidelines/todo.js";
import {
	selectTasksByStatus,
	selectTodoCounts,
	selectVisibleTasks,
} from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, getState, replaceState } from "./state/store.js";
import { replayFromBranch } from "./state/replay.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
	type TaskAction,
	type TaskMutationParams,
} from "./tool/types.js";
import { TodoOverlay } from "./todo-overlay.js";
import {
	formatCommandTaskLine,
	formatStatusLabel,
	renderTodoCall,
	renderTodoResult,
} from "./view/format.js";

const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";
const TODO_AFFECTING_TOOLS = new Set(["todo", "task"]);

export {
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
} from "../guidelines/todo.js";

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export {
	__resetState,
	commitState,
	getNextId,
	getState,
	getTodos,
} from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type {
	Task,
	TaskAction,
	TaskDetails,
	TaskMutationParams,
	TaskStatus,
} from "./tool/types.js";
export { COMMAND_NAME, TOOL_NAME } from "./tool/types.js";

/** Rebuild live todo state from the current branch replay snapshot. */
export function reconstructTodoState(
	ctx: Parameters<typeof replayFromBranch>[0],
): void {
	replaceState(replayFromBranch(ctx));
}

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage current-session todos for tactical execution. Actions: create, update, list, get, delete, clear. Use for this session's checklist; use task for durable project work.",
		promptSnippet: TODO_PROMPT_SNIPPET,
		promptGuidelines: TODO_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, ...mutationParams } = params as TaskMutationParams & {
				action: TaskAction;
			};
			const result = applyTaskMutation(getState(), action, mutationParams);
			commitState(result.state);
			return buildToolResult(action, mutationParams, result.state, result.op);
		},

		renderCall(args, theme, _context) {
			return renderTodoCall(
				args as TaskMutationParams & { action: TaskAction },
				theme,
				getState(),
			);
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show current-session todos grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(ERR_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const state = getState();
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(MSG_NO_TODOS, "info");
				return;
			}

			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);
			const header: string[] = [];
			if (counts.completed > 0) {
				header.push(
					`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`,
				);
			}
			if (counts.inProgress > 0) {
				header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			}
			if (counts.pending > 0) {
				header.push(`${counts.pending} ${formatStatusLabel("pending")}`);
			}

			const lines = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(SECTION_PENDING);
				for (const task of groups.pending) {
					lines.push(formatCommandTaskLine(task, "○"));
				}
			}
			if (groups.inProgress.length > 0) {
				lines.push(SECTION_IN_PROGRESS);
				for (const task of groups.inProgress) {
					lines.push(formatCommandTaskLine(task, "◐"));
				}
			}
			if (groups.completed.length > 0) {
				lines.push(SECTION_COMPLETED);
				for (const task of groups.completed) {
					lines.push(formatCommandTaskLine(task, "✓"));
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

export function registerSessionTodoModule(pi: ExtensionAPI): void {
	registerTodoTool(pi);
	registerTodosCommand(pi);
	registerTodoLifecycle(pi);
}

function registerTodoLifecycle(pi: ExtensionAPI): void {
	const overlay = new TodoOverlay();

	function bindUiAndUpdate(ctx: ExtensionContext): void {
		if (!hasOverlayUi(ctx)) {
			overlay.dispose();
			return;
		}
		overlay.setUICtx(ctx.ui);
		overlay.update();
	}

	function replayAndUpdate(
		ctx: ExtensionContext,
		options: { readonly resetCompletedDisplayState: boolean },
	): void {
		reconstructTodoState(ctx);
		if (options.resetCompletedDisplayState) {
			overlay.resetCompletedDisplayState();
		}
		bindUiAndUpdate(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		replayAndUpdate(ctx, { resetCompletedDisplayState: true });
	});

	pi.on("session_compact", (_event, ctx) => {
		replayAndUpdate(ctx, { resetCompletedDisplayState: false });
	});

	pi.on("session_tree", (_event, ctx) => {
		replayAndUpdate(ctx, { resetCompletedDisplayState: true });
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!TODO_AFFECTING_TOOLS.has(event.toolName)) return;
		if (!isSuccessfulToolExecutionResult(event)) return;
		bindUiAndUpdate(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!hasOverlayUi(ctx)) return;
		overlay.setUICtx(ctx.ui);
		overlay.hideCompletedTasksFromPreviousTurn();
	});

	pi.on("session_shutdown", () => {
		overlay.dispose();
	});
}

function hasOverlayUi(ctx: ExtensionContext): boolean {
	return ctx.hasUI === true && ctx.ui !== undefined;
}

function isSuccessfulToolExecutionResult(event: {
	readonly isError: boolean;
	readonly result: unknown;
}): boolean {
	if (event.isError) return false;
	const result = event.result;
	if (!isRecord(result)) return true;
	const details = result.details;
	if (!isRecord(details)) return true;
	if (details.ok === false) return false;
	return details.error === undefined;
}
