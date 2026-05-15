import { describe, expect, it } from "vitest";
import { truncateLines, truncateText } from "../../src/shared/truncation.js";

describe("truncateText", () => {
	it("leaves text unchanged when it is within bounds", () => {
		const result = truncateText("one\ntwo", { maxLines: 3, maxChars: 20 });

		expect(result).toEqual({
			text: "one\ntwo",
			truncated: false,
			originalChars: 7,
			originalLines: 2,
			omittedChars: 0,
			omittedLines: 0,
			maxChars: 20,
			maxLines: 3,
		});
	});

	it("bounds output by line count and indicates truncation", () => {
		const result = truncateText("one\ntwo\nthree", {
			maxLines: 2,
			maxChars: 80,
		});

		expect(result.truncated).toBe(true);
		expect(result.text.split("\n")).toHaveLength(2);
		expect(result.text).toContain("[truncated");
		expect(result.omittedLines).toBe(1);
	});

	it("bounds output by character count including the truncation notice", () => {
		const result = truncateText("abcdefghijklmnopqrstuvwxyz", {
			maxLines: 5,
			maxChars: 24,
		});

		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(24);
		expect(result.text).toContain("…");
		expect(result.omittedChars).toBeGreaterThan(0);
	});
});

describe("truncateLines", () => {
	it("joins iterable lines before truncating", () => {
		const result = truncateLines(["alpha", "beta", "gamma"], {
			maxLines: 2,
			maxChars: 80,
		});

		expect(result.truncated).toBe(true);
		expect(result.text).toContain("alpha");
		expect(result.text).toContain("[truncated");
	});
});
