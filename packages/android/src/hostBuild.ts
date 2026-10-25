import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cacheRoot, hashOf, markUsed, type Project, pruneUnused, run } from "@alivelabs/expo-simless/renderer"
import { nativeFingerprint } from "./fingerprint.ts"
import type { NativePackage } from "./nativePackages.ts"
import { type AndroidSdk, sdkEnv } from "./sdk.ts"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TEMPLATE = path.join(PACKAGE_ROOT, "host")

// Files whose text names the project or the Gradle version; the rest of the template is copied as it is.
const FILLED = new Set([
	"settings.gradle",
	path.join("app", "build.gradle"),
	path.join("gradle", "wrapper", "gradle-wrapper.properties"),
])

// The Gradle the host starts with. The Android Gradle plugin an Expo SDK brings names the oldest it accepts when it
// is newer, and the build then runs again on that one (gradleVersionPath remembers it).
const DEFAULT_GRADLE_VERSION = "9.4.1"

// Native code that only makes sense in a running app: dev tooling, OTA updates (which also take over where the
// bundle is loaded from), and the splash screen, which covers the root view until the app hides it. The same list
// @alivelabs/expo-simless-macos leaves out, so a render script sees the same modules on both platforms.
export const DEFAULT_NATIVE_EXCLUDE = [
	"expo-dev-client",
	"expo-dev-launcher",
	"expo-dev-menu",
	"expo-dev-menu-interface",
	"expo-updates",
	"expo-splash-screen",
]

const MAX_BUILD_ATTEMPTS = 6

type Log = (line: string) => void

export const hostDirOf = (project: Project) =>
	path.join(project.root, "node_modules", ".cache", "simless", "android-host")

const learnedExcludesPath = (project: Project) => path.join(hostDirOf(project), "learned-exclude.json")

const gradleVersionPath = (project: Project) => path.join(hostDirOf(project), "gradle-version.txt")

const gradleVersionOf = (project: Project) => {
	try {
		return fs.readFileSync(gradleVersionPath(project), "utf8").trim() || DEFAULT_GRADLE_VERSION
	} catch {
		return DEFAULT_GRADLE_VERSION
	}
}

type LearnedExclude = { name: string; version: string }

// Modules an earlier build found do not compile in the host, at the version that did not: an upgrade is tried again.
export const readLearnedExcludes = (project: Project, packages: NativePackage[]): string[] => {
	try {
		const learned = JSON.parse(fs.readFileSync(learnedExcludesPath(project), "utf8")) as LearnedExclude[]
		return learned
			.filter(({ name, version }) => packages.some((pkg) => pkg.name === name && pkg.version === version))
			.map(({ name }) => name)
	} catch {
		return []
	}
}

const templateFiles = (dir = TEMPLATE, prefix = ""): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const relative = path.join(prefix, entry.name)
		return entry.isDirectory() ? templateFiles(path.join(dir, entry.name), relative) : [relative]
	})

// Copied over what is there, so Gradle's build directory and caches survive from one build to the next.
const writeHostProject = (project: Project, exclude: string[], sdk: AndroidSdk) => {
	const hostDir = hostDirOf(project)
	for (const file of templateFiles()) {
		const target = path.join(hostDir, file)
		fs.mkdirSync(path.dirname(target), { recursive: true })
		if (FILLED.has(file)) {
			const text = fs
				.readFileSync(path.join(TEMPLATE, file), "utf8")
				.replaceAll("__PROJECT_ROOT__", project.root)
				.replaceAll("__EXCLUDE__", JSON.stringify(exclude))
				.replaceAll("__GRADLE_VERSION__", gradleVersionOf(project))
			fs.writeFileSync(target, text)
		} else {
			fs.copyFileSync(path.join(TEMPLATE, file), target)
		}
	}
	fs.chmodSync(path.join(hostDir, "gradlew"), 0o755)
	fs.writeFileSync(path.join(hostDir, "local.properties"), `sdk.dir=${sdk.root}\n`)
}

type BuildResult = { ok: boolean; output: string; apk: string; logPath: string }

const buildHost = async (
	project: Project,
	exclude: string[],
	sdk: AndroidSdk,
	attempt: number,
	log: Log,
	verbose: boolean,
): Promise<BuildResult> => {
	const hostDir = hostDirOf(project)
	writeHostProject(project, exclude, sdk)
	log("Compiling the project's native modules for the Android host (once, then only when they change)…")
	const build = await run(
		path.join(hostDir, "gradlew"),
		[":app:assembleDebug", `-PreactNativeArchitectures=${sdk.abi}`, "--console=plain"],
		{ cwd: hostDir, env: sdkEnv(sdk), inherit: verbose },
	)
	const output = `${build.stdout}\n${build.stderr}`
	// One log per attempt: a retry would otherwise overwrite the error that caused it.
	const logPath = path.join(hostDir, `build-${attempt}.log`)
	fs.writeFileSync(logPath, output)
	return {
		ok: build.code === 0,
		output,
		apk: path.join(hostDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
		logPath,
	}
}

// The Gradle projects whose tasks failed, as `> Task :react-native-foo:compileDebugKotlin FAILED` and
// `Execution failed for task ':react-native-foo:…'` name them.
const failedProjects = (output: string): string[] => {
	const names = new Set<string>()
	for (const match of output.matchAll(/^> Task :([^:\s]+):\S+ FAILED/gm)) {
		names.add(match[1] ?? "")
	}
	for (const match of output.matchAll(/Execution failed for task ':([^:']+):/g)) {
		names.add(match[1] ?? "")
	}
	names.delete("app")
	names.delete("bindings")
	return [...names].filter(Boolean)
}

export type HostApk = { apk: string; key: string }

// The host APK for this project's native modules minus `exclude`, built once and kept under its fingerprint. A
// module that fails to compile is left out and the build tried again, as the macOS host does.
// Marks the APK this run takes as used, and deletes the ones no run has taken for a while: one is built per native
// fingerprint, so every native dependency change leaves one behind.
const useApk = (apk: string) => {
	markUsed(apk)
	pruneUnused(path.dirname(apk), (name) => /^SimlessHost-\w+\.apk$/.test(name), [apk])
}

export const ensureHostApk = async (
	project: Project,
	packages: NativePackage[],
	initialExclude: string[],
	sdk: AndroidSdk,
	log: Log,
	verbose: boolean,
): Promise<HostApk & { exclude: string[] }> => {
	const configuredExclude = project.config.native?.exclude ?? []
	let exclude = initialExclude
	const fingerprint = await nativeFingerprint(project.root)
	const template = templateFiles().map((file) => [file, fs.readFileSync(path.join(TEMPLATE, file))] as const)
	for (let attempt = 1; ; attempt += 1) {
		const key = hashOf([fingerprint, sdk.abi, JSON.stringify(exclude), ...template.flat()])
		const apk = path.join(cacheRoot(), "android", `SimlessHost-${key}.apk`)
		if (fs.existsSync(apk)) {
			useApk(apk)
			return { apk, key, exclude }
		}
		const build = await buildHost(project, exclude, sdk, attempt, log, verbose)
		if (build.ok) {
			// Renamed into place, so a run starting meanwhile never installs half a file.
			const partial = `${apk}.partial-${process.pid}`
			fs.mkdirSync(path.dirname(apk), { recursive: true })
			fs.copyFileSync(build.apk, partial)
			fs.renameSync(partial, apk)
			useApk(apk)
			return { apk, key, exclude }
		}
		const requiredGradle = /Minimum supported Gradle version is ([\d.]+)/.exec(build.output)?.[1]
		if (requiredGradle && requiredGradle !== gradleVersionOf(project) && attempt < MAX_BUILD_ATTEMPTS) {
			log(`The Android Gradle plugin needs Gradle ${requiredGradle}; building again with it…`)
			fs.writeFileSync(gradleVersionPath(project), requiredGradle)
			continue
		}
		const culprits = failedProjects(build.output)
			.map((gradleProject) => packages.find((pkg) => pkg.gradleProjects.includes(gradleProject))?.name)
			.filter((name): name is string => Boolean(name))
		const fresh = [...new Set(culprits)].filter((name) => !exclude.includes(name))
		if (fresh.length === 0 || attempt >= MAX_BUILD_ATTEMPTS) {
			const errors = build.output
				.split("\n")
				.filter((line) => /^e: |error:|FAILURE:|What went wrong|^> /.test(line))
				.slice(0, 30)
				.map((line) => line.slice(0, 300))
				.join("\n")
			throw new Error(
				`The Android host did not build (full log: ${build.logPath}).\n${errors}\n` +
					"Exclude the module that fails in simless.config.ts (native: { exclude: [...] }).",
			)
		}
		log(`Not built for the Android host, so mocked instead: ${fresh.join(", ")}`)
		exclude = [...exclude, ...fresh]
		const learned: LearnedExclude[] = exclude
			.filter((name) => !DEFAULT_NATIVE_EXCLUDE.includes(name) && !configuredExclude.includes(name))
			.map((name) => ({ name, version: packages.find((pkg) => pkg.name === name)?.version ?? "" }))
		fs.mkdirSync(hostDirOf(project), { recursive: true })
		fs.writeFileSync(learnedExcludesPath(project), JSON.stringify(learned, null, "\t"))
	}
}
