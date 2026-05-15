import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { registerTsqClaimTool } from "../../src/durable-tasks/tools-claim.js";
import { applyTaskMutation } from "../../src/session-todos/state/state-reducer.js";
import {
	__resetState,
	commitState,
	getState,
	getTodos,
} from "../../src/session-todos/state/store.js";
import type { TsqTask } from "../../src/durable-tasks/types.js";
import { createMockPi } from "../support/pi-harness.js";

const signal = new AbortController().signal;
const ctx = (cwd = "/repo") => ({ cwd }) as ExtensionContext;

function task(overrides: Partial<TsqTask> = {}): TsqTask {
	return {
		id: "tsq-1",
		title: "Claimable task",
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

function okEnvelope(data: unknown) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq",
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
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

function registerTool() {
	const { pi, captured } = createMockPi();
	registerTsqClaimTool(pi);
	const tool = captured.tools.get("tsq_claim");
	if (!tool) {
		throw new Error("tsq_claim was not registered");
	}
	captured.execHandler = (_command, args) => {
		if (args[0] === "show") {
			return okEnvelope({ task: task({ id: args[1] ?? "tsq-1" }) });
		}
		return okEnvelope({ task: task({ id: args[1] ?? "tsq-1" }) });
	};
	return { tool, captured };
}

describe("registerTsqClaimTool", () => {
	beforeEach(() => {
		__resetState();
	});

	it("registers tsq_claim with required named id and no next-ready action", () => {
		const { tool } = registerTool();

		expect(tool.name).toBe("tsq_claim");
		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				id: { type: "string" },
				assignee: { type: "string" },
				start: { type: "boolean" },
				requireSpec: { type: "boolean" },
				createTodo: { type: "boolean" },
			},
			required: ["id"],
		});
		expect(JSON.stringify(tool.parameters)).not.toContain("next_ready");
	});

	it("defaults assignee to pi and start to true", async () => {
		const { tool, captured } = registerTool();

		const result = await tool.execute(
			"call-1",
			{ id: "tsq-1" },
			signal,
			undefined,
			ctx(),
		);

		expect(result.details).toMatchObject({
			ok: true,
			data: {
				id: "tsq-1",
				assignee: "pi",
				start: true,
				argv: ["claim", "tsq-1", "--assignee=pi", "--start"],
			},
		});
		expect(captured.execCalls).toEqual([
			{
				command: "tsq",
				args: [
					"claim",
					"tsq-1",
					"--assignee=pi",
					"--start",
					"--format",
					"json",
				],
				options: { cwd: "/repo", signal },
			},
		]);
	});

	it("uses explicit assignee", async () => {
		const { tool, captured } = registerTool();

		await tool.execute(
			"call-1",
			{ id: "tsq-1", assignee: "developer" },
			undefined,
			undefined,
			ctx(),
		);

		expect(captured.execCalls[0]?.args).toEqual([
			"claim",
			"tsq-1",
			"--assignee=developer",
			"--start",
			"--format",
			"json",
		]);
	});

	it("keeps dash-prefixed assignee in one valued flag token", async () => {
		const { tool, captured } = registerTool();

		const result = await tool.execute(
			"call-1",
			{ id: "tsq-1", assignee: "-worker" },
			undefined,
			undefined,
			ctx(),
		);

		expect(result.details).toMatchObject({
			ok: true,
			data: {
				assignee: "-worker",
				argv: ["claim", "tsq-1", "--assignee=-worker", "--start"],
			},
		});
		expect(captured.execCalls[0]?.args).toEqual([
			"claim",
			"tsq-1",
			"--assignee=-worker",
			"--start",
			"--format",
			"json",
		]);
		expect(captured.execCalls[0]?.args).not.toContain("--assignee");
		expect(captured.execCalls[0]?.args).not.toContain("-worker");
	});

	it("keeps format-like assignee in one valued flag token", async () => {
		const { tool, captured } = registerTool();

		const result = await tool.execute(
			"call-1",
			{ id: "tsq-1", assignee: "--format" },
			undefined,
			undefined,
			ctx(),
		);

		expect(result.details).toMatchObject({
			ok: true,
			data: {
				assignee: "--format",
				argv: ["claim", "tsq-1", "--assignee=--format", "--start"],
			},
		});
		expect(captured.execCalls[0]?.args).toEqual([
			"claim",
			"tsq-1",
			"--assignee=--format",
			"--start",
			"--format",
			"json",
		]);
		expect(captured.execCalls[0]?.args).not.toContain("--assignee");
		expect(
			captured.execCalls[0]?.args.filter((arg) => arg === "--format"),
		).toHaveLength(1);
	});

	it("omits start when start is false", async () => {
		const { tool, captured } = registerTool();

		await tool.execute(
			"call-1",
			{ id: "tsq-1", start: false },
			undefined,
			undefined,
			ctx(),
		);

		expect(captured.execCalls[0]?.args).toEqual([
			"claim",
			"tsq-1",
			"--assignee=pi",
			"--format",
			"json",
		]);
	});

	it("adds requireSpec flag", async () => {
		const { tool, captured } = registerTool();

		await tool.execute(
			"call-1",
			{ id: "tsq-1", requireSpec: true },
			undefined,
			undefined,
			ctx(),
		);

		expect(captured.execCalls[0]?.args).toEqual([
			"claim",
			"tsq-1",
			"--assignee=pi",
			"--start",
			"--require-spec",
			"--format",
			"json",
		]);
	});

	it("validates missing id before running tsq", async () => {
		const { tool, captured } = registerTool();

		const result = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			ctx(),
		);

		expect(firstText(result)).toBe("Error: id is required");
		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "id is required" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("createTodo fetches task details after claim and creates one linked session todo", async () => {
		const { tool, captured } = registerTool();
		captured.execHandler = (_command, args) => {
			if (args[0] === "show") {
				return okEnvelope({
					task: task({ id: "tsq-1", title: "Implement claim flow" }),
				});
			}
			return okEnvelope({ task: task({ id: "tsq-1" }) });
		};

		const result = await tool.execute(
			"call-1",
			{ id: "tsq-1", createTodo: true },
			undefined,
			undefined,
			ctx(),
		);

		expect(captured.execCalls.map((call) => call.args)).toEqual([
			["claim", "tsq-1", "--assignee=pi", "--start", "--format", "json"],
			["show", "tsq-1", "--format", "json"],
		]);
		expect(getTodos()).toEqual([
			{
				id: 1,
				subject: "Work on tsq-1: Implement claim flow",
				status: "pending",
				metadata: { tsqId: "tsq-1" },
			},
		]);
		expect(result.details).toMatchObject({
			ok: true,
			data: {
				createTodo: true,
				claimResult: { task: { id: "tsq-1" } },
				todo: {
					id: 1,
					subject: "Work on tsq-1: Implement claim flow",
					metadata: { tsqId: "tsq-1" },
				},
			},
		});
		expect(firstText(result)).toContain("Created todo #1");
	});

	it("reports claim success with a warning when linked todo creation fails", async () => {
		const { tool, captured } = registerTool();
		captured.execHandler = (_command, args) => {
			if (args[0] === "show") {
				return okEnvelope({ task: { id: "tsq-1" } });
			}
			return okEnvelope({ claimed: true, id: "tsq-1" });
		};

		const result = await tool.execute(
			"call-1",
			{ id: "tsq-1", createTodo: true },
			undefined,
			undefined,
			ctx(),
		);

		expect(captured.execCalls.map((call) => call.args)).toEqual([
			["claim", "tsq-1", "--assignee=pi", "--start", "--format", "json"],
			["show", "tsq-1", "--format", "json"],
		]);
		expect(getTodos()).toEqual([]);
		expect(result.details).toMatchObject({
			ok: true,
			warnings: [
				"Linked todo creation failed: tsq show tsq-1 did not return task title",
			],
			data: {
				id: "tsq-1",
				createTodo: true,
				claimResult: { claimed: true, id: "tsq-1" },
				todoError: {
					code: "tsq_error",
					message: "tsq show tsq-1 did not return task title",
				},
			},
		});
		expect(firstText(result)).toContain("Claimed tsq-1 as pi and started");
		expect(firstText(result)).toContain(
			"Linked todo creation failed: tsq show tsq-1 did not return task title",
		);
	});

	it("completing a linked todo does not mark Tasque done", async () => {
		const { tool, captured } = registerTool();

		await tool.execute(
			"call-1",
			{ id: "tsq-1", createTodo: true },
			undefined,
			undefined,
			ctx(),
		);
		const started = applyTaskMutation(getState(), "update", {
			id: 1,
			status: "in_progress",
		});
		commitState(started.state);
		const completed = applyTaskMutation(getState(), "update", {
			id: 1,
			status: "completed",
		});
		commitState(completed.state);

		expect(getTodos()[0]?.status).toBe("completed");
		expect(captured.execCalls.map((call) => call.args[0])).toEqual([
			"claim",
			"show",
		]);
		expect(captured.execCalls.some((call) => call.args[0] === "done")).toBe(
			false,
		);
	});
});
