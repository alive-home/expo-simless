import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expoRequire, type Project } from "expo-simless/renderer"

export type NativePackage = {
	// The name autolinking uses. A local module under the app's modules/ is named after its directory.
	name: string
	// The name JS imports it by, from its package.json, which is what a mock has to be keyed by.
	jsName: string
	version: string
	// The package's android directory, and its root: what a JS import of it resolves into.
	androidDir: string
	root: string
	// The Gradle projects it adds, which a failed build names.
	gradleProjects: string[]
	// An Expo module reaches its native half through globalThis.expo.modules, where a missing one can be stubbed
	// and the package's own JS kept; a React Native one cannot, so its JS is what gets mocked.
	kind: "expo" | "react-native"
}

type ExpoResolution = {
	modules: Array<{ packageName: string; packageVersion: string; projects?: Array<{ name: string; sourceDir: string }> }>
}

type ReactNativeConfig = {
	dependencies: Record<string, { root: string; platforms?: { android?: { sourceDir?: string } | null } }>
}

const autolinking = (project: Project, args: string[]) =>
	execFileSync(
		process.execPath,
		[
			"--no-warnings",
			"--eval",
			`require(${JSON.stringify(expoRequire(project.root).resolve("expo-modules-autolinking"))})(process.argv.slice(1))`,
			...args,
		],
		{ cwd: project.root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	)

const readJson = <T>(file: string): T | null => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T
	} catch {
		return null
	}
}

// The directory holding the nearest package.json above `dir`, short of the project's own.
const packageRootOf = (dir: string, projectRoot: string): string => {
	for (let current = dir; current.startsWith(projectRoot) && current !== projectRoot; current = path.dirname(current)) {
		if (fs.existsSync(path.join(current, "package.json"))) {
			return current
		}
	}
	return path.basename(dir) === "android" ? path.dirname(dir) : dir
}

// Every package the project's own autolinking would put in an Android build: Expo modules, and the React Native
// packages Expo's autolinking finds alongside them.
export const resolveNativePackages = (project: Project): NativePackage[] => {
	const packages = new Map<string, NativePackage>()
	const expo = JSON.parse(
		autolinking(project, ["resolve", "--platform", "android", "--json", "--project-root", project.root]),
	) as ExpoResolution
	for (const module of expo.modules) {
		const projects = module.projects ?? []
		const androidDir = projects[0]?.sourceDir ?? ""
		const root = packageRootOf(androidDir, project.root)
		packages.set(module.packageName, {
			name: module.packageName,
			jsName: readJson<{ name?: string }>(path.join(root, "package.json"))?.name ?? module.packageName,
			version: module.packageVersion,
			androidDir,
			root,
			gradleProjects: projects.map((entry) => entry.name),
			kind: "expo",
		})
	}
	const config = JSON.parse(
		autolinking(project, ["react-native-config", "--json", "--platform", "android", "--project-root", project.root]),
	) as ReactNativeConfig
	for (const [name, dependency] of Object.entries(config.dependencies ?? {})) {
		const sourceDir = dependency.platforms?.android?.sourceDir
		if (!sourceDir || packages.has(name)) {
			continue
		}
		packages.set(name, {
			name,
			jsName: name,
			version: readJson<{ version?: string }>(path.join(dependency.root, "package.json"))?.version ?? "",
			androidDir: sourceDir,
			root: dependency.root,
			// The React Native settings plugin names a library's project after the package, with / turned into _.
			gradleProjects: [name.replace(/\//g, "_")],
			kind: "react-native",
		})
	}
	return [...packages.values()]
}

// The names an Expo package's Kotlin modules register under: `Name("MyModule")` in a module definition, or the
// class name when there is none. What JS passes to requireNativeModule.
export const expoModuleNames = (pkg: NativePackage): string[] => {
	const names = new Set<string>()
	if (!pkg.androidDir || !fs.existsSync(pkg.androidDir)) {
		return []
	}
	for (const file of fs.globSync("**/*.kt", { cwd: pkg.androidDir })) {
		const source = fs.readFileSync(path.join(pkg.androidDir, file), "utf8")
		if (!source.includes("ModuleDefinition")) {
			continue
		}
		for (const match of source.matchAll(/^\s*Name\("([^"]+)"\)/gm)) {
			names.add(match[1] ?? "")
		}
		for (const match of source.matchAll(/class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*Module\(\)/g)) {
			names.add(match[1] ?? "")
		}
	}
	return [...names].filter(Boolean)
}
