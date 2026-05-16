import { beforeEach, describe, expect, it } from "vitest";
import { executeTaskTool } from "../../src/durable-tasks/task-tool.js";
import { __resetState } from "../../src/session-todos/state/store.js";
import { ctx, makePi, okEnvelope } from "./task-test-helpers.js";

beforeEach(() => {
	__resetState();
});

describe("bulk action", () => {
	it("rejects empty items array", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "bulk", items: [] } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "items must be a non-empty array",
			},
		});
	});

	it("rejects missing items field", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "bulk" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "items must be a non-empty array",
			},
		});
	});

	it("rejects item missing task id", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "bulk",
				items: [{ action: "finish" }],
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "items[0].task is required",
			},
		});
	});

	it("rejects item missing action", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "bulk",
				items: [{ task: "tsq-1" }],
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: "items[0].action is required",
			},
		});
	});

	it("rejects unsupported bulk item action", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "bulk",
				items: [{ action: "create", task: "tsq-1" }],
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: expect.stringContaining('"create" is not supported'),
			},
		});
	});

	it("rejects note item without because", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "bulk",
				items: [{ action: "note", task: "tsq-1" }],
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "validation_error",
				message: 'items[0].because is required when action is "note"',
			},
		});
	});

	it("dispatches valid bulk items to executeBulk with project root", async () => {
		const { pi, captured } = makePi();
		captured.execHandler = (command) => {
			if (command === "git") {
				return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
			}
			return {
				stdout: okEnvelope({ task: { id: "tsq-x", title: "Done" } }),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const result = await executeTaskTool(
			pi,
			{
				action: "bulk",
				items: [
					{ action: "finish", task: "tsq-1", because: "Done" },
					{ action: "start", task: "tsq-2" },
					{ action: "mark_planned", task: "tsq-3" },
				],
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			data: {
				completed: ["tsq-1", "tsq-2", "tsq-3"],
				skipped: [],
			},
			projectRoot: "/repo",
		});
		// git + 3 tsq mutations
		expect(captured.execCalls).toHaveLength(4);
		expect(captured.execCalls[0]).toMatchObject({ command: "git" });
	});

	it("includes mark_planned as supported bulk item action", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{
				action: "bulk",
				items: [{ action: "mark_planned", task: "tsq-5" }],
			} as any,
			undefined,
			ctx,
		);

		// Should pass validation and execute (not validation_error)
		expect(result.details).toMatchObject({
			ok: true,
			data: { completed: ["tsq-5"], skipped: [] },
		});
	});
});
