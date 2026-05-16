import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import piTasqueExtension from "../../src/index.js";
import { __resetState } from "../../src/session-todos/state/store.js";
import { createMockPi } from "../support/pi-harness.js";

const ctx = { cwd: "/repo" } as ExtensionContext;

describe("pi-tasque extension registration", () => {
	beforeEach(() => {
		__resetState();
	});

	it("exports a loadable default Pi extension factory", () => {
		expect(typeof piTasqueExtension).toBe("function");

		const { pi } = createMockPi();

		expect(() => piTasqueExtension(pi)).not.toThrow();
	});

	it("registers the completed pi-tasque tools, commands, and lifecycle handlers", () => {
		const { pi, captured } = createMockPi();

		piTasqueExtension(pi);

		const toolNames = Array.from(captured.tools.keys()).sort();
		expect(new Set(toolNames).size).toBe(toolNames.length);
		expect(toolNames).toEqual(["task", "todo"]);
		const commandNames = Array.from(captured.commands.keys());
		expect(new Set(commandNames).size).toBe(commandNames.length);
		expect(commandNames).toEqual(["todos"]);
		expect(
			captured.handlers.get("session_start")?.length,
		).toBeGreaterThanOrEqual(1);
		expect(captured.handlers.get("session_compact")?.length).toBe(1);
		expect(captured.handlers.get("session_tree")?.length).toBe(1);
		expect(captured.handlers.get("turn_start")?.length).toBe(1);
		expect(
			captured.handlers.get("tool_execution_end")?.length,
		).toBeGreaterThanOrEqual(1);
		expect(
			captured.handlers.get("session_shutdown")?.length,
		).toBeGreaterThanOrEqual(1);
	});

	it("wires task promote/import handlers in the installed extension", async () => {
		const { pi, captured } = createMockPi();

		piTasqueExtension(pi);

		const tool = captured.tools.get("task");
		if (tool === undefined) throw new Error("task was not registered");

		const promoteResult = await tool.execute(
			"call-1",
			{ action: "promote" },
			undefined,
			undefined,
			ctx,
		);
		expect(promoteResult.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "todo is required" },
		});
		expect(promoteResult.details).not.toMatchObject({
			error: { code: "not_implemented" },
		});

		const importResult = await tool.execute(
			"call-2",
			{ action: "import" },
			undefined,
			undefined,
			ctx,
		);
		expect(importResult.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "task is required" },
		});
		expect(importResult.details).not.toMatchObject({
			error: { code: "not_implemented" },
		});
	});
});
