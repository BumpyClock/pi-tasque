import type { TaskBridgeParams } from "../bridge/types.js";
import { definedParams } from "../shared/validation.js";
import type { TaskParams } from "./task-schema.js";
import { getTodoId, hasWith } from "./task-validation.js";
import type { TsqChangeParams } from "./tools-change.js";
import type { TsqQueryParams } from "./tools-query.js";

export function toQueryParams(params: TaskParams): TsqQueryParams {
	switch (params.action) {
		case "doctor":
			return { action: "doctor" };
		case "find":
			if (params.view === "tree") {
				return definedParams<TsqQueryParams>({
					action: "find_tree",
					id: params.task,
				});
			}
			return params.tasks === "open"
				? definedParams<TsqQueryParams>({
						action: "find_open",
						assignee: params.for,
					})
				: definedParams<TsqQueryParams>({
						action: "find_ready",
						lane: params.lane,
						assignee: params.for,
					});
		case "show":
			return definedParams<TsqQueryParams>({
				action: hasWith(params, "spec") ? "show_with_spec" : "show",
				id: params.task,
			});
		case "deps":
			return definedParams<TsqQueryParams>({ action: "deps", id: params.task });
		case "notes":
			return definedParams<TsqQueryParams>({
				action: "notes",
				id: params.task,
			});
		case "similar":
			return definedParams<TsqQueryParams>({
				action: "similar",
				query: params.query,
			});
		default:
			throw new Error(`Unsupported query action: ${params.action}`);
	}
}

export function toChangeParams(params: TaskParams): TsqChangeParams {
	switch (params.action) {
		case "create":
			return definedParams<TsqChangeParams>({
				action: "create",
				title: params.task,
				kind: params.kind,
				priority: params.priority,
				description: params.description,
				parent: params.under,
				planned: params.planned,
				needsPlan: params.needsPlan,
			});
		case "note":
			return definedParams<TsqChangeParams>({
				action: "note",
				id: params.task,
				note: params.because,
			});
		case "finish":
			return definedParams<TsqChangeParams>({
				action: "done",
				id: params.task,
				note: params.because,
			});
		case "reopen":
		case "start":
			return definedParams<TsqChangeParams>({
				action: params.action,
				id: params.task,
			});
		case "defer":
			return definedParams<TsqChangeParams>({
				action: "defer",
				id: params.task,
				note: params.because,
			});
		case "block":
			return definedParams<TsqChangeParams>({
				action: "block",
				child: params.task,
				blocker: params.by,
			});
		case "unblock":
			return definedParams<TsqChangeParams>({
				action: "unblock",
				child: params.task,
				blocker: params.by,
			});
		case "order":
			return definedParams<TsqChangeParams>({
				action: "order",
				later: params.task,
				earlier: params.after,
			});
		case "unorder":
			return definedParams<TsqChangeParams>({
				action: "unorder",
				later: params.task,
				earlier: params.after,
			});
		default:
			throw new Error(`Unsupported change action: ${params.action}`);
	}
}

export function toClaimParams(
	params: TaskParams,
): Readonly<Record<string, unknown>> {
	return definedParams<Readonly<Record<string, unknown>>>({
		id: params.task,
		assignee: params.for,
		start: params.start,
		requireSpec: params.requireSpec,
		createTodo: params.todo === true,
	});
}

export function toBridgeParams(params: TaskParams): TaskBridgeParams {
	switch (params.action) {
		case "link":
			return definedParams<TaskBridgeParams>({
				action: "link",
				todoId: getTodoId(params.todo),
				tsqId: params.task,
			});
		case "list_links":
			return { action: "list_links" };
		case "promote":
			return definedParams<TaskBridgeParams>({
				action: "promote_todo",
				todoId: getTodoId(params.todo),
				assignee: params.for,
				kind: params.kind,
				priority: params.priority,
				description: params.description,
				parent: params.under,
				planned: params.planned,
				needsPlan: params.needsPlan,
			});
		case "import":
			return definedParams<TaskBridgeParams>({
				action: "import_tsq",
				tsqId: params.task,
				owner: params.for,
			});
		default:
			throw new Error(`Unsupported bridge action: ${params.action}`);
	}
}
