import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	TSQ_SCHEMA_VERSION,
	type JsonValue,
	type TsqEnvelope,
	type TsqErr,
} from "./types.js";

export interface TsqRunContext {
	readonly cwd: string;
}

export interface TsqRunOptions {
	readonly timeout?: number;
	readonly signal?: AbortSignal;
}

export class TsqCommandError extends Error {
	override readonly name = "TsqCommandError";
	readonly code: string;
	readonly command: string;
	readonly details?: JsonValue;
	readonly envelope: TsqErr;

	constructor(envelope: TsqErr) {
		super(envelope.error.message);
		this.code = envelope.error.code;
		this.command = envelope.command;
		this.envelope = envelope;
		const { details } = envelope.error;
		if (details !== undefined) {
			this.details = details;
		}
	}
}

export class TsqProcessError extends Error {
	override readonly name = "TsqProcessError";
	readonly code: number;
	readonly stderr: string;
	readonly stdout: string;
	readonly killed: boolean;
	readonly args: readonly string[];
	override readonly cause?: unknown;

	constructor(result: ExecResult, args: readonly string[], cause?: unknown) {
		super(buildProcessErrorMessage(result));
		this.code = result.code;
		this.stderr = result.stderr;
		this.stdout = result.stdout;
		this.killed = result.killed;
		this.args = [...args];
		if (cause !== undefined) {
			this.cause = cause;
		}
	}
}

export async function runTsqJson<TData>(
	pi: ExtensionAPI,
	ctx: TsqRunContext,
	args: readonly string[],
	options: TsqRunOptions = {},
): Promise<TData> {
	const execArgs = buildJsonArgs(args);
	const result = await pi.exec("tsq", execArgs, buildExecOptions(ctx, options));

	if (result.killed) {
		throw new TsqProcessError(result, execArgs);
	}

	let envelope: TsqEnvelope<unknown>;
	try {
		envelope = parseTsqEnvelope(result.stdout);
	} catch (error) {
		if (result.code !== 0) {
			throw new TsqProcessError(result, execArgs, error);
		}
		throw error;
	}

	if (!envelope.ok) {
		throw new TsqCommandError(envelope);
	}

	if (result.code !== 0) {
		throw new TsqProcessError(result, execArgs);
	}

	return envelope.data as TData;
}

export function parseTsqEnvelope(stdout: string): TsqEnvelope<unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("tsq returned invalid JSON");
	}

	if (!isRecord(parsed)) {
		throw new Error(
			"tsq returned invalid JSON envelope: root must be an object",
		);
	}

	if (!("schema_version" in parsed)) {
		throw new Error(
			"tsq returned invalid JSON envelope: schema_version is required",
		);
	}
	if (parsed.schema_version !== TSQ_SCHEMA_VERSION) {
		throw new Error(
			`tsq returned unsupported schema version: ${String(parsed.schema_version)}`,
		);
	}

	if (typeof parsed.command !== "string") {
		throw new Error(
			"tsq returned invalid JSON envelope: command must be a string",
		);
	}

	if (typeof parsed.ok !== "boolean") {
		throw new Error("tsq returned invalid JSON envelope: ok must be boolean");
	}

	if (parsed.ok) {
		if (!("data" in parsed)) {
			throw new Error(
				"tsq returned invalid JSON envelope: data is required when ok is true",
			);
		}
		return parsed as unknown as TsqEnvelope<unknown>;
	}

	if (!isRecord(parsed.error)) {
		throw new Error(
			"tsq returned invalid JSON envelope: error is required when ok is false",
		);
	}
	if (typeof parsed.error.code !== "string") {
		throw new Error(
			"tsq returned invalid JSON envelope: error.code must be a string",
		);
	}
	if (typeof parsed.error.message !== "string") {
		throw new Error(
			"tsq returned invalid JSON envelope: error.message must be a string",
		);
	}

	return parsed as unknown as TsqEnvelope<unknown>;
}

function buildJsonArgs(args: readonly string[]): string[] {
	let hasJsonFormat = false;
	const separatorIndex = args.indexOf("--");
	const optionEndIndex = separatorIndex === -1 ? args.length : separatorIndex;

	for (let index = 0; index < optionEndIndex; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		if (arg === "--format") {
			const value = args[index + 1];
			if (value === "json") {
				hasJsonFormat = true;
				index += 1;
				continue;
			}
			const received =
				value === undefined ? "--format without a value" : `--format ${value}`;
			throw new Error(buildFormatError(received));
		}

		if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length);
			if (value === "json") {
				hasJsonFormat = true;
				continue;
			}
			throw new Error(buildFormatError(arg));
		}
	}

	if (hasJsonFormat) {
		return [...args];
	}

	if (separatorIndex === -1) {
		return [...args, "--format", "json"];
	}

	return [
		...args.slice(0, separatorIndex),
		"--format",
		"json",
		...args.slice(separatorIndex),
	];
}

function buildFormatError(received: string): string {
	return `runTsqJson requires JSON format output; received ${received}`;
}

function buildExecOptions(
	ctx: TsqRunContext,
	options: TsqRunOptions,
): ExecOptions {
	return {
		cwd: ctx.cwd,
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	};
}

function buildProcessErrorMessage(result: ExecResult): string {
	const summary = result.stderr.trim() || result.stdout.trim();
	const killed = result.killed ? " (killed)" : "";
	if (summary.length === 0) {
		return `tsq failed with exit code ${result.code}${killed}`;
	}
	return `tsq failed with exit code ${result.code}${killed}: ${summary}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
