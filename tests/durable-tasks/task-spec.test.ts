import { beforeEach, describe, expect, it } from "vitest";
import { executeTaskTool } from "../../src/durable-tasks/task-tool.js";
import { __resetState } from "../../src/session-todos/state/store.js";
import { ctx, makePi, okEnvelope } from "./task-test-helpers.js";

beforeEach(() => {
	__resetState();
});

describe("spec action", () => {
	it("requires task field", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "spec", mode: "show" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "task is required" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("requires mode field", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "spec", task: "tsq-5" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "mode is required" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("requires text for set mode", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "spec", task: "tsq-5", mode: "set" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("requires text for update mode", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "spec", task: "tsq-5", mode: "update" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("rejects text for show mode", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "spec", task: "tsq-5", mode: "show", text: "hello" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("rejects text for check mode", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "spec", task: "tsq-5", mode: "check", text: "hello" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("dispatches spec show to executeTsqSpec with project root", async () => {
		const { pi, captured } = makePi();
		captured.execHandler = (command) => {
			if (command === "git") {
				return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
			}
			return {
				stdout: okEnvelope({
					content: "# Spec content",
					path: "specs/tsq-5.md",
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const result = await executeTaskTool(
			pi,
			{ action: "spec", task: "tsq-5", mode: "show" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			action: "spec",
			mode: "show",
			projectRoot: "/repo",
		});
		expect(captured.execCalls.at(-1)).toMatchObject({
			command: "tsq",
			args: ["spec", "tsq-5", "--show", "--format", "json"],
			options: { cwd: "/repo" },
		});
	});

	it("dispatches spec set with text", async () => {
		const { pi, captured } = makePi();
		captured.execHandler = (command) => {
			if (command === "git") {
				return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
			}
			return {
				stdout: okEnvelope({ ok: true }),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const result = await executeTaskTool(
			pi,
			{
				action: "spec",
				task: "tsq-5",
				mode: "set",
				text: "New spec text",
			} as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			action: "spec",
			mode: "set",
			projectRoot: "/repo",
		});
		expect(captured.execCalls.at(-1)).toMatchObject({
			command: "tsq",
			args: [
				"spec",
				"tsq-5",
				"--force",
				"--text=New spec text",
				"--format",
				"json",
			],
			options: { cwd: "/repo" },
		});
	});
});
