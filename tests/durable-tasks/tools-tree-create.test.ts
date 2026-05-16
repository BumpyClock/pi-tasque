import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CreateTreeNode } from "../../src/durable-tasks/bulk-contract.js";
import { executeCreateTree } from "../../src/durable-tasks/tools-tree-create.js";
import { createMockPi } from "../support/pi-harness.js";

const ctx = (cwd = "/repo") => ({ cwd }) as ExtensionContext;

function okEnvelope(data: unknown) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq create",
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function errEnvelope(code: string, message: string) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq create",
			ok: false,
			error: { code, message },
		}),
		stderr: "",
		code: 1,
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

function withoutJsonFormat(args: readonly string[]): string[] {
	const output: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--format" && args[i + 1] === "json") {
			i += 1;
			continue;
		}
		if (arg !== undefined) {
			output.push(arg);
		}
	}
	return output;
}

describe("executeCreateTree", () => {
	describe("single root node (no children)", () => {
		it("creates root and reports it as created", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				okEnvelope({ task: { id: "tsq-10", title: "Root Task" } });

			const root: CreateTreeNode = {
				title: "Root Task",
				kind: "task",
				priority: 2,
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());

			expect(result.details).toMatchObject({
				ok: true,
				data: {
					created: [{ id: "tsq-10", title: "Root Task" }],
					skipped: [],
				},
			});
			expect(result.details).not.toHaveProperty("data.failed");

			// Verify tsq create was called once
			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			expect(tsqCalls).toHaveLength(1);
			expect(withoutJsonFormat(tsqCalls[0]!.args)).toEqual([
				"create",
				"--kind=task",
				"-p",
				"2",
				"--",
				"Root Task",
			]);
		});

		it("passes description and planned flags", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				okEnvelope({ task: { id: "tsq-11", title: "Planned Root" } });

			const root: CreateTreeNode = {
				title: "Planned Root",
				kind: "feature",
				priority: 1,
				description: "A feature root",
				planned: true,
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());

			expect(result.details).toMatchObject({
				ok: true,
				data: {
					created: [{ id: "tsq-11", title: "Planned Root" }],
				},
			});

			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			expect(withoutJsonFormat(tsqCalls[0]!.args)).toEqual([
				"create",
				"--kind=feature",
				"-p",
				"1",
				"--description=A feature root",
				"--planned",
				"--",
				"Planned Root",
			]);
		});

		it("passes needsPlan flag", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				okEnvelope({ task: { id: "tsq-12", title: "Needs Plan" } });

			const root: CreateTreeNode = {
				title: "Needs Plan",
				kind: "task",
				priority: 3,
				needsPlan: true,
			};

			await executeCreateTree(pi, root, undefined, ctx());

			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			expect(withoutJsonFormat(tsqCalls[0]!.args)).toContain("--needs-plan");
		});
	});

	describe("root with children", () => {
		it("creates root first, then children with --parent", async () => {
			const { pi, captured } = createMockPi();
			let callIndex = 0;
			captured.execHandler = () => {
				callIndex++;
				switch (callIndex) {
					case 1:
						return okEnvelope({
							task: { id: "tsq-20", title: "Parent" },
						});
					case 2:
						return okEnvelope({
							task: { id: "tsq-20.1", title: "Child A" },
						});
					case 3:
						return okEnvelope({
							task: { id: "tsq-20.2", title: "Child B" },
						});
					default:
						throw new Error("unexpected call");
				}
			};

			const root: CreateTreeNode = {
				title: "Parent",
				kind: "task",
				priority: 2,
				children: [
					{ title: "Child A", kind: "task", priority: 2 },
					{ title: "Child B", kind: "task", priority: 3 },
				],
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());

			expect(result.details).toMatchObject({
				ok: true,
				data: {
					created: [
						{ id: "tsq-20", title: "Parent" },
						{ id: "tsq-20.1", title: "Child A" },
						{ id: "tsq-20.2", title: "Child B" },
					],
					skipped: [],
				},
			});

			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			expect(tsqCalls).toHaveLength(3);

			// Root has no --parent
			const rootArgs = withoutJsonFormat(tsqCalls[0]!.args);
			expect(rootArgs).not.toContain(
				expect.stringContaining("--parent"),
			);

			// Children have --parent=tsq-20
			const childAArgs = withoutJsonFormat(tsqCalls[1]!.args);
			expect(childAArgs).toContain("--parent=tsq-20");

			const childBArgs = withoutJsonFormat(tsqCalls[2]!.args);
			expect(childBArgs).toContain("--parent=tsq-20");
		});

		it("creates deeply nested tree (grandchildren)", async () => {
			const { pi, captured } = createMockPi();
			let callIndex = 0;
			captured.execHandler = () => {
				callIndex++;
				switch (callIndex) {
					case 1:
						return okEnvelope({
							task: { id: "tsq-30", title: "Root" },
						});
					case 2:
						return okEnvelope({
							task: { id: "tsq-30.1", title: "Child" },
						});
					case 3:
						return okEnvelope({
							task: { id: "tsq-30.1.1", title: "Grandchild" },
						});
					default:
						throw new Error("unexpected call");
				}
			};

			const root: CreateTreeNode = {
				title: "Root",
				kind: "task",
				priority: 1,
				children: [
					{
						title: "Child",
						kind: "task",
						priority: 2,
						children: [
							{ title: "Grandchild", kind: "task", priority: 3 },
						],
					},
				],
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());

			expect(result.details).toMatchObject({
				ok: true,
				data: {
					created: [
						{ id: "tsq-30", title: "Root" },
						{ id: "tsq-30.1", title: "Child" },
						{ id: "tsq-30.1.1", title: "Grandchild" },
					],
					skipped: [],
				},
			});

			// Grandchild has --parent=tsq-30.1
			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			const grandchildArgs = withoutJsonFormat(tsqCalls[2]!.args);
			expect(grandchildArgs).toContain("--parent=tsq-30.1");
		});
	});

	describe("partial failure", () => {
		it("skips children when root creation fails", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				errEnvelope("create_failed", "duplicate title");

			const root: CreateTreeNode = {
				title: "Bad Root",
				kind: "task",
				priority: 2,
				children: [
					{ title: "Child A", kind: "task", priority: 2 },
					{ title: "Child B", kind: "task", priority: 3 },
				],
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());

			expect(result.details).toMatchObject({
				ok: true,
				data: {
					created: [],
					failed: {
						title: "Bad Root",
						error: expect.stringContaining("duplicate title"),
					},
					skipped: [{ title: "Child A" }, { title: "Child B" }],
				},
			});

			// Only one tsq call (the failed root)
			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			expect(tsqCalls).toHaveLength(1);
		});

		it("skips remaining siblings when a child fails", async () => {
			const { pi, captured } = createMockPi();
			let callIndex = 0;
			captured.execHandler = () => {
				callIndex++;
				switch (callIndex) {
					case 1:
						return okEnvelope({
							task: { id: "tsq-40", title: "Parent" },
						});
					case 2:
						return errEnvelope("create_failed", "bad child");
					default:
						throw new Error("should not be called");
				}
			};

			const root: CreateTreeNode = {
				title: "Parent",
				kind: "task",
				priority: 2,
				children: [
					{ title: "Bad Child", kind: "task", priority: 2 },
					{ title: "Good Child", kind: "task", priority: 3 },
				],
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());

			expect(result.details).toMatchObject({
				ok: true,
				data: {
					created: [{ id: "tsq-40", title: "Parent" }],
					failed: {
						title: "Bad Child",
						error: expect.stringContaining("bad child"),
					},
					skipped: [{ title: "Good Child" }],
				},
			});
		});

		it("skips subtree when intermediate node fails", async () => {
			const { pi, captured } = createMockPi();
			let callIndex = 0;
			captured.execHandler = () => {
				callIndex++;
				switch (callIndex) {
					case 1:
						return okEnvelope({
							task: { id: "tsq-50", title: "Root" },
						});
					case 2:
						return errEnvelope("create_failed", "intermediate fail");
					default:
						throw new Error("should not be called");
				}
			};

			const root: CreateTreeNode = {
				title: "Root",
				kind: "task",
				priority: 1,
				children: [
					{
						title: "Failing Child",
						kind: "task",
						priority: 2,
						children: [
							{ title: "Grandchild A", kind: "task", priority: 3 },
						],
					},
				],
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());

			expect(result.details).toMatchObject({
				ok: true,
				data: {
					created: [{ id: "tsq-50", title: "Root" }],
					failed: {
						title: "Failing Child",
						error: expect.stringContaining("intermediate fail"),
					},
					skipped: [{ title: "Grandchild A" }],
				},
			});
		});
	});

	describe("text output", () => {
		it("reports created count for success", async () => {
			const { pi } = createMockPi();
			pi.exec = async () =>
				okEnvelope({ task: { id: "tsq-60", title: "Solo" } });

			const root: CreateTreeNode = {
				title: "Solo",
				kind: "task",
				priority: 2,
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());
			const text = firstText(result);

			expect(text).toContain("Created 1 task");
			expect(text).toContain("tsq-60");
		});

		it("reports failure and skipped in text", async () => {
			const { pi } = createMockPi();
			pi.exec = async () =>
				errEnvelope("create_failed", "boom");

			const root: CreateTreeNode = {
				title: "Root",
				kind: "task",
				priority: 2,
				children: [{ title: "Child", kind: "task", priority: 2 }],
			};

			const result = await executeCreateTree(pi, root, undefined, ctx());
			const text = firstText(result);

			expect(text).toContain("Failed");
			expect(text).toContain("Root");
			expect(text).toContain("1 skipped");
		});
	});

	describe("mutation queue", () => {
		it("uses cwd from context for all mutations", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				okEnvelope({ task: { id: "tsq-70", title: "Task" } });

			const root: CreateTreeNode = {
				title: "Task",
				kind: "task",
				priority: 2,
			};

			await executeCreateTree(pi, root, undefined, ctx("/my-project"));

			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			expect(tsqCalls[0]!.options).toMatchObject({ cwd: "/my-project" });
		});
	});
});
