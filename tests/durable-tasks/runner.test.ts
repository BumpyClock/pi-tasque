import { describe, expect, it } from "vitest";
import {
	parseTsqEnvelope,
	runTsqJson,
	TsqCommandError,
	TsqProcessError,
} from "../../src/durable-tasks/runner.js";
import { createMockPi } from "../support/pi-harness.js";

describe("parseTsqEnvelope", () => {
	it("parses successful JSON envelopes", () => {
		const envelope = parseTsqEnvelope(
			JSON.stringify({
				schema_version: 1,
				command: "tsq show tsq-1",
				ok: true,
				data: { id: "tsq-1", title: "Build runner" },
			}),
		);

		expect(envelope).toEqual({
			schema_version: 1,
			command: "tsq show tsq-1",
			ok: true,
			data: { id: "tsq-1", title: "Build runner" },
		});
	});

	it("parses error JSON envelopes", () => {
		const envelope = parseTsqEnvelope(
			JSON.stringify({
				schema_version: 1,
				command: "tsq show missing",
				ok: false,
				error: {
					code: "not_found",
					message: "Task not found",
					details: { id: "missing" },
				},
			}),
		);

		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error).toEqual({
				code: "not_found",
				message: "Task not found",
				details: { id: "missing" },
			});
		}
	});

	it("throws a concrete error for invalid JSON", () => {
		expect(() => parseTsqEnvelope("not json")).toThrow(
			new Error("tsq returned invalid JSON"),
		);
	});

	it("throws a concrete error for unsupported schema versions", () => {
		expect(() =>
			parseTsqEnvelope(
				JSON.stringify({
					schema_version: 2,
					command: "tsq doctor",
					ok: true,
					data: {},
				}),
			),
		).toThrow("tsq returned unsupported schema version: 2");
	});

	it("throws a concrete error when ok is not a boolean", () => {
		expect(() =>
			parseTsqEnvelope(
				JSON.stringify({
					schema_version: 1,
					command: "tsq doctor",
					ok: "true",
					data: {},
				}),
			),
		).toThrow("tsq returned invalid JSON envelope: ok must be boolean");
	});
});

describe("runTsqJson", () => {
	it("runs tsq with argv JSON format, cwd, timeout, and signal", async () => {
		const { pi, captured } = createMockPi();
		const signal = new AbortController().signal;
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq show tsq-1",
				ok: true,
				data: { id: "tsq-1" },
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await expect(
			runTsqJson<{ id: string }>(pi, { cwd: "/repo" }, ["show", "tsq-1"], {
				timeout: 1234,
				signal,
			}),
		).resolves.toEqual({ id: "tsq-1" });

		expect(captured.execCalls).toEqual([
			{
				command: "tsq",
				args: ["show", "tsq-1", "--format", "json"],
				options: { cwd: "/repo", timeout: 1234, signal },
			},
		]);
	});

	it("inserts JSON format args before a positional-text separator", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq note tsq-1",
				ok: true,
				data: { id: "tsq-1" },
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["note", "tsq-1", "--", "-note"]),
		).resolves.toEqual({ id: "tsq-1" });

		expect(captured.execCalls[0]?.args).toEqual([
			"note",
			"tsq-1",
			"--format",
			"json",
			"--",
			"-note",
		]);
	});

	it("does not treat positional text after a separator as format args", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq note tsq-1",
				ok: true,
				data: { id: "tsq-1" },
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, [
				"note",
				"tsq-1",
				"--",
				"--format=human",
			]),
		).resolves.toEqual({ id: "tsq-1" });

		expect(captured.execCalls[0]?.args).toEqual([
			"note",
			"tsq-1",
			"--format",
			"json",
			"--",
			"--format=human",
		]);
	});

	it("does not append duplicate argv JSON format args", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq show tsq-1",
				ok: true,
				data: { id: "tsq-1" },
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["show", "tsq-1", "--format", "json"]),
		).resolves.toEqual({ id: "tsq-1" });

		expect(captured.execCalls[0]?.args).toEqual([
			"show",
			"tsq-1",
			"--format",
			"json",
		]);
	});

	it("does not append duplicate equals JSON format args", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq show tsq-1",
				ok: true,
				data: { id: "tsq-1" },
			}),
			stderr: "",
			code: 0,
			killed: false,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["show", "tsq-1", "--format=json"]),
		).resolves.toEqual({ id: "tsq-1" });

		expect(captured.execCalls[0]?.args).toEqual([
			"show",
			"tsq-1",
			"--format=json",
		]);
	});

	it.each([
		[["show", "tsq-1", "--format", "human"]],
		[["show", "tsq-1", "--format=human"]],
	])("rejects non-json format args before exec", async (args) => {
		const { pi, captured } = createMockPi();

		await expect(runTsqJson(pi, { cwd: "/repo" }, args)).rejects.toThrow(
			"runTsqJson requires JSON format output",
		);

		expect(captured.execCalls).toEqual([]);
	});

	it("throws a process error when tsq is killed with empty stdout", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: true,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["doctor"]),
		).rejects.toMatchObject({
			name: "TsqProcessError",
			code: 0,
			stdout: "",
			killed: true,
		});
		await expect(runTsqJson(pi, { cwd: "/repo" }, ["doctor"])).rejects.toThrow(
			"tsq failed with exit code 0 (killed)",
		);
	});

	it("throws a process error when tsq is killed despite an ok envelope", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq doctor",
				ok: true,
				data: {},
			}),
			stderr: "",
			code: 0,
			killed: true,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["doctor"]),
		).rejects.toMatchObject({
			name: "TsqProcessError",
			code: 0,
			killed: true,
		});
		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["doctor"]),
		).rejects.toBeInstanceOf(TsqProcessError);
	});

	it("throws Tasque envelope errors with code, message, and details", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq show missing",
				ok: false,
				error: {
					code: "not_found",
					message: "Task not found",
					details: { id: "missing" },
				},
			}),
			stderr: "",
			code: 1,
			killed: false,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["show", "missing"]),
		).rejects.toMatchObject({
			name: "TsqCommandError",
			code: "not_found",
			message: "Task not found",
			details: { id: "missing" },
			command: "tsq show missing",
		});
		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["show", "missing"]),
		).rejects.toBeInstanceOf(TsqCommandError);
	});

	it("throws with stderr and exit code when nonzero output has no parseable envelope", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: "",
			stderr: "fatal: not a tasque repo",
			code: 2,
			killed: false,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["doctor"]),
		).rejects.toMatchObject({
			name: "TsqProcessError",
			code: 2,
			stderr: "fatal: not a tasque repo",
		});
		await expect(runTsqJson(pi, { cwd: "/repo" }, ["doctor"])).rejects.toThrow(
			"tsq failed with exit code 2: fatal: not a tasque repo",
		);
	});

	it("throws when tsq exits nonzero despite an ok envelope", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => ({
			stdout: JSON.stringify({
				schema_version: 1,
				command: "tsq doctor",
				ok: true,
				data: {},
			}),
			stderr: "unexpected failure",
			code: 1,
			killed: false,
		});

		await expect(
			runTsqJson(pi, { cwd: "/repo" }, ["doctor"]),
		).rejects.toBeInstanceOf(TsqProcessError);
	});
});
