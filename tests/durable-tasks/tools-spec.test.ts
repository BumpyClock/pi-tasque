import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildSpecArgv,
	executeTsqSpec,
	validateSpecParams,
	type SpecMode,
	type SpecParams,
} from "../../src/durable-tasks/tools-spec.js";
import { createMockPi } from "../support/pi-harness.js";

const ctx = (cwd = "/repo") => ({ cwd }) as Pick<ExtensionContext, "cwd">;

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
			command: "tsq spec",
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function setup() {
	const { pi, captured } = createMockPi();
	captured.execHandler = () => okEnvelope({ path: "specs/tsq-1/spec.md" });
	return { pi, captured };
}

describe("buildSpecArgv", () => {
	it.each([
		["show", "tsq-1", "show", undefined, ["spec", "tsq-1", "--show"]],
		["check", "tsq-2", "check", undefined, ["spec", "tsq-2", "--check"]],
		[
			"set",
			"tsq-3",
			"set",
			"# My spec",
			["spec", "tsq-3", "--force", "--text=# My spec"],
		],
		[
			"update",
			"tsq-4",
			"update",
			"Updated content",
			["spec", "tsq-4", "--update", "--text=Updated content"],
		],
	])("builds correct argv for %s mode", (_label, id, mode, text, expected) => {
		const result = buildSpecArgv(id, mode as SpecMode, text);
		expect(result).toEqual(expected);
	});

	it("handles leading-dash text safely via --text= form", () => {
		const result = buildSpecArgv(
			"tsq-5",
			"set",
			"---\ntitle: spec\n---\n# Content",
		);
		expect(result).toEqual([
			"spec",
			"tsq-5",
			"--force",
			"--text=---\ntitle: spec\n---\n# Content",
		]);
	});

	it("handles text starting with double dash", () => {
		const result = buildSpecArgv("tsq-6", "update", "--heading content");
		expect(result).toEqual([
			"spec",
			"tsq-6",
			"--update",
			"--text=--heading content",
		]);
	});
});

describe("validateSpecParams", () => {
	it("fails when id is missing", () => {
		const result = validateSpecParams({ id: undefined, mode: "show" });
		expect(result).toEqual({ ok: false, message: "spec action requires id" });
	});

	it("fails when id is empty string", () => {
		const result = validateSpecParams({ id: "  ", mode: "show" });
		expect(result).toEqual({ ok: false, message: "spec action requires id" });
	});

	it("fails when text provided with show mode", () => {
		const result = validateSpecParams({
			id: "tsq-1",
			mode: "show",
			text: "some text",
		});
		expect(result).toEqual({
			ok: false,
			message: "spec show does not accept text",
		});
	});

	it("fails when text provided with check mode", () => {
		const result = validateSpecParams({
			id: "tsq-1",
			mode: "check",
			text: "some text",
		});
		expect(result).toEqual({
			ok: false,
			message: "spec check does not accept text",
		});
	});

	it("fails when text missing for set mode", () => {
		const result = validateSpecParams({ id: "tsq-1", mode: "set" });
		expect(result).toEqual({ ok: false, message: "spec set requires text" });
	});

	it("fails when text is blank for update mode", () => {
		const result = validateSpecParams({
			id: "tsq-1",
			mode: "update",
			text: "   ",
		});
		expect(result).toEqual({
			ok: false,
			message: "spec update requires text",
		});
	});

	it("rejects empty/whitespace text for read modes", () => {
		const showResult = validateSpecParams({
			id: "tsq-1",
			mode: "show",
			text: "  ",
		});
		expect(showResult).toEqual({
			ok: false,
			message: "spec show does not accept text",
		});

		const checkResult = validateSpecParams({
			id: "tsq-1",
			mode: "check",
			text: "",
		});
		expect(checkResult).toEqual({
			ok: false,
			message: "spec check does not accept text",
		});
	});

	it("succeeds for valid show params", () => {
		const result = validateSpecParams({ id: "tsq-1", mode: "show" });
		expect(result).toEqual({
			ok: true,
			mode: "show",
			argv: ["spec", "tsq-1", "--show"],
		});
	});

	it("succeeds for valid set params", () => {
		const result = validateSpecParams({
			id: "tsq-1",
			mode: "set",
			text: "# Spec content",
		});
		expect(result).toEqual({
			ok: true,
			mode: "set",
			argv: ["spec", "tsq-1", "--force", "--text=# Spec content"],
		});
	});

	it("preserves non-blank spec text exactly after validation", () => {
		const text = "\n---\ntitle: spec\n---\n# Content\n";
		const result = validateSpecParams({ id: "tsq-1", mode: "set", text });
		expect(result).toEqual({
			ok: true,
			mode: "set",
			argv: ["spec", "tsq-1", "--force", `--text=${text}`],
		});
	});
});

describe("executeTsqSpec", () => {
	describe("read modes", () => {
		it("runs spec show directly without mutation queue", async () => {
			const { pi, captured } = setup();
			captured.execHandler = () =>
				okEnvelope({
					spec: {
						path: "specs/tsq-1/spec.md",
						content: "# Hello",
					},
				});

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "show" },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({
				ok: true,
				action: "spec",
				mode: "show",
				argv: ["spec", "tsq-1", "--show"],
			});
			expect(firstText(result)).toContain("# Hello");
			expect(captured.execCalls).toHaveLength(1);
			expect(captured.execCalls[0]).toMatchObject({
				command: "tsq",
				args: ["spec", "tsq-1", "--show", "--format", "json"],
			});
		});

		it("runs spec check directly without mutation queue", async () => {
			const { pi, captured } = setup();
			captured.execHandler = () => okEnvelope({ ok: true, valid: true });

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-2", mode: "check" },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({
				ok: true,
				action: "spec",
				mode: "check",
			});
			expect(firstText(result)).toBe("Spec check passed");
			expect(captured.execCalls[0]).toMatchObject({
				command: "tsq",
				args: ["spec", "tsq-2", "--check", "--format", "json"],
			});
		});

		it("maps spec check ok:false to spec_check_failed error", async () => {
			const { pi, captured } = setup();
			captured.execHandler = () =>
				okEnvelope({
					ok: false,
					message: "fingerprint mismatch",
					diagnostics: { expected: "abc", actual: "def" },
				});

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-3", mode: "check" },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({
				ok: false,
				error: {
					code: "spec_check_failed",
					message: "fingerprint mismatch",
					details: {
						argv: ["spec", "tsq-3", "--check"],
						diagnostics: { expected: "abc", actual: "def" },
					},
				},
			});
			expect(firstText(result)).toContain("fingerprint mismatch");
		});

		it("maps spec check ok:false with default message when no message field", async () => {
			const { pi } = setup();
			const { pi: pi2, captured: captured2 } = createMockPi();
			captured2.execHandler = () =>
				okEnvelope({ ok: false, issues: ["stale fingerprint"] });

			const result = await executeTsqSpec(
				pi2,
				{ id: "tsq-4", mode: "check" },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({
				ok: false,
				error: {
					code: "spec_check_failed",
					message: "spec check failed",
					details: {
						diagnostics: ["stale fingerprint"],
					},
				},
			});
		});
	});

	describe("write modes", () => {
		it("runs spec set through mutation queue", async () => {
			const { pi, captured } = setup();
			captured.execHandler = () =>
				okEnvelope({ path: "specs/tsq-1/spec.md", fingerprint: "abc123" });

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "set", text: "# New spec" },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({
				ok: true,
				action: "spec",
				mode: "set",
				argv: ["spec", "tsq-1", "--force", "--text=# New spec"],
			});
			expect(firstText(result)).toBe("Spec attached");
			expect(captured.execCalls[0]).toMatchObject({
				command: "tsq",
				args: [
					"spec",
					"tsq-1",
					"--force",
					"--text=# New spec",
					"--format",
					"json",
				],
			});
		});

		it("runs spec update through mutation queue", async () => {
			const { pi, captured } = setup();
			captured.execHandler = () =>
				okEnvelope({ path: "specs/tsq-1/spec.md", fingerprint: "def456" });

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "update", text: "# Updated spec" },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({
				ok: true,
				action: "spec",
				mode: "update",
				argv: ["spec", "tsq-1", "--update", "--text=# Updated spec"],
			});
			expect(firstText(result)).toBe("Spec updated");
			expect(captured.execCalls[0]).toMatchObject({
				command: "tsq",
				args: [
					"spec",
					"tsq-1",
					"--update",
					"--text=# Updated spec",
					"--format",
					"json",
				],
			});
		});

		it("serializes write mutations per cwd", async () => {
			const { pi, captured } = setup();
			const executionOrder: string[] = [];
			let releaseFirst: (() => void) | undefined;
			const firstStarted = new Promise<void>((resolve) => {
				captured.execHandler = async (_cmd, args) => {
					const label = args.includes("--update") ? "update" : "set";
					executionOrder.push(`start:${label}`);
					if (executionOrder.length === 1) {
						resolve();
						await new Promise<void>((r) => {
							releaseFirst = r;
						});
					}
					executionOrder.push(`end:${label}`);
					return okEnvelope({ path: "specs/tsq-1/spec.md" });
				};
			});

			const first = executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "set", text: "first" },
				undefined,
				ctx(),
			);
			await firstStarted;

			const second = executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "update", text: "second" },
				undefined,
				ctx(),
			);
			await Promise.resolve();

			// Second should not start until first finishes
			expect(executionOrder).toEqual(["start:set"]);

			releaseFirst?.();
			await Promise.all([first, second]);

			expect(executionOrder).toEqual([
				"start:set",
				"end:set",
				"start:update",
				"end:update",
			]);
		});
	});

	describe("validation failures before exec", () => {
		it("rejects missing id before running tsq", async () => {
			const { pi, captured } = setup();

			const result = await executeTsqSpec(
				pi,
				{ id: undefined, mode: "show" },
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

		it("rejects text with read modes before running tsq", async () => {
			const { pi, captured } = setup();

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "check", text: "should not be here" },
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

		it("rejects missing text for set mode before running tsq", async () => {
			const { pi, captured } = setup();

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "set" },
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
	});

	describe("leading-dash and frontmatter text safety", () => {
		it("handles frontmatter text with leading triple-dash", async () => {
			const { pi, captured } = setup();
			const frontmatter = "---\ntitle: spec\n---\n# Content";
			captured.execHandler = () => okEnvelope({ path: "specs/tsq-1/spec.md" });

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "set", text: frontmatter },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({ ok: true });
			expect(captured.execCalls[0]).toMatchObject({
				command: "tsq",
				args: [
					"spec",
					"tsq-1",
					"--force",
					`--text=${frontmatter}`,
					"--format",
					"json",
				],
			});
		});

		it("handles text starting with single dash", async () => {
			const { pi, captured } = setup();
			const text = "-v some verbose content";
			captured.execHandler = () => okEnvelope({ path: "specs/tsq-1/spec.md" });

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-1", mode: "update", text },
				undefined,
				ctx(),
			);

			expect(result.details).toMatchObject({ ok: true });
			expect(captured.execCalls[0]).toMatchObject({
				command: "tsq",
				args: [
					"spec",
					"tsq-1",
					"--update",
					`--text=${text}`,
					"--format",
					"json",
				],
			});
		});
	});

	describe("CLI error handling", () => {
		it("returns error details when tsq process fails", async () => {
			const { pi, captured } = setup();
			captured.execHandler = () => ({
				stdout: "",
				stderr: "task not found",
				code: 1,
				killed: false,
			});

			const result = await executeTsqSpec(
				pi,
				{ id: "tsq-99", mode: "show" },
				undefined,
				ctx(),
			);

			expect(firstText(result)).toMatch(/^Error: /u);
			expect(result.details).toMatchObject({
				ok: false,
				error: { code: expect.any(String) },
			});
		});
	});
});
