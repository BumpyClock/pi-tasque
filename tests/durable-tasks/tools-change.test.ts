import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTsqChangeTool } from "../../src/durable-tasks/tools-change.js";
import { createMockPi } from "../support/pi-harness.js";

const ctx = (cwd = "/repo") => ({ cwd }) as ExtensionContext;

function firstText(result: {
	content: readonly { type: string; text?: string }[];
}): string {
	const first = result.content[0];
	if (first?.type !== "text" || first.text === undefined) {
		throw new Error("expected text content");
	}
	return first.text;
}

function okEnvelope(data: unknown) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq mutation",
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function withoutJsonFormat(args: readonly string[]): string[] {
	const output: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--format" && args[index + 1] === "json") {
			index += 1;
			continue;
		}
		if (arg !== undefined) {
			output.push(arg);
		}
	}
	return output;
}

function registerTool() {
	const { pi, captured } = createMockPi();
	registerTsqChangeTool(pi);
	const tool = captured.tools.get("tsq_change");
	if (!tool) {
		throw new Error("tsq_change was not registered");
	}
	captured.execHandler = () =>
		okEnvelope({ task: { id: "tsq-1", title: "Changed task" } });
	return { tool, captured };
}

describe("registerTsqChangeTool", () => {
	it("registers tsq_change with a strict StringEnum action schema", () => {
		const { tool } = registerTool();

		expect(tool.name).toBe("tsq_change");
		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"create",
						"note",
						"done",
						"reopen",
						"defer",
						"start",
						"claim_assign_only",
						"block",
						"unblock",
						"order",
						"unorder",
					],
				},
			},
			required: ["action"],
		});
	});

	it.each([
		[
			"create with planned metadata",
			{
				action: "create",
				title: "Build change tool",
				kind: "task",
				priority: 2,
				description: "Durable mutation support",
				parent: "tsq-parent",
				planned: true,
			},
			[
				"create",
				"--kind=task",
				"-p",
				"2",
				"--description=Durable mutation support",
				"--parent=tsq-parent",
				"--planned",
				"--format",
				"json",
				"--",
				"Build change tool",
			],
		],
		[
			"create with needs-plan metadata",
			{
				action: "create",
				title: "Plan later",
				kind: "feature",
				priority: 3,
				needsPlan: true,
			},
			[
				"create",
				"--kind=feature",
				"-p",
				"3",
				"--needs-plan",
				"--format",
				"json",
				"--",
				"Plan later",
			],
		],
		[
			"note",
			{ action: "note", id: "tsq-1", note: "New context" },
			["note", "tsq-1", "--format", "json", "--", "New context"],
		],
		[
			"done with note",
			{ action: "done", id: "tsq-1", note: "Verified" },
			["done", "tsq-1", "--note=Verified", "--format", "json"],
		],
		[
			"done without note",
			{ action: "done", id: "tsq-1" },
			["done", "tsq-1", "--format", "json"],
		],
		[
			"reopen",
			{ action: "reopen", id: "tsq-1" },
			["reopen", "tsq-1", "--format", "json"],
		],
		[
			"defer with note",
			{ action: "defer", id: "tsq-1", note: "Blocked on design" },
			["defer", "tsq-1", "--note=Blocked on design", "--format", "json"],
		],
		[
			"start",
			{ action: "start", id: "tsq-1" },
			["start", "tsq-1", "--format", "json"],
		],
		[
			"claim_assign_only",
			{ action: "claim_assign_only", id: "tsq-1", assignee: "worker" },
			["claim", "tsq-1", "--assignee=worker", "--format", "json"],
		],
		[
			"block",
			{ action: "block", child: "tsq-child", blocker: "tsq-blocker" },
			["block", "tsq-child", "by", "tsq-blocker", "--format", "json"],
		],
		[
			"unblock",
			{ action: "unblock", child: "tsq-child", blocker: "tsq-blocker" },
			["unblock", "tsq-child", "by", "tsq-blocker", "--format", "json"],
		],
		[
			"order",
			{ action: "order", later: "tsq-later", earlier: "tsq-earlier" },
			["order", "tsq-later", "after", "tsq-earlier", "--format", "json"],
		],
		[
			"unorder",
			{ action: "unorder", later: "tsq-later", earlier: "tsq-earlier" },
			["unorder", "tsq-later", "after", "tsq-earlier", "--format", "json"],
		],
	])("maps %s to exact tsq argv", async (_label, params, expectedArgs) => {
		const { tool, captured } = registerTool();

		const result = await tool.execute(
			"call-1",
			params,
			undefined,
			undefined,
			ctx(),
		);

		expect(result.details).toMatchObject({
			ok: true,
			data: {
				action: params.action,
				argv: withoutJsonFormat(expectedArgs),
				result: { task: { id: "tsq-1", title: "Changed task" } },
			},
		});
		expect(captured.execCalls).toEqual([
			{
				command: "tsq",
				args: expectedArgs,
				options: { cwd: "/repo" },
			},
		]);
	});

	it.each([
		[
			"block",
			{ action: "block", child: "tsq-child", blocker: "tsq-blocker" },
			"Added block edge: tsq-child blocked by tsq-blocker",
		],
		[
			"unblock",
			{ action: "unblock", child: "tsq-child", blocker: "tsq-blocker" },
			"Removed block edge: tsq-child no longer blocked by tsq-blocker",
		],
		[
			"order",
			{ action: "order", later: "tsq-later", earlier: "tsq-earlier" },
			"Added order edge: tsq-later after tsq-earlier",
		],
		[
			"unorder",
			{ action: "unorder", later: "tsq-later", earlier: "tsq-earlier" },
			"Removed order edge: tsq-later no longer ordered after tsq-earlier",
		],
	])("formats %s success text", async (_label, params, expectedText) => {
		const { tool } = registerTool();

		const result = await tool.execute(
			"call-1",
			params,
			undefined,
			undefined,
			ctx(),
		);

		expect(firstText(result)).toBe(expectedText);
	});

	it.each([
		[
			"create title and description",
			{
				action: "create",
				title: "-Leading title",
				kind: "task",
				priority: 2,
				description: "-Leading description",
			},
			[
				"create",
				"--kind=task",
				"-p",
				"2",
				"--description=-Leading description",
				"--format",
				"json",
				"--",
				"-Leading title",
			],
		],
		[
			"note text",
			{ action: "note", id: "tsq-1", note: "-Leading note" },
			["note", "tsq-1", "--format", "json", "--", "-Leading note"],
		],
		[
			"done note",
			{ action: "done", id: "tsq-1", note: "-Leading done note" },
			["done", "tsq-1", "--note=-Leading done note", "--format", "json"],
		],
		[
			"defer note",
			{ action: "defer", id: "tsq-1", note: "-Leading defer note" },
			["defer", "tsq-1", "--note=-Leading defer note", "--format", "json"],
		],
	])("treats dash-leading %s as user text", async (_label, params, expectedArgs) => {
		const { tool, captured } = registerTool();

		await tool.execute("call-1", params, undefined, undefined, ctx());

		expect(captured.execCalls).toEqual([
			{
				command: "tsq",
				args: expectedArgs,
				options: { cwd: "/repo" },
			},
		]);
	});

	it.each([
		["create missing title", { action: "create", kind: "task", priority: 2 }],
		["create missing kind", { action: "create", title: "Task", priority: 2 }],
		[
			"create missing priority",
			{ action: "create", title: "Task", kind: "task" },
		],
		[
			"create conflicting planning flags",
			{
				action: "create",
				title: "Task",
				kind: "task",
				priority: 2,
				planned: true,
				needsPlan: true,
			},
		],
		["note missing id", { action: "note", note: "Context" }],
		["note missing note", { action: "note", id: "tsq-1" }],
		["done missing id", { action: "done" }],
		["reopen missing id", { action: "reopen" }],
		["defer missing id", { action: "defer" }],
		["start missing id", { action: "start" }],
		[
			"claim_assign_only missing assignee",
			{ action: "claim_assign_only", id: "tsq-1" },
		],
		["block missing child", { action: "block", blocker: "tsq-blocker" }],
		["block missing blocker", { action: "block", child: "tsq-child" }],
		[
			"block self-edge",
			{ action: "block", child: "tsq-same", blocker: "tsq-same" },
		],
		["unblock missing child", { action: "unblock", blocker: "tsq-blocker" }],
		["unblock missing blocker", { action: "unblock", child: "tsq-child" }],
		[
			"unblock self-edge",
			{ action: "unblock", child: "tsq-same", blocker: "tsq-same" },
		],
		["order missing later", { action: "order", earlier: "tsq-earlier" }],
		["order missing earlier", { action: "order", later: "tsq-later" }],
		[
			"order self-edge",
			{ action: "order", later: "tsq-same", earlier: "tsq-same" },
		],
		["unorder missing later", { action: "unorder", earlier: "tsq-earlier" }],
		["unorder missing earlier", { action: "unorder", later: "tsq-later" }],
		[
			"unorder self-edge",
			{ action: "unorder", later: "tsq-same", earlier: "tsq-same" },
		],
		[
			"raw passthrough is not accepted",
			{ action: "raw", argv: ["done", "tsq-1"] },
		],
	])("validates %s before running tsq", async (_label, params) => {
		const { tool, captured } = registerTool();

		const result = await tool.execute(
			"call-1",
			params,
			undefined,
			undefined,
			ctx(),
		);

		expect(firstText(result)).toMatch(/^Error: /u);
		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("serializes mutations per cwd through the mutation queue", async () => {
		const { tool, captured } = registerTool();
		const startedArgs: string[][] = [];
		let releaseFirst: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			captured.execHandler = async (_command, args) => {
				startedArgs.push(args.slice(0, -2));
				if (startedArgs.length === 1) {
					resolve();
					await new Promise<void>((release) => {
						releaseFirst = release;
					});
				}
				return okEnvelope({ task: { id: args[1] ?? "tsq-1" } });
			};
		});

		const first = tool.execute(
			"call-1",
			{ action: "start", id: "tsq-1" },
			undefined,
			undefined,
			ctx(),
		);
		await firstStarted;

		const second = tool.execute(
			"call-2",
			{ action: "done", id: "tsq-2" },
			undefined,
			undefined,
			ctx(),
		);
		await Promise.resolve();

		expect(startedArgs).toEqual([["start", "tsq-1"]]);
		releaseFirst?.();
		await Promise.all([first, second]);

		expect(startedArgs).toEqual([
			["start", "tsq-1"],
			["done", "tsq-2"],
		]);
	});
});
