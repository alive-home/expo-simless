import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { NODE, type Project, type Renderer, type RendererContext } from "@alivelabs/expo-simless/renderer"
import { DEFAULT_DEVICE, DEVICES } from "./devices.ts"
import { ensureHostSnapshot, READY_LINE } from "./emulator.ts"
import { DEFAULT_NATIVE_EXCLUDE, ensureHostApk, readLearnedExcludes } from "./hostBuild.ts"
import { expoModuleNames, resolveNativePackages } from "./nativePackages.ts"
import type { RunnerConfig } from "./runner.ts"
import { androidCacheDir, findSdk } from "./sdk.ts"

// runner.ts beside the sources in a checkout, runner.js beside the compiled index.js in the published package.
const RUNNER = fileURLToPath(new URL(`./runner${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url))

// How many emulators a run keeps up at once. Each takes about 2 GB of memory; renders beyond these wait their turn.
const emulatorCount = () => Math.max(1, Number(process.env.SIMLESS_ANDROID_EMULATORS) || 2)

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

// The emulators a run's runners boot into its pool stay up for the next render, and go when the CLI does.
const createPool = () => {
	const pool = path.join(androidCacheDir(), "pools", String(process.pid))
	fs.mkdirSync(pool, { recursive: true })
	const stop = () => {
		for (const file of fs.existsSync(pool) ? fs.readdirSync(pool) : []) {
			if (!/^slot-\d+\.json$/.test(file)) {
				continue
			}
			try {
				const { pid } = JSON.parse(fs.readFileSync(path.join(pool, file), "utf8")) as { pid: number }
				if (pid > 0 && alive(pid)) {
					process.kill(pid, "SIGTERM")
				}
			} catch {
				// A state file being written as the CLI ends; its emulator is the one being booted.
			}
		}
		fs.rmSync(pool, { recursive: true, force: true })
	}
	process.once("exit", stop)
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			stop()
			// Another handler (show's) ends the process itself.
			if (process.listenerCount(signal) === 0) {
				process.exit(signal === "SIGINT" ? 130 : 143)
			}
		})
	}
	return pool
}

const prepare = async (project: Project, { log, verbose }: RendererContext) => {
	const sdk = await findSdk()
	if (typeof sdk === "string") {
		throw new Error(sdk)
	}
	const packages = resolveNativePackages(project)
	const requested = [
		...new Set([
			...DEFAULT_NATIVE_EXCLUDE,
			...(project.config.native?.exclude ?? []),
			...readLearnedExcludes(project, packages),
		]),
	]
	// Either name works in the config; autolinking wants its own.
	const autolinkingName = (name: string) => packages.find((pkg) => pkg.jsName === name)?.name ?? name
	const host = await ensureHostApk(project, packages, requested.map(autolinkingName), sdk, log, verbose)
	const pool = createPool()
	const snapshot = await ensureHostSnapshot(sdk, host.apk, host.key, log, path.join(pool, "snapshot.log"))
	const linked = packages.filter((pkg) => !host.exclude.includes(pkg.name))
	const excluded = packages.filter((pkg) => host.exclude.includes(pkg.name))
	const config: RunnerConfig = { sdk, apk: host.apk, apkKey: host.key, snapshot, pool, emulators: emulatorCount() }
	return {
		linked: linked.map((pkg) => pkg.jsName),
		excluded: excluded.filter((pkg) => pkg.kind === "react-native").map((pkg) => ({ name: pkg.jsName, dir: pkg.root })),
		stubbedNativeModules: excluded.filter((pkg) => pkg.kind === "expo").flatMap(expoModuleNames),
		launch: (plan: string, options: { locale?: string; timeZone?: string }) => {
			const runnerConfig = path.join(path.dirname(plan), `${path.basename(plan, ".json")}-android.json`)
			fs.writeFileSync(runnerConfig, JSON.stringify({ ...config, locale: options.locale, timeZone: options.timeZone }))
			return {
				command: NODE,
				args: ["--no-warnings", RUNNER, plan, runnerConfig],
				env: process.env,
				readyLine: READY_LINE,
			}
		},
		// A process per emulator: more would wait for one, and none is worth starting before it can render.
		concurrency: config.emulators,
	}
}

// Draws with Android's own views on an emulator booted from a snapshot, in a host built from the app's native
// modules. Needs the Android SDK with an emulator image that runs as root (google_apis or default).
export const renderer: Renderer = {
	name: "android",
	platform: "android",
	devices: DEVICES,
	defaultDevice: DEFAULT_DEVICE,
	unavailable: async () => {
		const sdk = await findSdk()
		return typeof sdk === "string" ? sdk : null
	},
	prepare,
}
