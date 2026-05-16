import { StringEnum } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { Task, TaskStatus } from "../session-todos/tool/types.js";
import type { StandardToolDetails } from "../shared/tool-result.js";

export const TASK_BRIDGE_TOOL_NAME = "task_bridge";

export const TASK_BRIDGE_ACTIONS = [
	"link",
	"list_links",
	"promote_todo",
	"import_tsq",
] as const;

export type TaskBridgeAction = (typeof TASK_BRIDGE_ACTIONS)[number];

export const TaskBridgeParamsSchema = Type.Object(
	{
		action: StringEnum(TASK_BRIDGE_ACTIONS, {
			description:
				"Explicit bridge operation between session todo state and durable tasks.",
		}),
		todoId: Type.Optional(
			Type.Integer({
				description:
					"Session todo id. Required when linking or promoting a todo.",
				minimum: 1,
			}),
		),
		tsqId: Type.Optional(
			Type.String({
				description:
					"Durable task id. Required when linking or importing a task.",
			}),
		),
		assignee: Type.Optional(
			Type.String({
				description:
					"Agent/owner name used when creating or importing linked task todos.",
			}),
		),
		owner: Type.Optional(
			Type.String({
				description: "Todo owner used when importing a durable task.",
			}),
		),
		kind: Type.Optional(
			Type.String({
				description: "Durable task kind used when promoting a todo.",
			}),
		),
		priority: Type.Optional(
			Type.Integer({
				description: "Durable task priority used when promoting a todo.",
			}),
		),
		description: Type.Optional(
			Type.String({
				description: "Description override used when promoting a todo.",
			}),
		),
		parent: Type.Optional(
			Type.String({
				description: "Parent durable task id used when promoting a todo.",
			}),
		),
		planned: Type.Optional(
			Type.Boolean({
				description: "Planning flag used when promoting a todo.",
			}),
		),
		needsPlan: Type.Optional(
			Type.Boolean({
				description: "Planning flag used when promoting a todo.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type TaskBridgeParams = Static<typeof TaskBridgeParamsSchema>;

export interface TaskBridgeLink {
	readonly todoId: number;
	readonly todoSubject: string;
	readonly todoStatus: Exclude<TaskStatus, "deleted">;
	readonly tsqId: string;
}

export interface TaskBridgeTodoSnapshot {
	readonly tasks: readonly Task[];
	readonly nextId: number;
}

export interface LinkBridgeParams extends TaskBridgeParams {
	readonly action: "link";
	readonly todoId?: number;
	readonly tsqId?: string;
}

export interface ListLinksBridgeParams extends TaskBridgeParams {
	readonly action: "list_links";
}

export interface PromoteTodoBridgeParams extends TaskBridgeParams {
	readonly action: "promote_todo";
	readonly todoId?: number;
}

export interface ImportTsqBridgeParams extends TaskBridgeParams {
	readonly action: "import_tsq";
	readonly tsqId?: string;
}

export type TaskBridgeSuccessData =
	| {
			readonly action: "link";
			readonly link: TaskBridgeLink;
			readonly todo: Task;
	  }
	| {
			readonly action: "list_links";
			readonly links: readonly TaskBridgeLink[];
	  }
	| {
			readonly action: "promote_todo" | "import_tsq";
			readonly todoSnapshot?: TaskBridgeTodoSnapshot;
			readonly [key: string]: unknown;
	  };

export type TaskBridgeDetails = StandardToolDetails<TaskBridgeSuccessData>;

export interface TaskBridgeHandlerContext {
	readonly pi: ExtensionAPI;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly extensionContext: ExtensionContext;
}

export type TaskBridgeActionHandler<TParams extends TaskBridgeParams> = (
	params: TParams,
	ctx: TaskBridgeHandlerContext,
) =>
	| AgentToolResult<TaskBridgeDetails>
	| Promise<AgentToolResult<TaskBridgeDetails>>;

export interface TaskBridgeHandlers {
	readonly promote_todo?: TaskBridgeActionHandler<PromoteTodoBridgeParams>;
	readonly import_tsq?: TaskBridgeActionHandler<ImportTsqBridgeParams>;
}
