import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { buildAtomically, cacheRoot, expoRequire, hashOf, type Project, run, runOrThrow } from "expo-simless/renderer"
import { addMissingCatalystSlices } from "./catalystSlices.ts"
import { nativeFingerprint } from "./fingerprint.ts"
import { applyInfoPlist, recordHostInfoPlist } from "./infoPlist.ts"
import { NATIVE_ROOT, toolchainVersion } from "./toolchain.ts"

const HOST_SOURCES = [
	path.join(NATIVE_ROOT, "react-native", "SMLReactHost.mm"),
	path.join(NATIVE_ROOT, "shared", "SMLCapture.h"),
	path.join(NATIVE_ROOT, "shared", "SMLCapture.m"),
	path.join(NATIVE_ROOT, "native-host", "SMLExpoDelegate.swift"),
	path.join(NATIVE_ROOT, "native-host", "SimlessHost-Bridging-Header.h"),
]
const TEMPLATES = [
	path.join(NATIVE_ROOT, "Info.plist"),
	path.join(NATIVE_ROOT, "native-host", "Podfile.template"),
	path.join(NATIVE_ROOT, "native-host", "create_project.rb"),
	path.join(NATIVE_ROOT, "native-host", "react-native-config.cjs"),
	path.join(NATIVE_ROOT, "native-host", "catalyst-shims", "AppKit", "AppKit.h"),
]

// Native code that only makes sense in a running app: dev tooling, OTA updates (which also take over where the
// bundle is loaded from), and the splash screen, which covers the root view until the app hides it.
export const DEFAULT_NATIVE_EXCLUDE = [
	"expo-dev-client",
	"expo-dev-launcher",
	"expo-dev-menu",
	"expo-dev-menu-interface",
	"expo-updates",
	"expo-splash-screen",
]

const MAX_BUILD_ATTEMPTS = 6

export type NativePackage = {
	// The name autolinking uses. A local module under the app's modules/ is named after its directory.
	name: string
	// The name JS imports it by, from its package.json, which is what a mock has to be keyed by.
	jsName: string
	version: string
	// Where its podspec lives (inside the package for an npm module, modules/<name>/ios for a local one).
	dir: string
	// The package's root: what a JS import of it resolves into.
	root: string
	pods: string[]
	// An Expo module reaches its native half through globalThis.expo.modules, where a missing one can be stubbed
	// and the package's own JS kept; a React Native one cannot, so its JS is what gets mocked.
	kind: "expo" | "react-native"
}

export type NativeHost = {
	executable: string
	linked: NativePackage[]
	excluded: NativePackage[]
}

type Log = (line: string) => void

const hostDirOf = (project: Project) => path.join(project.root, "node_modules", ".cache", "simless", "native-host")

const learnedExcludesPath = (project: Project) => path.join(hostDirOf(project), "learned-exclude.json")

type LearnedExclude = { name: string; version: string }

// Modules an earlier build found do not compile for Catalyst, at the version that did not: an upgrade is tried again.
const readLearnedExcludes = (project: Project, packages: NativePackage[]): string[] => {
	try {
		const learned = JSON.parse(fs.readFileSync(learnedExcludesPath(project), "utf8")) as LearnedExclude[]
		return learned
			.filter(({ name, version }) => packages.some((pkg) => pkg.name === name && pkg.version === version))
			.map(({ name }) => name)
	} catch {
		return []
	}
}

type ExpoResolution = {
	modules: Array<{ packageName: string; packageVersion: string; pods?: Array<{ podName: string; podspecDir: string }> }>
}

type ReactNativeConfig = {
	dependencies: Record<string, { root: string; platforms?: { ios?: { podspecPath?: string } | null } }>
}

const autolinkingCli = (project: Project) => expoRequire(project.root).resolve("expo-modules-autolinking")

const versionOf = (dir: string) => {
	try {
		return (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string }).version ?? ""
	} catch {
		return ""
	}
}

// The names an Expo package's Swift modules register under: `Name("MyModule")` in a module definition, or the
// class name when there is none. What JS passes to requireNativeModule.
export const expoModuleNames = (pkg: NativePackage): string[] => {
	const names = new Set<string>()
	if (!pkg.dir || !fs.existsSync(pkg.dir)) {
		return []
	}
	for (const file of fs.globSync("**/*.swift", { cwd: pkg.dir })) {
		const source = fs.readFileSync(path.join(pkg.dir, file), "utf8")
		if (!source.includes("ModuleDefinition")) {
			continue
		}
		for (const match of source.matchAll(/^\s*Name\("([^"]+)"\)/gm)) {
			names.add(match[1] ?? "")
		}
		for (const match of source.matchAll(/class\s+(\w+)\s*:\s*Module\b/g)) {
			names.add(match[1] ?? "")
		}
	}
	return [...names].filter(Boolean)
}

// The nearest package.json above a pod's directory, short of the project's own.
const jsNameOf = (dir: string, projectRoot: string): string | undefined => {
	for (let current = dir; current?.startsWith(projectRoot) && current !== projectRoot; ) {
		try {
			return (JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: string }).name
		} catch {
			current = path.dirname(current)
		}
	}
	return undefined
}

// The directory holding the package.json above a pod, or for a local module without one (modules/<name>/ios),
// the module's own directory.
const packageRootOf = (podspecDir: string, projectRoot: string): string => {
	for (
		let current = podspecDir;
		current.startsWith(projectRoot) && current !== projectRoot;
		current = path.dirname(current)
	) {
		if (fs.existsSync(path.join(current, "package.json"))) {
			return current
		}
	}
	return ["ios", "apple"].includes(path.basename(podspecDir)) ? path.dirname(podspecDir) : podspecDir
}

// What the project's own autolinking would put in an iOS build, minus `exclude`: Expo modules, and the React
// Native packages Expo's autolinking finds alongside them.
export const resolveNativePackages = (project: Project, exclude: string[]): NativePackage[] => {
	const packages = new Map<string, NativePackage>()
	const output = execFileSync(
		process.execPath,
		[
			"--no-warnings",
			"--eval",
			`require(${JSON.stringify(autolinkingCli(project))})(process.argv.slice(1))`,
			"resolve",
			"--platform",
			"apple",
			"--json",
			"--project-root",
			project.root,
			...(exclude.length > 0 ? ["--exclude", ...exclude] : []),
		],
		{ cwd: project.root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	)
	for (const module of (JSON.parse(output) as ExpoResolution).modules) {
		const pods = module.pods ?? []
		packages.set(module.packageName, {
			name: module.packageName,
			jsName: jsNameOf(pods[0]?.podspecDir ?? "", project.root) ?? module.packageName,
			version: module.packageVersion,
			dir: pods[0]?.podspecDir ?? "",
			root: packageRootOf(pods[0]?.podspecDir ?? "", project.root),
			kind: "expo",
			pods: pods.map((pod) => pod.podName),
		})
	}
	const configScript = path.join(NATIVE_ROOT, "native-host", "react-native-config.cjs")
	const config = JSON.parse(
		execFileSync(process.execPath, [configScript, project.root, JSON.stringify(exclude), hostDirOf(project)], {
			cwd: project.root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		}),
	) as ReactNativeConfig
	for (const [name, dependency] of Object.entries(config.dependencies)) {
		const podspec = dependency.platforms?.ios?.podspecPath
		if (!podspec || packages.has(name)) {
			continue
		}
		packages.set(name, {
			name,
			jsName: name,
			version: versionOf(dependency.root),
			dir: dependency.root,
			root: dependency.root,
			pods: [path.basename(podspec, ".podspec")],
			kind: "react-native",
		})
	}
	return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const fill = (template: string, values: Record<string, string>) =>
	Object.entries(values).reduce((text, [key, value]) => text.replaceAll(key, value), template)

const writeHostProject = async (project: Project, exclude: string[]) => {
	const hostDir = hostDirOf(project)
	const sourcesDir = path.join(hostDir, "SimlessHost")
	fs.rmSync(path.join(hostDir, "SimlessHost.xcodeproj"), { recursive: true, force: true })
	fs.rmSync(sourcesDir, { recursive: true, force: true })
	fs.mkdirSync(sourcesDir, { recursive: true })
	for (const source of HOST_SOURCES) {
		fs.copyFileSync(source, path.join(sourcesDir, path.basename(source)))
	}
	const plist = fs
		.readFileSync(path.join(NATIVE_ROOT, "Info.plist"), "utf8")
		.replaceAll("$(BUNDLE_IDENTIFIER)", "com.alivelabs.simless.native")
	fs.writeFileSync(path.join(sourcesDir, "Info.plist"), plist)
	const podfile = fill(fs.readFileSync(path.join(NATIVE_ROOT, "native-host", "Podfile.template"), "utf8"), {
		__PROJECT_ROOT__: JSON.stringify(project.root),
		__EXCLUDE__: JSON.stringify(exclude),
		__CONFIG_SCRIPT__: JSON.stringify(path.join(NATIVE_ROOT, "native-host", "react-native-config.cjs")),
		__CATALYST_SHIMS__: JSON.stringify(path.join(NATIVE_ROOT, "native-host", "catalyst-shims")),
	})
	fs.writeFileSync(path.join(hostDir, "Podfile"), podfile)
	// Read by Expo's autolinking from the Podfile's directory.
	fs.writeFileSync(
		path.join(hostDir, "Podfile.properties.json"),
		JSON.stringify({ "expo.jsEngine": "hermes", newArchEnabled: "true" }),
	)
	await runOrThrow("ruby", [path.join(NATIVE_ROOT, "native-host", "create_project.rb"), hostDir])
}

const podEnv = (project: Project) => ({
	...process.env,
	// Expo's build scripts find the app from here; without it they fall back to two levels above Pods/, which
	// for the host is the cache directory.
	PROJECT_ROOT: project.root,
	LANG: process.env.LANG ?? "en_US.UTF-8",
	RCT_NEW_ARCH_ENABLED: "1",
	CI: "1",
	COCOAPODS_DISABLE_STATS: "true",
})

// Excluding a package breaks every pod that depends on one of its pods, which CocoaPods reports as
// "Unable to find a specification for `SomeCore` depended upon by `SomeModule`".
const orphanedPods = (output: string) => [
	...new Set([...output.matchAll(/depended upon by `([^`]+)`/g)].map((match) => match[1] ?? "")),
]

// Only the summary xcodebuild prints at the end names the pods that failed; warnings carry the same
// `(in target '…' from project 'Pods')` suffix throughout the log.
const failedPods = (output: string) => {
	const start = output.lastIndexOf("The following build commands failed:")
	if (start < 0) {
		return []
	}
	// Compiles only: a failed script phase, libtool or link step is a build problem, not a module that does not
	// exist on Catalyst, and excluding its pod would hide it.
	const compiles = output
		.slice(start)
		.split("\n")
		.filter((line) => /^\s*(SwiftCompile|CompileC|SwiftEmitModule|SwiftDriver|CompileSwift)\b/.test(line))
		.join("\n")
	return [
		...new Set([...compiles.matchAll(/\(in target '([^']+)' from project 'Pods'\)/g)].map((match) => match[1] ?? "")),
	]
}

const packageOfPod = (packages: NativePackage[], pod: string) =>
	packages.find((pkg) => pkg.pods.some((name) => pod === name || pod.startsWith(`${name}-`)))

const buildHost = async (
	project: Project,
	exclude: string[],
	linked: NativePackage[],
	attempt: number,
	log: Log,
	verbose: boolean,
) => {
	const hostDir = hostDirOf(project)
	// One log per attempt: a retry would otherwise overwrite the error that caused it.
	const logPath = path.join(hostDir, `build-${attempt}.log`)
	await writeHostProject(project, exclude)
	log("Installing pods for the native host…")
	const install = () => run("pod", ["install"], { cwd: hostDir, env: podEnv(project), inherit: verbose })
	let pods = await install()
	// After the first install, because a podspec may copy its prebuilt binaries into place during it (Skia does);
	// then again, because CocoaPods writes the slices it found into the copy script it generates.
	if (
		pods.code === 0 &&
		(await addMissingCatalystSlices(
			linked.map((pkg) => pkg.dir),
			log,
		)) > 0
	) {
		pods = await install()
	}
	fs.writeFileSync(logPath, `${pods.stdout}\n${pods.stderr}`)
	if (pods.code !== 0) {
		return { ok: false, stage: "pod install", output: `${pods.stdout}\n${pods.stderr}`, app: "", logPath }
	}
	log("Compiling the project's native modules for Mac Catalyst (once, then only when they change)…")
	const build = await run(
		"xcodebuild",
		[
			"-workspace",
			"SimlessHost.xcworkspace",
			"-scheme",
			"SimlessHost",
			"-configuration",
			"Release",
			"-destination",
			"generic/platform=macOS,variant=Mac Catalyst",
			"-derivedDataPath",
			"DerivedData",
			// React Native's prebuilt React.framework is unsigned, so signing the bundle fails; the linker already
			// signs the executable ad hoc, which is all a local arm64 run needs.
			"CODE_SIGNING_ALLOWED=NO",
			"COMPILER_INDEX_STORE_ENABLE=NO",
			// The host only ever runs here.
			"ARCHS=arm64",
			"ONLY_ACTIVE_ARCH=YES",
			"build",
		],
		{ cwd: hostDir, env: podEnv(project), inherit: verbose },
	)
	fs.appendFileSync(logPath, `${build.stdout}\n${build.stderr}`)
	return {
		ok: build.code === 0,
		stage: "xcodebuild",
		output: `${build.stdout}\n${build.stderr}`,
		app: path.join(hostDir, "DerivedData", "Build", "Products", "Release-maccatalyst", "SimlessHost.app"),
		logPath,
	}
}

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

// Two renders in one project would otherwise build into the same directory at once. The lock is a directory
// (mkdir is atomic) holding the owner's pid, so one left by a killed run is taken over.
const withBuildLock = async <T>(project: Project, log: Log, work: () => Promise<T>): Promise<T> => {
	const lock = path.join(hostDirOf(project), ".lock")
	fs.mkdirSync(path.dirname(lock), { recursive: true })
	let waiting = false
	for (;;) {
		try {
			fs.mkdirSync(lock)
			fs.writeFileSync(path.join(lock, "pid"), String(process.pid))
			break
		} catch {
			const owner = Number(fs.readFileSync(path.join(lock, "pid"), { encoding: "utf8", flag: "a+" }))
			// No pid yet means the owner is between mkdir and writing it, unless that was a while ago.
			const ageMs = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0)
			if (owner ? !isAlive(owner) : ageMs > 5000) {
				fs.rmSync(lock, { recursive: true, force: true })
				continue
			}
			if (!waiting) {
				log(`Waiting for another simless run (pid ${owner}) to finish building the native host…`)
				waiting = true
			}
			await new Promise((resolve) => setTimeout(resolve, 1000))
		}
	}
	try {
		return await work()
	} finally {
		fs.rmSync(lock, { recursive: true, force: true })
	}
}

export const ensureNativeHost = (
	project: Project,
	configuredExclude: string[],
	options: { log: Log; verbose: boolean },
): Promise<NativeHost> =>
	withBuildLock(project, options.log, () => buildNativeHost(project, configuredExclude, options))

const buildNativeHost = async (
	project: Project,
	configuredExclude: string[],
	options: { log: Log; verbose: boolean },
): Promise<NativeHost> => {
	const { log, verbose } = options
	const all = resolveNativePackages(project, [])
	// Either name works in the config; autolinking wants its own, and is also handed the JS one.
	const autolinkingName = (name: string) => all.find((pkg) => pkg.jsName === name)?.name ?? name
	let exclude = [
		...new Set(
			[...DEFAULT_NATIVE_EXCLUDE, ...configuredExclude, ...readLearnedExcludes(project, all)].map(autolinkingName),
		),
	]
	const fingerprint = await nativeFingerprint(project.root)
	const result = (executable: string): NativeHost => ({
		executable,
		linked: all.filter((pkg) => !exclude.includes(pkg.name)),
		excluded: all.filter((pkg) => exclude.includes(pkg.name)),
	})
	let cleanRetried = false
	for (let attempt = 1; ; attempt += 1) {
		const linked = all.filter((pkg) => !exclude.includes(pkg.name))
		const key = hashOf([
			fingerprint,
			await toolchainVersion(),
			JSON.stringify(exclude),
			...[...HOST_SOURCES, ...TEMPLATES].map((file) => fs.readFileSync(file)),
		])
		const appPath = path.join(cacheRoot(), "native", `SimlessHost-${key}.app`)
		const executable = path.join(appPath, "Contents", "MacOS", "SimlessHost")
		if (fs.existsSync(executable)) {
			await applyInfoPlist(appPath, project.appConfig)
			return result(executable)
		}

		const build = await buildHost(project, exclude, linked, attempt, log, verbose)
		if (build.ok) {
			await buildAtomically(appPath, async (scratch) => {
				await runOrThrow("ditto", [build.app, scratch])
				await recordHostInfoPlist(scratch)
			})
			await applyInfoPlist(appPath, project.appConfig)
			return result(executable)
		}

		const culprits = (build.stage === "pod install" ? orphanedPods(build.output) : failedPods(build.output))
			.map((pod) => packageOfPod(linked, pod)?.name)
			.filter((name): name is string => Boolean(name))
		const fresh = [...new Set(culprits)].filter((name) => !exclude.includes(name))
		if (fresh.length === 0 || attempt >= MAX_BUILD_ATTEMPTS) {
			const lines = build.output.split("\n")
			const summaryStart = lines.findLastIndex((line) => line.startsWith("The following build commands failed"))
			const errors = [
				...lines.filter((line) => /error:|^\[!\] (?!.*script phase)/.test(line)).slice(0, 20),
				...(summaryStart >= 0 ? lines.slice(summaryStart, summaryStart + 12) : []),
			]
				.map((line) => line.slice(0, 300))
				.join("\n")
			throw new Error(
				`The native host did not build: ${build.stage} failed (full log: ${build.logPath}).\n${errors}\n` +
					"Exclude the module that fails in simless.config.ts (native: { exclude: [...] }).",
			)
		}
		// An incremental build can fail for reasons of its own (a header map half rewritten by another run, a moved
		// package), which would leave out a module that builds fine. Only a failure a clean build repeats counts.
		const derivedData = path.join(hostDirOf(project), "DerivedData")
		if (build.stage === "xcodebuild" && !cleanRetried && fs.existsSync(derivedData)) {
			cleanRetried = true
			log(`The build failed in ${fresh.join(", ")}; trying once more from a clean build before leaving anything out`)
			fs.rmSync(derivedData, { recursive: true, force: true })
			continue
		}
		log(
			build.stage === "pod install"
				? `Left out because they depend on a module that was: ${fresh.join(", ")}`
				: `Not built for Mac Catalyst, so mocked instead: ${fresh.join(", ")}`,
		)
		exclude = [...exclude, ...fresh]
		const learned: LearnedExclude[] = exclude
			.filter((name) => !DEFAULT_NATIVE_EXCLUDE.includes(name) && !configuredExclude.includes(name))
			.map((name) => ({ name, version: all.find((pkg) => pkg.name === name)?.version ?? "" }))
		fs.writeFileSync(learnedExcludesPath(project), JSON.stringify(learned, null, "\t"))
	}
}

export const cocoapodsAvailable = async () => (await run("pod", ["--version"]).catch(() => ({ code: 1 }))).code === 0
