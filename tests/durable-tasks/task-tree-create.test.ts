import { beforeEach, describe, expect, it } from "vitest";
import { executeTaskTool } from "../../src/durable-tasks/task-tool.js";
import { __resetState } from "../../src/session-todos/state/store.js";
import { ctx, makePi, okEnvelope } from "./task-test-helpers.js";

beforeEach(() => {
	__resetState();
});

describe("create_tree action", () => {
	it("rejects missing root field", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "create_tree" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root must be an object",
			},
		});
	});

	it("rejects root missing title", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: { kind: "task", priority: 2 },
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root.title is required",
			},
		});
	});

	it("rejects root missing kind", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: { title: "Parent", priority: 2 },
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root.kind is required",
			},
		});
	});

	it("rejects root missing priority", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: { title: "Parent", kind: "task" },
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root.priority is required",
			},
		});
	});

	it("rejects non-string optional description", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: {
					title: "Parent",
					kind: "task",
					priority: 2,
					description: { bad: true },
				},
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root.description must be a string",
			},
		});
	});

	it("rejects non-boolean optional planning flags", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: {
					title: "Parent",
					kind: "task",
					priority: 2,
					planned: "true",
				},
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root.planned must be a boolean",
			},
		});
	});

	it("rejects contradictory planned and needsPlan on root", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: {
					title: "Parent",
					kind: "task",
					priority: 2,
					planned: true,
					needsPlan: true,
				},
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root: planned and needsPlan cannot both be true",
			},
		});
	});

	it("rejects contradictory planned and needsPlan on nested child", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: {
					title: "Parent",
					kind: "task",
					priority: 2,
					children: [
						{
							title: "Child",
							kind: "task",
							priority: 2,
							planned: true,
							needsPlan: true,
						},
					],
				},
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message:
					"root.children[0]: planned and needsPlan cannot both be true",
			},
		});
	});

	it("rejects empty children array", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: {
					title: "Parent",
					kind: "task",
					priority: 2,
					children: [],
				},
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root.children must be a non-empty array when provided",
			},
		});
	});

	it("rejects child missing required fields", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: {
					title: "Parent",
					kind: "task",
					priority: 2,
					children: [{ title: "Child" }],
				},
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "root.children[0].kind is required",
			},
		});
	});

	it("dispatches valid tree to executeCreateTree with project root", async () => {
		const { pi, captured } = makePi();
		let callIndex = 0;
		captured.execHandler = (command) => {
			if (command === "git") {
				return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
			}
			callIndex++;
			const ids = ["tsq-50", "tsq-50.1", "tsq-50.2"];
			const titles = ["Epic parent", "Child A", "Child B"];
			return {
				stdout: okEnvelope({
					task: { id: ids[callIndex - 1], title: titles[callIndex - 1] },
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const result = await executeTaskTool(
			pi,
			{
				action: "create_tree",
				root: {
					title: "Epic parent",
					kind: "task",
					priority: 2,
					description: "Top-level work",
					planned: true,
					children: [
						{
							title: "Child A",
							kind: "task",
							priority: 2,
							needsPlan: true,
						},
						{
							title: "Child B",
							kind: "task",
							priority: 3,
						},
					],
				},
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			data: {
				created: [
					{ id: "tsq-50", title: "Epic parent" },
					{ id: "tsq-50.1", title: "Child A" },
					{ id: "tsq-50.2", title: "Child B" },
				],
				skipped: [],
			},
			projectRoot: "/repo",
		});
		// git + 3 tsq create calls
		expect(captured.execCalls).toHaveLength(4);
		expect(captured.execCalls[0]).toMatchObject({ command: "git" });
	});
});
