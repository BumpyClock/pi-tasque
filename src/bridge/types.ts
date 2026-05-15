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
				"Explicit bridge operation between session todo state and durable Tasque tasks.",
		}),
		todoId: Type.Optional(
			Type.Integer({
				description:
					"Session todo id. Required for link and promote_todo actions.",
				minimum: 1,
			}),
		),
		tsqId: Type.Optional(
			Type.String({
				description:
					"Durable Tasque task id. Required for link and import_tsq actions.",
			}),
		),
		assignee: Type.Optional(
			Type.String({
				description:
					"Agent/owner name used by promote_todo/import_tsq bridge actions.",
			}),
		),
		owner: Type.Optional(
			Type.String({
				description: "Todo owner used by import_tsq bridge action.",
			}),
		),
		kind: Type.Optional(
			Type.String({
				description: "Tasque task kind used by promote_todo bridge action.",
			}),
		),
		priority: Type.Optional(
			Type.Integer({
				description: "Tasque priority used by promote_todo bridge action.",
			}),
		),
		description: Type.Optional(
			Type.String({
				description: "Description override used by promote_todo bridge action.",
			}),
		),
		parent: Type.Optional(
			Type.String({
				description:
					"Parent Tasque task id used by promote_todo bridge action.",
			}),
		),
		planned: Type.Optional(
			Type.Boolean({
				description: "Planning flag used by promote_todo bridge action.",
			}),
		),
		needsPlan: Type.Optional(
			Type.Boolean({
				description: "Planning flag used by promote_todo bridge action.",
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
