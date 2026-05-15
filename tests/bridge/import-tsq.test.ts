import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { importTsqHandler } from "../../src/bridge/import-tsq.js";
import type { TaskBridgeHandlerContext } from "../../src/bridge/types.js";
import type {
	TsqTask,
	TsqTaskTreeNode,
} from "../../src/durable-tasks/types.js";
import { applyTaskMutation } from "../../src/session-todos/state/state-reducer.js";
import {
	commitState,
	getState,
	__resetState,
} from "../../src/session-todos/state/store.js";
import { createMockPi } from "../support/pi-harness.js";

function task(overrides: Partial<TsqTask> = {}): TsqTask {
	return {
		id: "tsq-parent",
		title: "Parent task",
		kind: "task",
		status: "open",
		planning_state: "planned",
		priority: 2,
		labels: [],
		notes: [],
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

interface NodeOverrides {
	readonly children?: readonly TsqTaskTreeNode[];
	readonly blocker_edges?: TsqTaskTreeNode["blocker_edges"];
	readonly dependent_edges?: TsqTaskTreeNode["dependent_edges"];
	readonly blockers?: TsqTaskTreeNode["blockers"];
	readonly dependents?: TsqTaskTreeNode["dependents"];
}

function node(
	taskOverrides: Partial<TsqTask>,
	overrides: NodeOverrides = {},
): TsqTaskTreeNode {
	return {
		task: task(taskOverrides),
		children: overrides.children ?? [],
		blocker_edges: overrides.blocker_edges ?? [],
		dependent_edges: overrides.dependent_edges ?? [],
		blockers: overrides.blockers ?? [],
		dependents: overrides.dependents ?? [],
	};
}

function okEnvelope(data: unknown): string {
	return JSON.stringify({
		schema_version: 1,
		command: "tsq",
		ok: true,
		data,
	});
}

function firstText(result: {
	content: readonly { type: string; text?: string }[];
}): string {
	const first = result.content[0];
	if (first?.type !== "text" || first.text === undefined) {
		throw new Error("expected text content");
	}
	return first.text;
}

function importContext(): ReturnType<typeof createMockPi> & {
	readonly ctx: TaskBridgeHandlerContext;
} {
	const { pi, captured } = createMockPi();
	return {
		pi,
		captured,
		ctx: {
			pi,
			cwd: "/repo",
			extensionContext: { cwd: "/repo" } as ExtensionContext,
		},
	};
}

function createExistingTodo(tsqId: string): number {
	const result = applyTaskMutation(getState(), "create", {
		subject: `Existing ${tsqId}`,
		metadata: { tsqId },
	});
	if (result.op.kind !== "create") {
		throw new Error(
			result.op.kind === "error" ? result.op.message : "expected create op",
		);
	}
	commitState(result.state);
	return result.op.taskId;
}

beforeEach(() => {
	__resetState();
});

describe("importTsqHandler", () => {
	it("imports a parent-only tree node as one linked todo", async () => {
		const { captured, ctx } = importContext();
		captured.execHandler = () => ({
			stdout: okEnvelope({
				tree: [node({ id: "tsq-parent", title: "Parent task" })],
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		const result = await importTsqHandler(
			{ action: "import_tsq", tsqId: "tsq-parent" },
			ctx,
		);

		expect(firstText(result)).toContain("Imported 1 Tasque task");
		expect(getState().tasks).toMatchObject([
			{
				id: 1,
				subject: "Work on tsq-parent: Parent task",
				metadata: { tsqId: "tsq-parent" },
			},
		]);
		expect(result.details).toMatchObject({
			ok: true,
			data: {
				action: "import_tsq",
				tsqId: "tsq-parent",
				source: "tree",
				created: [{ todoId: 1, tsqId: "tsq-parent" }],
				existing: [],
				todoSnapshot: {
					nextId: 2,
					tasks: [
						expect.objectContaining({
							id: 1,
							metadata: { tsqId: "tsq-parent" },
						}),
					],
				},
			},
		});
		expect(captured.execCalls).toMatchObject([
			{
				command: "tsq",
				args: ["find", "open", "--tree", "--format", "json"],
				options: { cwd: "/repo" },
			},
		]);
	});

	it("imports selected task and direct children, but not grandchildren", async () => {
		const { captured, ctx } = importContext();
		captured.execHandler = () => ({
			stdout: okEnvelope({
				tree: [
					node(
						{ id: "tsq-parent", title: "Parent task" },
						{
							children: [
								node(
									{ id: "tsq-child-1", title: "First child" },
									{
										children: [
											node({
												id: "tsq-grandchild",
												title: "Grandchild",
											}),
										],
									},
								),
								node({ id: "tsq-child-2", title: "Second child" }),
							],
						},
					),
				],
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await importTsqHandler(
			{ action: "import_tsq", tsqId: "tsq-parent", owner: "developer" },
			ctx,
		);

		expect(getState().tasks).toMatchObject([
			{
				id: 1,
				subject: "Work on tsq-parent: Parent task",
				owner: "developer",
				metadata: { tsqId: "tsq-parent" },
			},
			{
				id: 2,
				subject: "Work on tsq-child-1: First child",
				owner: "developer",
				metadata: { tsqId: "tsq-child-1" },
			},
			{
				id: 3,
				subject: "Work on tsq-child-2: Second child",
				owner: "developer",
				metadata: { tsqId: "tsq-child-2" },
			},
		]);
		expect(getState().tasks.map((todo) => todo.metadata?.tsqId)).not.toContain(
			"tsq-grandchild",
		);
	});

	it("does not derive blockedBy from parent/child hierarchy alone", async () => {
		const { captured, ctx } = importContext();
		captured.execHandler = () => ({
			stdout: okEnvelope({
				tree: [
					node(
						{ id: "tsq-parent", title: "Parent task" },
						{
							children: [node({ id: "tsq-child", title: "Child task" })],
						},
					),
				],
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await importTsqHandler({ action: "import_tsq", tsqId: "tsq-parent" }, ctx);

		expect(getState().tasks).toEqual(
			expect.arrayContaining([
				expect.not.objectContaining({ blockedBy: expect.any(Array) }),
			]),
		);
		expect(getState().tasks.every((todo) => todo.blockedBy === undefined)).toBe(
			true,
		);
	});

	it("derives todo blockedBy from Tasque dependency edges between imported tasks", async () => {
		const { captured, ctx } = importContext();
		captured.execHandler = () => ({
			stdout: okEnvelope({
				tree: [
					node(
						{ id: "tsq-parent", title: "Parent task" },
						{
							children: [
								node({ id: "tsq-blocker", title: "Blocker" }),
								node(
									{ id: "tsq-blocked", title: "Blocked" },
									{
										blocker_edges: [{ id: "tsq-blocker", dep_type: "blocks" }],
									},
								),
							],
						},
					),
				],
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await importTsqHandler({ action: "import_tsq", tsqId: "tsq-parent" }, ctx);

		expect(getState().tasks.find((todo) => todo.id === 3)).toMatchObject({
			subject: "Work on tsq-blocked: Blocked",
			blockedBy: [2],
		});
		expect(
			getState().tasks.find((todo) => todo.id === 2)?.blockedBy,
		).toBeUndefined();
	});

	it("falls back to tsq show and imports only selected task when tree does not contain it", async () => {
		const { captured, ctx } = importContext();
		captured.execHandler = (_command, args) => ({
			stdout:
				args[0] === "show"
					? okEnvelope({
							task: task({ id: "tsq-missing", title: "Shown task" }),
							blockers: [],
							dependents: [],
							blocker_edges: [],
							dependent_edges: [],
						})
					: okEnvelope({
							tree: [node({ id: "tsq-other", title: "Other task" })],
						}),
			stderr: "",
			code: 0,
			killed: false,
		});

		const result = await importTsqHandler(
			{ action: "import_tsq", tsqId: "tsq-missing" },
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			data: { source: "show" },
		});
		expect(getState().tasks).toMatchObject([
			{
				subject: "Work on tsq-missing: Shown task",
				metadata: { tsqId: "tsq-missing" },
			},
		]);
		expect(captured.execCalls.map((call) => call.args)).toEqual([
			["find", "open", "--tree", "--format", "json"],
			["show", "tsq-missing", "--format", "json"],
		]);
	});

	it("returns existing link info and avoids duplicate session todos", async () => {
		const existingId = createExistingTodo("tsq-parent");
		const { captured, ctx } = importContext();
		captured.execHandler = () => ({
			stdout: okEnvelope({
				tree: [node({ id: "tsq-parent", title: "Parent task" })],
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		const result = await importTsqHandler(
			{ action: "import_tsq", tsqId: "tsq-parent" },
			ctx,
		);

		expect(getState().tasks).toHaveLength(1);
		expect(result.details).toMatchObject({
			ok: true,
			data: {
				created: [],
				existing: [
					{
						todoId: existingId,
						tsqId: "tsq-parent",
						todoSubject: "Existing tsq-parent",
					},
				],
			},
		});
		expect(firstText(result)).toContain(`Existing todo #${existingId}`);
	});
});
