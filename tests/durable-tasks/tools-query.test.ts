import { describe, expect, it } from "vitest";
import { registerTsqQueryTool } from "../../src/durable-tasks/tools-query.js";
import type { TsqTask } from "../../src/durable-tasks/types.js";
import { createMockPi } from "../support/pi-harness.js";

const ctx = { cwd: "/repo" } as never;
const signal = new AbortController().signal;

function task(overrides: Partial<TsqTask> = {}): TsqTask {
	return {
		id: "tsq-1",
		title: "Build query tool",
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

function okEnvelope(data: unknown): string {
	return JSON.stringify({
		schema_version: 1,
		command: "tsq",
		ok: true,
		data,
	});
}

function treeData(): unknown {
	return {
		tree: [
			{
				task: task({ id: "tsq-parent", title: "Parent task" }),
				children: [
					{
						task: task({ id: "tsq-child", title: "Child task" }),
						children: [],
						blocker_edges: [],
						dependent_edges: [],
						blockers: [],
						dependents: [],
					},
				],
				blocker_edges: [],
				dependent_edges: [],
				blockers: [],
				dependents: [],
			},
		],
	};
}

function registerQueryTool() {
	const { pi, captured } = createMockPi();
	captured.execHandler = () => ({
		stdout: okEnvelope({ tasks: [task()] }),
		stderr: "",
		code: 0,
		killed: false,
	});

	registerTsqQueryTool(pi);
	const tool = captured.tools.get("tsq_query");
	expect(tool).toBeDefined();
	return { pi, captured, tool: tool! };
}

describe("registerTsqQueryTool", () => {
	it("registers tsq_query with a strict StringEnum action schema", () => {
		const { captured } = registerQueryTool();
		const tool = captured.tools.get("tsq_query");

		expect(tool?.name).toBe("tsq_query");
		const parameters = tool?.parameters as { properties: { action: unknown } };
		expect(parameters.properties.action).toMatchObject({
			type: "string",
			enum: [
				"doctor",
				"find_ready",
				"find_open",
				"show",
				"show_with_spec",
				"deps",
				"notes",
				"find_tree",
				"similar",
			],
		});
	});

	it.each([
		[{ action: "doctor" }, ["doctor"]],
		[{ action: "find_ready" }, ["find", "ready"]],
		[
			{ action: "find_ready", lane: "coding", assignee: "worker" },
			["find", "ready", "--lane", "coding", "--assignee", "worker"],
		],
		[{ action: "find_open" }, ["find", "open"]],
		[
			{ action: "find_open", assignee: "worker", tree: true },
			["find", "open", "--assignee", "worker", "--tree"],
		],
		[{ action: "show", id: "tsq-1" }, ["show", "tsq-1"]],
		[
			{ action: "show_with_spec", id: "tsq-1" },
			["show", "tsq-1", "--with-spec"],
		],
		[{ action: "deps", id: "tsq-1" }, ["deps", "tsq-1"]],
		[
			{ action: "deps", id: "tsq-1", depth: 2 },
			["deps", "tsq-1", "--depth", "2"],
		],
		[{ action: "notes", id: "tsq-1" }, ["notes", "tsq-1"]],
		[{ action: "find_tree" }, ["find", "open", "--tree"]],
		[
			{ action: "similar", query: "pi tasque" },
			["find", "similar", "pi tasque"],
		],
	] as const)("maps %o to argv %o", async (params, expectedArgs) => {
		const { captured, tool } = registerQueryTool();

		await tool.execute("call-1", params, signal, undefined, ctx);

		expect(captured.execCalls).toHaveLength(1);
		expect(captured.execCalls[0]).toMatchObject({
			command: "tsq",
			args: [...expectedArgs, "--format", "json"],
			options: { cwd: "/repo", signal },
		});
	});

	it("fetches fresh Tasque data on every tool call", async () => {
		const { captured, tool } = registerQueryTool();

		await tool.execute(
			"call-1",
			{ action: "find_open" },
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"call-2",
			{ action: "find_open" },
			undefined,
			undefined,
			ctx,
		);

		expect(captured.execCalls).toHaveLength(2);
	});

	it.each([
		{ action: "show" },
		{ action: "show_with_spec" },
		{ action: "deps" },
		{ action: "notes" },
	] as const)("validates missing id before running tsq: %o", async (params) => {
		const { captured, tool } = registerQueryTool();

		await expect(
			tool.execute("call-1", params, undefined, undefined, ctx),
		).rejects.toThrow("requires id");
		expect(captured.execCalls).toEqual([]);
	});

	it("validates missing similar query before running tsq", async () => {
		const { captured, tool } = registerQueryTool();

		await expect(
			tool.execute("call-1", { action: "similar" }, undefined, undefined, ctx),
		).rejects.toThrow("requires query");
		expect(captured.execCalls).toEqual([]);
	});

	it.each([
		0, -1, 1.5,
	] as const)("validates invalid depth before running tsq: %s", async (depth) => {
		const { captured, tool } = registerQueryTool();

		await expect(
			tool.execute(
				"call-1",
				{ action: "deps", id: "tsq-1", depth },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("depth must be an integer >= 1");
		expect(captured.execCalls).toEqual([]);
	});

	it.each([
		"find_open",
		"find_ready",
	] as const)("formats non-empty tree data for %s tree mode", async (action) => {
		const { captured, tool } = registerQueryTool();
		captured.execHandler = () => ({
			stdout: okEnvelope(treeData()),
			stderr: "",
			code: 0,
			killed: false,
		});

		const result = await tool.execute(
			"call-1",
			{ action, tree: true },
			undefined,
			undefined,
			ctx,
		);

		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("2 tasks");
		expect(text).toContain("tsq-parent");
		expect(text).toContain("  tsq-child");
		expect(text).not.toContain("0 tasks");
		expect(captured.execCalls).toHaveLength(1);
	});

	it.each([
		"find_open",
		"find_ready",
	] as const)("formats tree-shaped data for %s even without tree param", async (action) => {
		const { captured, tool } = registerQueryTool();
		captured.execHandler = () => ({
			stdout: okEnvelope(treeData()),
			stderr: "",
			code: 0,
			killed: false,
		});

		const result = await tool.execute(
			"call-1",
			{ action },
			undefined,
			undefined,
			ctx,
		);

		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("2 tasks");
		expect(text).toContain("tsq-parent");
		expect(text).not.toContain("0 tasks");
	});

	it("returns concise content while preserving full structured data in details", async () => {
		const { captured, tool } = registerQueryTool();
		const data = {
			tasks: Array.from({ length: 20 }, (_, index) =>
				task({ id: `tsq-${index + 1}`, title: `Task ${index + 1}` }),
			),
		};
		captured.execHandler = () => ({
			stdout: okEnvelope(data),
			stderr: "",
			code: 0,
			killed: false,
		});

		const result = await tool.execute(
			"call-1",
			{ action: "find_open" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0]).toMatchObject({ type: "text" });
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("20 tasks");
		expect(text).toContain("showing first");
		expect(text.split("\n").length).toBeLessThanOrEqual(20);
		expect(result.details).toMatchObject({
			ok: true,
			action: "find_open",
			argv: ["find", "open"],
			data,
		});
	});
});
