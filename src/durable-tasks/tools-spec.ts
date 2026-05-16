import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorToolDetails, textToolResult } from "../shared/tool-result.js";
import { runQueuedMutation } from "./mutation-queue.js";
import { runTsqJson } from "./runner.js";

export type SpecMode = "show" | "check" | "set" | "update";

export const SPEC_READ_MODES: readonly SpecMode[] = ["show", "check"];
export const SPEC_WRITE_MODES: readonly SpecMode[] = ["set", "update"];

export interface SpecParams {
	readonly id: string | undefined;
	readonly mode: SpecMode;
	readonly text?: string | undefined;
}

export interface SpecSuccessDetails {
	readonly ok: true;
	readonly action: "spec";
	readonly mode: SpecMode;
	readonly argv: readonly string[];
	readonly data: unknown;
}

export interface SpecCheckFailedDetails {
	readonly ok: false;
	readonly error: {
		readonly code: "spec_check_failed";
		readonly message: string;
		readonly details: unknown;
	};
}

export type SpecDetails = SpecSuccessDetails | SpecCheckFailedDetails;

const DEFAULT_SPEC_TIMEOUT_MS = 10_000;

export async function executeTsqSpec(
	pi: ExtensionAPI,
	params: SpecParams,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<AgentToolResult<SpecDetails>> {
	const validated = validateSpecParams(params);
	if (!validated.ok) {
		return textToolResult(
			`Error: ${validated.message}`,
			errorToolDetails({
				code: "validation_error",
				message: validated.message,
			}) as unknown as SpecDetails,
		);
	}

	const { argv, mode } = validated;
	const isWrite = (SPEC_WRITE_MODES as readonly string[]).includes(mode);

	try {
		const data = isWrite
			? await runQueuedMutation(ctx.cwd, () =>
					runTsqJson(pi, { cwd: ctx.cwd }, argv, {
						timeout: DEFAULT_SPEC_TIMEOUT_MS,
						...(signal === undefined ? {} : { signal }),
					}),
				)
			: await runTsqJson(pi, { cwd: ctx.cwd }, argv, {
					timeout: DEFAULT_SPEC_TIMEOUT_MS,
					...(signal === undefined ? {} : { signal }),
				});

		if (mode === "check" && isSpecCheckFailed(data)) {
			return buildCheckFailedResult(data, argv);
		}

		return textToolResult(formatSpecSuccess(mode, data), {
			ok: true,
			action: "spec",
			mode,
			argv,
			data,
		} as SpecSuccessDetails);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = getErrorCode(error);
		return textToolResult(
			`Error: ${message}`,
			errorToolDetails({
				code,
				message,
				details: { action: "spec", mode, argv },
			}) as unknown as SpecDetails,
		);
	}
}

type ValidationSuccess = {
	readonly ok: true;
	readonly mode: SpecMode;
	readonly argv: string[];
};
type ValidationFailure = { readonly ok: false; readonly message: string };
type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateSpecParams(params: SpecParams): ValidationResult {
	const id = params.id?.trim();
	if (id === undefined || id.length === 0) {
		return { ok: false, message: "spec action requires id" };
	}

	const { mode } = params;
	const isRead = (SPEC_READ_MODES as readonly string[]).includes(mode);
	const isWrite = (SPEC_WRITE_MODES as readonly string[]).includes(mode);

	if (!isRead && !isWrite) {
		return {
			ok: false,
			message: `spec mode must be show, check, set, or update`,
		};
	}

	if (isRead && params.text !== undefined) {
		return {
			ok: false,
			message: `spec ${mode} does not accept text`,
		};
	}

	if (isWrite) {
		const text = params.text?.trim();
		if (text === undefined || text.length === 0) {
			return { ok: false, message: `spec ${mode} requires text` };
		}
	}

	return { ok: true, mode, argv: buildSpecArgv(id, mode, params.text) };
}

export function buildSpecArgv(
	id: string,
	mode: SpecMode,
	text: string | undefined,
): string[] {
	switch (mode) {
		case "show":
			return ["spec", id, "--show"];
		case "check":
			return ["spec", id, "--check"];
		case "set":
			return ["spec", id, "--force", `--text=${text!}`];
		case "update":
			return ["spec", id, "--update", `--text=${text!}`];
	}
}

function isSpecCheckFailed(data: unknown): boolean {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return false;
	}
	return (data as Record<string, unknown>).ok === false;
}

function buildCheckFailedResult(
	data: unknown,
	argv: readonly string[],
): AgentToolResult<SpecDetails> {
	const record = data as Record<string, unknown>;
	const diagnostics = record.diagnostics ?? record.issues ?? record;
	const message =
		typeof record.message === "string" ? record.message : "spec check failed";

	return textToolResult(`Spec check failed: ${message}`, {
		ok: false,
		error: {
			code: "spec_check_failed",
			message,
			details: { argv, diagnostics },
		},
	} as SpecCheckFailedDetails);
}

function formatSpecSuccess(mode: SpecMode, data: unknown): string {
	switch (mode) {
		case "show": {
			const record = data as Record<string, unknown> | null;
			const spec =
				typeof record?.spec === "object" &&
				record.spec !== null &&
				!Array.isArray(record.spec)
					? (record.spec as Record<string, unknown>)
					: undefined;
			const content =
				typeof spec?.content === "string"
					? spec.content
					: typeof record?.content === "string"
						? record.content
						: undefined;
			const path =
				typeof spec?.path === "string"
					? spec.path
					: typeof record?.path === "string"
						? record.path
						: undefined;
			if (content !== undefined) {
				const header = path !== undefined ? `Spec (${path}):\n` : "Spec:\n";
				return `${header}${content}`;
			}
			return "Spec: no content returned";
		}
		case "check":
			return "Spec check passed";
		case "set":
			return "Spec attached";
		case "update":
			return "Spec updated";
	}
}

function getErrorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && !Array.isArray(error)) {
		const code = (error as Record<string, unknown>).code;
		if (typeof code === "string") {
			return code;
		}
	}
	return "tsq_error";
}
