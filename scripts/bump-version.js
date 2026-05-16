#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const PACKAGE_LOCK = path.join(REPO_ROOT, "package-lock.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const modes = args.filter((arg) => arg !== "--dry-run");
const mode = modes[0] || "patch";

const SEMVER_RE =
	/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function usage() {
	console.log(
		"Usage: node scripts/bump-version.js [patch|minor|major|promote|<semver>] [--dry-run]",
	);
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relative(filePath) {
	return path.relative(process.cwd(), filePath) || path.basename(filePath);
}

function parseSemver(version) {
	const match = version.match(SEMVER_RE);
	if (!match) {
		throw new Error(`Version is not valid semver: ${version}`);
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? "",
	};
}

function compareSemver(a, b) {
	for (const key of ["major", "minor", "patch"]) {
		if (a[key] !== b[key]) {
			return a[key] - b[key];
		}
	}
	if (a.prerelease === b.prerelease) {
		return 0;
	}
	if (!a.prerelease) {
		return 1;
	}
	if (!b.prerelease) {
		return -1;
	}
	return a.prerelease.localeCompare(b.prerelease);
}

function computeNextVersion(current, input) {
	const parsedCurrent = parseSemver(current);

	if (SEMVER_RE.test(input)) {
		const parsedNext = parseSemver(input);
		if (compareSemver(parsedNext, parsedCurrent) < 0) {
			throw new Error(`Explicit version ${input} is lower than current version ${current}.`);
		}
		return input;
	}

	let { major, minor, patch } = parsedCurrent;

	if (input === "promote") {
		if (!parsedCurrent.prerelease) {
			throw new Error(`Current version ${current} has no prerelease to promote.`);
		}
		return `${major}.${minor}.${patch}`;
	}
	if (input === "major") {
		major += 1;
		minor = 0;
		patch = 0;
		return `${major}.${minor}.${patch}`;
	}
	if (input === "minor") {
		minor += 1;
		patch = 0;
		return `${major}.${minor}.${patch}`;
	}
	if (input === "patch") {
		patch += 1;
		return `${major}.${minor}.${patch}`;
	}

	throw new Error(
		`Unsupported bump mode: ${input}. Use patch, minor, major, promote, or an explicit semver.`,
	);
}

function updatePackageLock(next) {
	const lock = readJson(PACKAGE_LOCK);
	const previous = lock.version;

	lock.version = next;
	if (lock.packages?.[""]) {
		lock.packages[""].version = next;
	}

	return { lock, previous };
}

function main() {
	if (modes.length > 1) {
		throw new Error(`Expected at most one version argument, received: ${modes.join(", ")}`);
	}

	const pkg = readJson(PACKAGE_JSON);
	const current = pkg.version;
	const next = computeNextVersion(current, mode);

	if (next === current) {
		console.log(`Version unchanged: ${current}`);
		return;
	}

	const nextPkg = { ...pkg, version: next };
	const { lock, previous: lockPrevious } = updatePackageLock(next);

	if (dryRun) {
		console.log(`[dry-run] ${current} -> ${next}`);
		console.log(`[dry-run] ${relative(PACKAGE_JSON)}: ${current} -> ${next}`);
		console.log(`[dry-run] ${relative(PACKAGE_LOCK)}: ${lockPrevious} -> ${next}`);
		return;
	}

	writeJson(PACKAGE_JSON, nextPkg);
	console.log(`${relative(PACKAGE_JSON)}: ${current} -> ${next}`);
	writeJson(PACKAGE_LOCK, lock);
	console.log(`${relative(PACKAGE_LOCK)}: ${lockPrevious} -> ${next}`);
}

try {
	main();
} catch (error) {
	usage();
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
