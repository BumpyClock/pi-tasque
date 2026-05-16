import { beforeEach, describe, expect, it } from "vitest";
import { executeTaskTool } from "../../src/durable-tasks/task-tool.js";
import {
	__resetState,
	commitState,
} from "../../src/session-todos/state/store.js";
import { createMockPi } from "../support/pi-harness.js";
import { ctx, makePi, okEnvelope } from "./task-test-helpers.js";

beforeEach(() => {
	__resetState();
});

describe("handoff_check action", () => {
	it("returns ready when no todos exist", async () => {
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "handoff_check" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			ready: true,
		});
		expect(result.details).not.toHaveProperty("projectRoot");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("ready"),
		});
	});

	it("returns not-ready with pending todo blockers", async () => {
		commitState({
			tasks: [{ id: 1, subject: "Write tests", status: "pending" }],
			nextId: 2,
		});
		const { pi } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "handoff_check" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			ready: false,
			todoBlockers: [
				{ todoId: 1, subject: "Write tests", reason: "pending" },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("not ready"),
		});
	});

	it("does not resolve project root (handled internally by collector)", async () => {
		const { pi, captured } = createMockPi();
		// Exec should never be called for a todo-only check
		captured.execHandler = () => {
			throw new Error("exec should not be called");
		};

		const result = await executeTaskTool(
			pi,
			{ action: "handoff_check" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ ok: true, ready: true });
		expect(captured.execCalls).toEqual([]);
	});

	it("returns ok:false for internal collector errors", async () => {
		commitState({
			tasks: [
				{
					id: 1,
					subject: "Linked",
					status: "completed",
					metadata: { tsqId: "tsq-1" },
				},
			],
			nextId: 2,
		});
		const { pi, captured } = createMockPi();
		// Git fails → project resolution error
		captured.execHandler = () => ({
			stdout: "",
			stderr: "not a git repo",
			code: 128,
			killed: false,
		});

		const result = await executeTaskTool(
			pi,
			{ action: "handoff_check" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "project_resolution_error" },
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Error"),
		});
	});

	it("includes linked task blockers when links exist", async () => {
		commitState({
			tasks: [
				{
					id: 1,
					subject: "Deploy",
					status: "completed",
					metadata: { tsqId: "tsq-5" },
				},
			],
			nextId: 2,
		});
		const { pi, captured } = createMockPi();
		captured.execHandler = (cmd) => {
			if (cmd === "git") {
				return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
			}
			return {
				stdout: okEnvelope({
					task: { id: "tsq-5", status: "open", title: "test" },
					blockers: [],
					dependents: [],
					blocker_edges: [],
					dependent_edges: [],
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const result = await executeTaskTool(
			pi,
			{ action: "handoff_check" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			ready: false,
			projectRoot: "/repo",
			linkedBlockers: [{ todoId: 1, tsqId: "tsq-5", status: "open" }],
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("tsq-5"),
		});
	});

	it("preserves warnings when handoff is ready", async () => {
		commitState({
			tasks: [
				{
					id: 1,
					subject: "Canceled link",
					status: "completed",
					metadata: { tsqId: "tsq-canceled" },
				},
			],
			nextId: 2,
		});
		const { pi, captured } = createMockPi();
		captured.execHandler = (cmd) => {
			if (cmd === "git") {
				return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
			}
			return {
				stdout: okEnvelope({
					task: { id: "tsq-canceled", status: "canceled", title: "test" },
					blockers: [],
					dependents: [],
					blocker_edges: [],
					dependent_edges: [],
				}),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const result = await executeTaskTool(
			pi,
			{ action: "handoff_check" } as any,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			ready: true,
			projectRoot: "/repo",
			linkedWarnings: [
				{ todoId: 1, tsqId: "tsq-canceled", status: "canceled" },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("tsq-canceled"),
		});
	});
});
