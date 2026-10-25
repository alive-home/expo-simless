import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { formatSize, maxAgeMs, projectCacheDir, sizeOf } from "./cache.ts"
import { cacheRoot } from "./process.ts"

// What each entry in the caches is, for `simless cache`.
const PROJECT_ENTRIES: Record<string, string> = {
	"native-host": "the iOS host's Xcode project and build intermediates",
	"android-host": "the Android host's Gradle project and build",
}

const SHARED_ENTRIES: Record<string, string> = {
	native: "built iOS hosts, one per native fingerprint",
	swiftui: "built SwiftUI hosts, one per set of Swift files",
	android: "built Android hosts (APKs), and the emulator with its snapshots",
}

// Kept through a clean: the modules a build learned not to compile for Mac Catalyst or Android. Without them the
// next build finds each one again, a failed build at a time.
const LEARNED = "learned-exclude.json"

const display = (file: string) => file.replace(os.homedir(), "~")

const ago = (ms: number) => {
	const days = Math.floor((Date.now() - ms) / 86_400_000)
	return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
}

const liveRun = (dir: string) =>
	fs.existsSync(dir) &&
	fs.readdirSync(dir).some((name) => {
		const pid = Number(/^run-(\d+)-\d+$/.exec(name)?.[1] ?? 0)
		if (pid === 0 || pid === process.pid) {
			return false
		}
		try {
			process.kill(pid, 0)
			return true
		} catch {
			return false
		}
	})

// Android emulators simless started (its AVD is named simless-…), which have the emulator files open.
const openEmulators = () => {
	try {
		return execFileSync("pgrep", ["-f", "--", "-avd simless-"], { encoding: "utf8" }).split("\n").filter(Boolean).length
	} catch {
		return 0
	}
}

const describe = (dir: string, entries: Record<string, string>) => {
	const lines: string[] = []
	if (!fs.existsSync(dir)) {
		return ["  (empty)"]
	}
	const line = (name: string, size: number, about: string) =>
		lines.push(`  ${name.padEnd(14)} ${formatSize(size).padStart(7)}  ${about}`)
	const names = fs.readdirSync(dir).sort()
	for (const name of names) {
		const file = path.join(dir, name)
		if (name.startsWith("run-") || !fs.statSync(file).isDirectory()) {
			continue
		}
		const hosts = fs.readdirSync(file).filter((item) => /^SimlessHost-|^SimlessSwiftUI-/.test(item))
		const used = hosts.map((item) => fs.statSync(path.join(file, item)).mtimeMs)
		const last = used.length > 0 ? ` (${hosts.length}, last used ${ago(Math.max(...used))})` : ""
		line(name, sizeOf(file), `${entries[name] ?? ""}${last}`)
		const avd = fs.existsSync(path.join(file, "avd")) ? path.join(file, "avd") : null
		if (avd) {
			const snapshots = fs
				.readdirSync(avd)
				.filter((item) => item.endsWith(".avd"))
				.flatMap((item) =>
					fs.existsSync(path.join(avd, item, "snapshots")) ? fs.readdirSync(path.join(avd, item, "snapshots")) : [],
				)
				.filter((item) => item.startsWith("host-"))
			line("  emulator", sizeOf(avd), `with ${snapshots.length} host snapshot${snapshots.length === 1 ? "" : "s"}`)
		}
	}
	const runs = names.filter((name) => name.startsWith("run-"))
	if (runs.length > 0) {
		const size = runs.reduce((total, name) => total + sizeOf(path.join(dir, name)), 0)
		line("run-*", size, `${runs.length} run${runs.length === 1 ? "" : "s"}' bundles and plans, kept or left by a kill`)
	}
	return lines
}

export const showCache = (root: string | null) => {
	const lines: string[] = []
	if (root) {
		const dir = projectCacheDir(root)
		lines.push(`This project: ${display(dir)}  ${formatSize(sizeOf(dir))}`, ...describe(dir, PROJECT_ENTRIES), "")
	}
	const shared = cacheRoot()
	lines.push(
		`Shared by every project: ${display(shared)}  ${formatSize(sizeOf(shared))}`,
		...describe(shared, SHARED_ENTRIES),
	)
	lines.push(
		"",
		`A host no run has used for ${Math.round(maxAgeMs() / 86_400_000)} days is deleted by the next run (SIMLESS_CACHE_MAX_AGE_DAYS).`,
		"simless cache clean          this project's cache and the built hosts",
		"simless cache clean project  this project's cache only",
		"simless cache clean all      both, and the Android emulator",
	)
	process.stdout.write(`${lines.join("\n")}\n`)
}

export type CleanScope = "default" | "project" | "all"

export const cleanCache = (root: string | null, scope: CleanScope, log: (line: string) => void) => {
	const removed: string[] = []
	const remove = (file: string) => {
		if (fs.existsSync(file)) {
			const size = sizeOf(file)
			fs.rmSync(file, { recursive: true, force: true })
			removed.push(`${display(file)}  ${formatSize(size)}`)
		}
	}
	if (root) {
		const dir = projectCacheDir(root)
		if (liveRun(dir)) {
			throw new Error("a simless run is going on in this project; clean the cache once it ends")
		}
		const learned = fs.existsSync(dir)
			? fs
					.readdirSync(dir)
					.map((name) => path.join(dir, name, LEARNED))
					.filter((file) => fs.existsSync(file))
					.map((file) => ({ file, content: fs.readFileSync(file) }))
			: []
		remove(dir)
		for (const { file, content } of learned) {
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, content)
		}
	}
	if (scope !== "project") {
		const shared = cacheRoot()
		if (scope === "all" && openEmulators() > 0) {
			throw new Error("simless's Android emulators are running; clean the cache once every run has ended")
		}
		remove(path.join(shared, "native"))
		remove(path.join(shared, "swiftui"))
		const android = path.join(shared, "android")
		for (const name of fs.existsSync(android) ? fs.readdirSync(android) : []) {
			if (name.endsWith(".apk") || scope === "all") {
				remove(path.join(android, name))
			}
		}
	}
	log(removed.length > 0 ? `Removed:\n  ${removed.join("\n  ")}` : "Nothing to remove.")
}
