import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	truncateText,
	type TruncatedText,
	type TruncationOptions,
} from "./truncation.js";

export interface ToolResultError<TDetails = unknown> {
	readonly code: string;
	readonly message: string;
	readonly details?: TDetails;
}

export type StandardToolDetails<TData = unknown, TErrorDetails = unknown> =
	| {
			readonly ok: true;
			readonly data: TData;
			readonly warnings?: readonly string[];
			readonly truncation?: TruncatedText;
	  }
	| {
			readonly ok: false;
			readonly error: ToolResultError<TErrorDetails>;
			readonly warnings?: readonly string[];
			readonly truncation?: TruncatedText;
	  };

export function textToolResult<TDetails>(
	text: string,
	details: TDetails,
): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function truncatedTextToolResult<
	TDetails extends Record<string, unknown>,
>(
	text: string,
	details: TDetails,
	options: TruncationOptions = {},
): AgentToolResult<TDetails & { readonly truncation: TruncatedText }> {
	const truncation = truncateText(text, options);
	return textToolResult(truncation.text, { ...details, truncation });
}

export function okToolDetails<TData>(
	data: TData,
	options: {
		readonly warnings?: readonly string[];
		readonly truncation?: TruncatedText;
	} = {},
): StandardToolDetails<TData> {
	return {
		ok: true,
		data,
		...(options.warnings === undefined ? {} : { warnings: options.warnings }),
		...(options.truncation === undefined
			? {}
			: { truncation: options.truncation }),
	};
}

export function errorToolDetails<TDetails = unknown>(
	error: ToolResultError<TDetails>,
	options: {
		readonly warnings?: readonly string[];
		readonly truncation?: TruncatedText;
	} = {},
): StandardToolDetails<never, TDetails> {
	return {
		ok: false,
		error,
		...(options.warnings === undefined ? {} : { warnings: options.warnings }),
		...(options.truncation === undefined
			? {}
			: { truncation: options.truncation }),
	};
}
