import type { Theme } from "@earendil-works/pi-coding-agent";

export function makeTheme(): Theme {
	const identity = (_color: string, text: string) => text;

	return {
		fg: identity,
		bg: identity,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
		getColorMode: () => "truecolor",
	} as unknown as Theme;
}
