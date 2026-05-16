import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { BULK_ITEM_ACTIONS } from "./bulk-contract.js";

export const TASK_TOOL_NAME = "task";

export const TASK_ACTIONS = [
	"doctor",
	"find",
	"show",
	"deps",
	"notes",
	"similar",
	"create",
	"note",
	"finish",
	"reopen",
	"defer",
	"start",
	"claim",
	"block",
	"unblock",
	"order",
	"unorder",
	"spec",
	"mark_planned",
	"bulk",
	"create_tree",
	"handoff_check",
	"link",
	"list_links",
	"promote",
	"import",
] as const;

export const FIND_TARGETS = ["ready", "open"] as const;
export const VIEW_MODES = ["list", "tree"] as const;
export const SPEC_MODES = ["show", "check", "set", "update"] as const;
export const BRIDGE_DESTINATIONS = ["todo"] as const;

export type TaskAction = (typeof TASK_ACTIONS)[number];

const BulkItemParamsSchema = Type.Object({
	action: StringEnum(BULK_ITEM_ACTIONS, {
		description:
			"Bulk item action: start, finish, reopen, defer, note, or mark_planned.",
	}),
	task: Type.String({ description: "Durable task id for this bulk item." }),
	because: Type.Optional(
		Type.String({
			description:
				"Note/reason text. Required for note; optional for finish/defer.",
		}),
	),
});

const CreateTreeNodeParamsSchema = Type.Object({
	title: Type.String({ description: "Durable task title for this node." }),
	kind: Type.String({ description: "Durable task kind for this node." }),
	priority: Type.Integer({
		description: "Durable task priority for this node.",
	}),
	description: Type.Optional(
		Type.String({ description: "Task description for this node." }),
	),
	planned: Type.Optional(
		Type.Boolean({ description: "Mark this node planned." }),
	),
	needsPlan: Type.Optional(
		Type.Boolean({ description: "Mark this node as needing planning." }),
	),
	children: Type.Optional(
		Type.Array(
			Type.Unknown({
				description:
					"Child create-tree nodes with the same shape: { title, kind, priority, description?, planned?, needsPlan?, children? }.",
			}),
			{ description: "Nested child task nodes." },
		),
	),
});

export const TaskParamsSchema = Type.Object(
	{
		action: StringEnum(TASK_ACTIONS, {
			description: "Durable task action to run.",
		}),
		task: Type.Optional(
			Type.String({
				description: "Durable task id for existing tasks, or title for create.",
			}),
		),
		tasks: Type.Optional(
			StringEnum(FIND_TARGETS, {
				description: "Task set for find actions.",
			}),
		),
		view: Type.Optional(
			StringEnum(VIEW_MODES, {
				description: "Find output view.",
			}),
		),
		lane: Type.Optional(
			Type.String({ description: "Ready-task lane, e.g. planning or coding." }),
		),
		for: Type.Optional(
			Type.String({ description: "Assignee or owner for claim/find/import." }),
		),
		query: Type.Optional(
			Type.String({ description: "Search text for similar task lookup." }),
		),
		with: Type.Optional(
			Type.Array(
				Type.String({ description: "Extra context to include, e.g. spec." }),
			),
		),
		kind: Type.Optional(Type.String({ description: "Durable task kind." })),
		priority: Type.Optional(
			Type.Integer({ description: "Durable task priority." }),
		),
		description: Type.Optional(
			Type.String({ description: "Task description for create/promote." }),
		),
		under: Type.Optional(
			Type.String({
				description: "Parent durable task id for create/promote.",
			}),
		),
		planned: Type.Optional(
			Type.Boolean({ description: "Mark created/promoted task planned." }),
		),
		needsPlan: Type.Optional(
			Type.Boolean({
				description: "Mark created/promoted task as needing planning.",
			}),
		),
		because: Type.Optional(
			Type.String({
				description: "Note or reason text for lifecycle actions.",
			}),
		),
		by: Type.Optional(
			Type.String({
				description: "Blocking durable task id for block/unblock.",
			}),
		),
		after: Type.Optional(
			Type.String({
				description: "Earlier durable task id for order/unorder.",
			}),
		),
		start: Type.Optional(
			Type.Boolean({
				description: "Start task while claiming. Defaults true.",
			}),
		),
		requireSpec: Type.Optional(
			Type.Boolean({ description: "Require an attached spec before claim." }),
		),
		todo: Type.Optional(
			Type.Union([
				Type.Boolean({ description: "Create a linked todo for claim." }),
				Type.Integer({ description: "Session todo id for link/promote." }),
			]),
		),
		mode: Type.Optional(
			StringEnum(SPEC_MODES, {
				description: "Spec operation mode for spec action.",
			}),
		),
		text: Type.Optional(
			Type.String({
				description: "Spec text content for spec set/update.",
			}),
		),
		to: Type.Optional(
			StringEnum(BRIDGE_DESTINATIONS, {
				description: "Bridge destination for import.",
			}),
		),
		items: Type.Optional(
			Type.Array(BulkItemParamsSchema, {
				description:
					"Bulk lifecycle items. Each item has { action, task, because? }.",
				minItems: 1,
			}),
		),
		root: Type.Optional(CreateTreeNodeParamsSchema),
	},
	{ additionalProperties: false },
);

export type TaskParams = Static<typeof TaskParamsSchema>;
