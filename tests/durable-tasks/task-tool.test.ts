import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	executeTaskTool,
	registerTaskTool,
} from "../../src/durable-tasks/task-tool.js";
import {
	__resetState,
	commitState,
} from "../../src/session-todos/state/store.js";
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
		const schemaText = JSON.stringify(tool?.parameters);
		expect(schemaText).toContain("finish");
		expect(schemaText).toContain("Bulk item action");
		expect(schemaText).toContain("mark_planned");
		expect(schemaText).toContain("Durable task id for this bulk item");
		expect(schemaText).toContain("Durable task title for this node");
		expect(schemaText).toContain("Nested child task nodes");
		expect(schemaText).not.toContain("tsq_query");
		expect(schemaText).not.toContain("raw CLI");
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

	describe("mark_planned action", () => {
		it("requires task field", async () => {
			const { pi, captured } = makePi();

			const result = await executeTaskTool(
				pi,
				{ action: "mark_planned" } as any,
				undefined,
				ctx,
			);

			expect(result.details).toMatchObject({
				ok: false,
				error: { code: "validation_error", message: "task is required" },
			});
			expect(captured.execCalls).toEqual([]);
		});

		it("dispatches mark_planned to executeTsqMarkPlanned with project root", async () => {
			const { pi, captured } = makePi();
			captured.execHandler = (command) => {
				if (command === "git") {
					return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
				}
				return {
					stdout: okEnvelope({
						task: { id: "tsq-5", planning_state: "planned" },
					}),
					stderr: "",
					code: 0,
					killed: false,
				};
			};

			const result = await executeTaskTool(
				pi,
				{ action: "mark_planned", task: "tsq-5" } as any,
				undefined,
				ctx,
			);

			expect(result.details).toMatchObject({
				ok: true,
				projectRoot: "/repo",
			});
			expect(captured.execCalls.at(-1)).toMatchObject({
				command: "tsq",
				args: ["planned", "tsq-5", "--format", "json"],
				options: { cwd: "/repo" },
			});
		});
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
});
