import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readManifest(): Promise<Record<string, unknown>> {
	const raw = await readFile(resolve(repoRoot, "package.json"), "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("package manifest", () => {
	it("declares the publishable Pi package identity", async () => {
		const manifest = await readManifest();

		expect(manifest.name).toBe("pi-tasque");
		expect(manifest.type).toBe("module");
		expect(manifest.license).toBe("MIT");
		expect(manifest.keywords).toEqual(
			expect.arrayContaining(["pi-package", "pi-extension"]),
		);
	});

	it("points Pi at an existing TypeScript extension entrypoint", async () => {
		const manifest = await readManifest();

		expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"] });
		await expect(
			access(resolve(repoRoot, "src/index.ts")),
		).resolves.toBeUndefined();
	});

	it("keeps Pi runtime packages and typebox as peer dependencies", async () => {
		const manifest = await readManifest();
		const peerDependencies = manifest.peerDependencies as Record<
			string,
			string
		>;

		expect(peerDependencies).toMatchObject({
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
			typebox: "*",
		});
	});

	it("declares local verification scripts and dev dependencies", async () => {
		const manifest = await readManifest();
		const scripts = manifest.scripts as Record<string, string>;
		const devDependencies = manifest.devDependencies as Record<string, string>;

		expect(scripts.typecheck).toBe("tsc --noEmit");
		expect(scripts.test).toBe("vitest run");
		expect(devDependencies).toEqual(
			expect.objectContaining({
				"@types/node": expect.any(String),
				typescript: expect.any(String),
				vitest: expect.any(String),
			}),
		);
	});
});
