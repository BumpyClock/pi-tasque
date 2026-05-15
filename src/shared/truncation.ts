export const DEFAULT_MAX_OUTPUT_LINES = 80;
export const DEFAULT_MAX_OUTPUT_CHARS = 8_000;

export interface TruncationOptions {
	readonly maxLines?: number;
	readonly maxChars?: number;
}

export interface TruncatedText {
	readonly text: string;
	readonly truncated: boolean;
	readonly originalChars: number;
	readonly originalLines: number;
	readonly omittedChars: number;
	readonly omittedLines: number;
	readonly maxChars: number;
	readonly maxLines: number;
}

export function truncateText(
	input: string,
	options: TruncationOptions = {},
): TruncatedText {
	const maxLines = normalizePositiveInteger(
		options.maxLines,
		DEFAULT_MAX_OUTPUT_LINES,
		"maxLines",
	);
	const maxChars = normalizePositiveInteger(
		options.maxChars,
		DEFAULT_MAX_OUTPUT_CHARS,
		"maxChars",
	);
	const originalLines = countLines(input);
	const originalChars = input.length;

	let visible = input;
	let truncated = false;

	if (originalLines > maxLines) {
		visible = input.split(/\r?\n/u).slice(0, maxLines).join("\n");
		truncated = true;
	}

	if (visible.length > maxChars) {
		visible = visible.slice(0, maxChars);
		truncated = true;
	}

	if (!truncated) {
		return {
			text: input,
			truncated: false,
			originalChars,
			originalLines,
			omittedChars: 0,
			omittedLines: 0,
			maxChars,
			maxLines,
		};
	}

	const notice = buildTruncationNotice({
		omittedChars: Math.max(0, originalChars - visible.length),
		omittedLines: Math.max(0, originalLines - countLines(visible)),
	});
	const text = appendNoticeWithinBounds(visible, notice, maxLines, maxChars);

	return {
		text,
		truncated: true,
		originalChars,
		originalLines,
		omittedChars: Math.max(0, originalChars - visible.length),
		omittedLines: Math.max(0, originalLines - countLines(visible)),
		maxChars,
		maxLines,
	};
}

export function truncateLines(
	lines: Iterable<string>,
	options: TruncationOptions = {},
): TruncatedText {
	return truncateText(Array.from(lines).join("\n"), options);
}

export function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return text.split(/\r?\n/u).length;
}

function buildTruncationNotice({
	omittedChars,
	omittedLines,
}: {
	readonly omittedChars: number;
	readonly omittedLines: number;
}): string {
	const parts: string[] = [];
	if (omittedLines > 0) {
		parts.push(`${omittedLines} line${omittedLines === 1 ? "" : "s"}`);
	}
	if (omittedChars > 0) {
		parts.push(`${omittedChars} char${omittedChars === 1 ? "" : "s"}`);
	}
	return `… [truncated${parts.length > 0 ? `: ${parts.join(", ")} omitted` : ""}]`;
}

function appendNoticeWithinBounds(
	text: string,
	notice: string,
	maxLines: number,
	maxChars: number,
): string {
	if (maxChars <= 1) {
		return "…".slice(0, maxChars);
	}

	const currentLines = countLines(text);
	const separator = currentLines > 0 && currentLines < maxLines ? "\n" : " ";
	const suffix = `${separator}${notice}`;

	if (suffix.length >= maxChars) {
		return notice.slice(0, maxChars);
	}

	const prefixBudget = maxChars - suffix.length;
	const prefix = text.slice(0, prefixBudget).trimEnd();
	if (prefix.length === 0) {
		return notice.slice(0, maxChars);
	}
	return `${prefix}${suffix}`;
}

function normalizePositiveInteger(
	value: number | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive integer`);
	}
	return value;
}
