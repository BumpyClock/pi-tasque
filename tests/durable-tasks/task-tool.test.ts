import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	executeTaskTool,
	registerTaskTool,
} from "../../src/durable-tasks/task-tool.js";
import { __resetState } from "../../src/session-todos/state/store.js";
import { createMockPi } from "../support/pi-harness.js";

const ctx = { cwd: "/repo/packages/app" } as ExtensionContext;

function okEnvelope(data: unknown) {
	return JSON.stringify({
		schema_version: 1,
		command: "tsq",
		ok: true,
		data,
	});
}

function makePi() {
	const { pi, captured } = createMockPi();
	captured.execHandler = (command, _args) => {
		if (command === "git") {
			return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
		}
		return {
			stdout: okEnvelope({ tasks: [] }),
			stderr: "",
			code: 0,
			killed: false,
		};
	};
	return { pi, captured };
}

beforeEach(() => {
	__resetState();
});

describe("task tool", () => {
	it("registers one durable task tool with concise guidance", () => {
		const { pi, captured } = makePi();

		registerTaskTool(pi);

		const tool = captured.tools.get("task");
		expect(tool).toBeDefined();
		expect(tool?.promptSnippet).toContain("Durable project tasks");
		expect(tool?.promptGuidelines).toEqual([
			"Use `task` for durable project work that should survive compaction and session restarts; use `todo` for current-session checklist steps.",
		]);
		expect(JSON.stringify(tool?.parameters)).toContain("finish");
		expect(JSON.stringify(tool?.parameters)).not.toContain("tsq_query");
	});

	it("resolves git root before running Tasque queries", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "find", tasks: "ready", lane: "coding", for: "developer" },
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ ok: true, projectRoot: "/repo" });
		expect(captured.execCalls).toEqual([
			{
				command: "git",
				args: ["rev-parse", "--show-toplevel"],
				options: { cwd: "/repo/packages/app", timeout: 5000 },
			},
			{
				command: "tsq",
				args: [
					"find",
					"ready",
					"--lane",
					"coding",
					"--assignee",
					"developer",
					"--format",
					"json",
				],
				options: { cwd: "/repo", timeout: 10000 },
			},
		]);
	});

	it("allows open-tree lookup without a redundant tasks field", async () => {
		const { pi, captured } = makePi();

		await executeTaskTool(
			pi,
			{ action: "find", view: "tree", task: "tsq-parent" },
			undefined,
			ctx,
		);

		expect(captured.execCalls.at(-1)).toMatchObject({
			command: "tsq",
			args: ["find", "open", "--tree", "--format", "json"],
			options: { cwd: "/repo", timeout: 10000 },
		});
	});

	it("maps sentence-like lifecycle fields to Tasque mutations", async () => {
		const { pi, captured } = makePi();
		captured.execHandler = (command, args) => {
			if (command === "git") {
				return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
			}
			return {
				stdout: okEnvelope({ task: { id: args[1] ?? "tsq-1", title: "Done" } }),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const result = await executeTaskTool(
			pi,
			{ action: "finish", task: "tsq-1", because: "Verified" },
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: true,
			projectRoot: "/repo",
			data: {
				action: "done",
				argv: ["done", "tsq-1", "--note=Verified"],
			},
		});
		expect(captured.execCalls.at(-1)).toMatchObject({
			command: "tsq",
			args: ["done", "tsq-1", "--note=Verified", "--format", "json"],
			options: { cwd: "/repo" },
		});
	});

	it("validates bridge-only actions before resolving a project root", async () => {
		const { pi, captured } = makePi();

		const result = await executeTaskTool(
			pi,
			{ action: "link", task: "tsq-1" },
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "todo is required" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("returns a project-root error before running Tasque outside git repos", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: "",
			stderr: "fatal: not a git repository",
			code: 128,
			killed: false,
		});

		const result = await executeTaskTool(
			pi,
			{ action: "doctor" },
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "project_root_error" },
		});
		expect(captured.execCalls).toHaveLength(1);
		expect(captured.execCalls[0]?.command).toBe("git");
	});
});
