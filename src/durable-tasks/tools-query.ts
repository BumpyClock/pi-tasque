import { StringEnum } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	READ_TASKS_PROMPT_GUIDELINES,
	READ_TASKS_PROMPT_SNIPPET,
} from "../guidelines/internal-tools.js";
import { isRecord } from "../shared/error-utils.js";
import { truncatedTextToolResult } from "../shared/tool-result.js";
import type { TruncatedText } from "../shared/truncation.js";
import { runTsqJson } from "./runner.js";
import type {
	TsqDepTreeNode,
	TsqDoctorData,
	TsqNotesData,
	TsqQueryData,
	TsqShowData,
	TsqSimilarData,
	TsqTask,
	TsqTaskListResult,
	TsqTaskTreeNode,
	TsqTreeResult,
} from "./types.js";

export const TSQ_QUERY_TOOL_NAME = "tsq_query";

export const TSQ_QUERY_ACTIONS = [
	"doctor",
	"find_ready",
	"find_open",
	"show",
	"show_with_spec",
	"deps",
	"notes",
	"find_tree",
	"similar",
] as const;

export type TsqQueryAction = (typeof TSQ_QUERY_ACTIONS)[number];

export const TsqQueryParamsSchema = Type.Object(
	{
		action: StringEnum(TSQ_QUERY_ACTIONS, {
			description: "Read-only durable task query to run.",
		}),
		id: Type.Optional(
			Type.String({
				description:
					"Durable task id. Required for show, spec details, deps, and notes.",
			}),
		),
		lane: Type.Optional(
			Type.String({
				description: "Ready-task lane filter, e.g. planning or coding.",
			}),
		),
		assignee: Type.Optional(
			Type.String({ description: "Assignee filter for find actions." }),
		),
		status: Type.Optional(
			Type.String({
				description:
					"Reserved status filter; find_open already queries open tasks.",
			}),
		),
		tree: Type.Optional(
			Type.Boolean({
				description: "Request tree output when supported by the action.",
			}),
		),
		depth: Type.Optional(
			Type.Integer({
				description: "Dependency traversal depth for deps.",
				minimum: 1,
			}),
		),
		query: Type.Optional(
			Type.String({ description: "Search text for similar task lookup." }),
		),
	},
	{ additionalProperties: false },
);

export type TsqQueryParams = Static<typeof TsqQueryParamsSchema>;

export interface TsqQueryDetails {
	readonly [key: string]: unknown;
	readonly ok: true;
	readonly action: TsqQueryAction;
	readonly argv: readonly string[];
	readonly data: TsqQueryData;
}

const MAX_RENDERED_ITEMS = 12;
const MAX_CONTENT_LINES = 24;
const MAX_CONTENT_CHARS = 4_000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

export function registerTsqQueryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TSQ_QUERY_TOOL_NAME,
		label: "Task Query",
		description: "Read durable task state. Does not mutate tasks.",
		promptSnippet: READ_TASKS_PROMPT_SNIPPET,
		promptGuidelines: READ_TASKS_PROMPT_GUIDELINES,
		parameters: TsqQueryParamsSchema,
		executionMode: "parallel",
		async execute(
			_toolCallId,
			params,
			signal,
			_onUpdate,
			ctx,
		): Promise<
			AgentToolResult<TsqQueryDetails & { readonly truncation: TruncatedText }>
		> {
			return executeTsqQuery(pi, params, signal, ctx);
		},
	});
}

export async function executeTsqQuery(
	pi: ExtensionAPI,
	params: TsqQueryParams,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<
	AgentToolResult<TsqQueryDetails & { readonly truncation: TruncatedText }>
> {
	const argv = buildTsqQueryArgv(params);
	const rawData = await runTsqJson<TsqQueryData>(pi, { cwd: ctx.cwd }, argv, {
		timeout: DEFAULT_QUERY_TIMEOUT_MS,
		...(signal === undefined ? {} : { signal }),
	});
	const data = normalizeQueryData(params, rawData);
	const text = formatTsqQueryResult(params, data);

	const details: TsqQueryDetails = {
		ok: true,
		action: params.action,
		argv,
		data,
	};
	return truncatedTextToolResult(text, details, {
		maxLines: MAX_CONTENT_LINES,
		maxChars: MAX_CONTENT_CHARS,
	});
}

export function buildTsqQueryArgv(params: TsqQueryParams): string[] {
	const depth = validateDepth(params.depth);
	switch (params.action) {
		case "doctor":
			return ["doctor"];
		case "find_ready":
			return [
				"find",
				"ready",
				...optionalPair("--lane", params.lane),
				...optionalPair("--assignee", params.assignee),
				...(params.tree === true ? ["--tree"] : []),
			];
		case "find_open":
			return [
				"find",
				"open",
				...optionalPair("--assignee", params.assignee),
				...(params.tree === true ? ["--tree"] : []),
			];
		case "show":
			return ["show", requireString(params.id, "id", params.action)];
		case "show_with_spec":
			return [
				"show",
				requireString(params.id, "id", params.action),
				"--with-spec",
			];
		case "deps":
			return [
				"deps",
				requireString(params.id, "id", params.action),
				...optionalDepth(depth),
			];
		case "notes":
			return ["notes", requireString(params.id, "id", params.action)];
		case "find_tree":
			return ["find", "open", "--tree"];
		case "similar":
			return [
				"find",
				"similar",
				requireString(params.query, "query", params.action),
			];
	}
}

function normalizeQueryData(
	params: TsqQueryParams,
	data: TsqQueryData,
): TsqQueryData {
	if (params.action !== "find_tree") {
		return data;
	}

	const id = params.id?.trim();
	if (id === undefined || id.length === 0) {
		return data;
	}

	const found = findTaskTreeNode(getTreeRoots(data), id);
	const filtered = found === undefined ? [] : [found];
	return Array.isArray(data) ? filtered : { tree: filtered };
}

function formatTsqQueryResult(
	params: TsqQueryParams,
	data: TsqQueryData,
): string {
	switch (params.action) {
		case "doctor":
			return formatDoctor(data);
		case "find_ready":
		case "find_open":
			return params.tree === true || hasTreeData(data)
				? formatTree(data, `${params.action} tree`)
				: formatTaskList(params.action, getTaskList(data));
		case "show":
		case "show_with_spec":
			return formatShow(data);
		case "deps":
			return formatDeps(data);
		case "notes":
			return formatNotes(data);
		case "find_tree":
			return formatTree(data);
		case "similar":
			return formatSimilar(data);
	}
}

function formatDoctor(data: TsqQueryData): string {
	const doctor = data as TsqDoctorData;
	const issueCount = Array.isArray(doctor.issues)
		? doctor.issues.length
		: undefined;
	const parts = [
		"Task doctor",
		formatMetric(doctor.tasks, "tasks"),
		formatMetric(doctor.events, "events"),
		issueCount === undefined ? undefined : `${issueCount} issues`,
	].filter((part): part is string => part !== undefined);
	return parts.join(" · ");
}

function formatTaskList(
	action: TsqQueryAction,
	tasks: readonly TsqTask[],
): string {
	const lines = [
		`Task ${action}: ${formatCount(tasks.length, "task")}${formatLimitNotice(tasks.length)}`,
		...tasks.slice(0, MAX_RENDERED_ITEMS).map(formatTaskLine),
	];
	return lines.join("\n");
}

function formatShow(data: TsqQueryData): string {
	const show = data as Partial<TsqShowData>;
	const task = show.task;
	if (isTsqTask(task)) {
		const parts = [
			task.id,
			task.status,
			task.planning_state,
			formatAssignee(task.assignee),
			`p${task.priority}`,
		]
			.filter((part): part is string => part !== undefined && part.length > 0)
			.join(" ");
		const extra = [
			formatCount(show.blockers?.length ?? 0, "blocker"),
			formatCount(show.dependents?.length ?? 0, "dependent"),
			show.spec?.path === undefined ? undefined : `spec ${show.spec.path}`,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · ");
		return [`Task: ${parts}: ${task.title}`, extra].filter(Boolean).join("\n");
	}
	return "Task: no task data returned";
}

function formatDeps(data: TsqQueryData): string {
	const root = (data as Partial<{ root: TsqDepTreeNode }>).root;
	if (root === undefined) {
		return "Task deps: no dependency data returned";
	}
	const lines = flattenDepTree(root).slice(0, MAX_RENDERED_ITEMS);
	return [
		`Task deps: ${root.id}${formatLimitNotice(countDepTree(root))}`,
		...lines.map(
			({ node, indent }) =>
				`${"  ".repeat(indent)}${formatTaskLine(node.task)}`,
		),
	].join("\n");
}

function formatNotes(data: TsqQueryData): string {
	const notesData = data as Partial<TsqNotesData>;
	const notes = notesData.notes ?? [];
	const taskId = notesData.task_id ?? "task";
	return [
		`Task notes for ${taskId}: ${formatCount(notes.length, "note")}${formatLimitNotice(notes.length)}`,
		...notes.slice(0, MAX_RENDERED_ITEMS).map((note) => {
			const firstLine = note.text.split(/\r?\n/u)[0] ?? "";
			return `${note.ts} ${note.actor}: ${truncateInline(firstLine, 120)}`;
		}),
	].join("\n");
}

function formatTree(data: TsqQueryData, label = "tree"): string {
	const roots = getTreeRoots(data);
	const flattened = roots.flatMap((root) => flattenTaskTree(root));
	return [
		`Task ${label}: ${formatCount(flattened.length, "task")}${formatLimitNotice(flattened.length)}`,
		...flattened
			.slice(0, MAX_RENDERED_ITEMS)
			.map(
				({ node, indent }) =>
					`${"  ".repeat(indent)}${formatTaskLine(node.task)}`,
			),
	].join("\n");
}

function formatSimilar(data: TsqQueryData): string {
	const similar = data as Partial<TsqSimilarData>;
	const candidates = similar.candidates ?? [];
	return [
		`Task similar: ${formatCount(candidates.length, "candidate")}${formatLimitNotice(candidates.length)}`,
		...candidates.slice(0, MAX_RENDERED_ITEMS).map(formatCandidateLine),
	].join("\n");
}

function getTaskList(data: TsqQueryData): readonly TsqTask[] {
	if (Array.isArray(data)) {
		return data.filter(isTsqTask);
	}
	const tasks = (data as Partial<TsqTaskListResult>).tasks;
	return Array.isArray(tasks) ? tasks.filter(isTsqTask) : [];
}

function getTreeRoots(data: TsqQueryData): readonly TsqTaskTreeNode[] {
	if (Array.isArray(data)) {
		return data.filter(isTaskTreeNode);
	}
	const tree = (data as Partial<TsqTreeResult>).tree;
	return Array.isArray(tree) ? tree.filter(isTaskTreeNode) : [];
}

function findTaskTreeNode(
	roots: readonly TsqTaskTreeNode[],
	id: string,
): TsqTaskTreeNode | undefined {
	for (const root of roots) {
		if (root.task.id === id) {
			return root;
		}
		const child = findTaskTreeNode(root.children, id);
		if (child !== undefined) {
			return child;
		}
	}
	return undefined;
}

function hasTreeData(data: TsqQueryData): boolean {
	return Array.isArray(data)
		? data.some(isTaskTreeNode)
		: isRecord(data) && Array.isArray(data.tree);
}

function formatTaskLine(task: TsqTask): string {
	const assignee = formatAssignee(task.assignee);
	return [
		task.id,
		task.status,
		`p${task.priority}`,
		assignee,
		truncateInline(task.title, 100),
	]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join(" ");
}

function formatCandidateLine(candidate: unknown): string {
	if (isTsqTask(candidate)) {
		return formatTaskLine(candidate);
	}
	if (isRecord(candidate)) {
		const taskValue = candidate.task;
		if (isTsqTask(taskValue)) {
			const score = candidate.score;
			return `${formatTaskLine(taskValue)}${typeof score === "number" ? ` score ${score}` : ""}`;
		}
		const id = typeof candidate.id === "string" ? candidate.id : undefined;
		const title =
			typeof candidate.title === "string" ? candidate.title : undefined;
		if (id !== undefined || title !== undefined) {
			return [id, title]
				.filter((part): part is string => part !== undefined)
				.join(" ");
		}
	}
	return truncateInline(JSON.stringify(candidate), 140);
}

function flattenTaskTree(
	node: TsqTaskTreeNode,
	indent = 0,
): readonly { readonly node: TsqTaskTreeNode; readonly indent: number }[] {
	return [
		{ node, indent },
		...node.children.flatMap((child) => flattenTaskTree(child, indent + 1)),
	];
}

function flattenDepTree(
	node: TsqDepTreeNode,
	indent = 0,
): readonly { readonly node: TsqDepTreeNode; readonly indent: number }[] {
	return [
		{ node, indent },
		...node.children.flatMap((child) => flattenDepTree(child, indent + 1)),
	];
}

function countDepTree(node: TsqDepTreeNode): number {
	return (
		1 + node.children.reduce((count, child) => count + countDepTree(child), 0)
	);
}

function optionalPair(flag: string, value: string | undefined): string[] {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? [] : [flag, trimmed];
}

function optionalDepth(depth: number | undefined): string[] {
	return depth === undefined ? [] : ["--depth", String(depth)];
}

function validateDepth(depth: unknown): number | undefined {
	if (depth === undefined) {
		return undefined;
	}
	if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
		throw new Error("task dependency depth must be an integer >= 1");
	}
	return depth;
}

function requireString(
	value: string | undefined,
	field: "id" | "query",
	action: TsqQueryAction,
): string {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) {
		throw new Error(`task action ${action} requires ${field}`);
	}
	return trimmed;
}

function formatCount(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatMetric(
	value: number | undefined,
	noun: string,
): string | undefined {
	return typeof value === "number"
		? formatCount(value, noun.slice(0, -1))
		: undefined;
}

function formatLimitNotice(total: number): string {
	return total > MAX_RENDERED_ITEMS
		? ` (showing first ${MAX_RENDERED_ITEMS})`
		: "";
}

function formatAssignee(
	assignee: string | null | undefined,
): string | undefined {
	return assignee === undefined || assignee === null || assignee.length === 0
		? undefined
		: `@${assignee}`;
}

function truncateInline(text: string | undefined, maxChars: number): string {
	if (text === undefined) {
		return "";
	}
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function isTsqTask(value: unknown): value is TsqTask {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.status === "string" &&
		typeof value.planning_state === "string" &&
		typeof value.priority === "number"
	);
}

function isTaskTreeNode(value: unknown): value is TsqTaskTreeNode {
	return (
		isRecord(value) && isTsqTask(value.task) && Array.isArray(value.children)
	);
}
