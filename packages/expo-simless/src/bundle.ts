import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { KEEP_MARKER, projectCacheDir, pruneStaleRuns } from "./cache.ts"
import { expoRequire } from "./expo.ts"
import { NODE, PACKAGE_ROOT, runOrThrow } from "./process.ts"
import type { Project } from "./project.ts"
import type { Platform } from "./renderer.ts"

// A component file and the export to render, for `simless render`.
export type ComponentTarget = {
	file: string
	exportName: string
}

// What a render script imports; it resolves to the runtime's copy in the work directory.
const PACKAGE_NAME = "@alivelabs/expo-simless"

export type BundleOptions = {
	// Packages whose native code is in the host, and ones left out of it, which get the generic stand-in unless the
	// project mocks them.
	nativeLinked: string[]
	nativeExcluded: Array<{ name: string; dir: string }>
	// Native modules a real build would have that the host does not, which get stubs; any other missing one stays
	// missing, as it is on an iPhone (an Android-only module).
	stubbedNativeModules: string[]
	platform: Platform
	// The moment `Date` starts at, in milliseconds since the epoch; undefined for the real time.
	clock?: number
	dev: boolean
	// Compile the bundle to Hermes bytecode, for a host whose Hermes would otherwise compile it at every start.
	bytecode: boolean
	verbose: boolean
	log: (line: string) => void
}

const METRO_CONFIG_FILES = ["metro.config.js", "metro.config.cjs", "metro.config.mjs", "metro.config.json"]

// Left out of every host, so they always need their stand-ins: a render never checks for an update, and waits for
// the app to hide its splash screen.
const BUILT_IN_MOCKS = ["expo-splash-screen", "expo-updates"]

const APP_PROVIDERS = [
	{ module: "react-native-safe-area-context", kind: "safeArea" },
	{ module: "react-native-gesture-handler", kind: "gestureHandler" },
]

// Relative and with forward slashes, because Metro resolves the entry's requires like any other module's.
const requirePath = (from: string, to: string) => {
	const relative = path.relative(from, to).split(path.sep).join("/")
	return relative.startsWith(".") ? relative : `./${relative}`
}

// A render script, and the group its renders are named under: none for a lone script, its path for a report's.
export type ScriptFile = {
	group: string
	file: string
}

const writeEntry = (workDir: string, project: Project, scripts: ScriptFile[], options: BundleOptions) => {
	// What an app renders at its root and a lone component expects above it, for the packages in the host: one left
	// out has no native views, so its provider would draw nothing.
	const linked = new Set(options.nativeLinked)
	const providers = APP_PROVIDERS.filter(({ module }) => linked.has(module)).map(
		({ module, kind }) => `\t\t{ kind: ${JSON.stringify(kind)}, load: () => require(${JSON.stringify(module)}) },`,
	)
	// Imports run in order: the registry and the clock, then the shims that read them, before any app or expo-* module
	// loads.
	const entry = [
		'import "./native-modules.js"',
		'import "./shims/clock.js"',
		'import "./shims/expo.js"',
		'import { __run } from "./index.js"',
		"",
		"__run({",
		"\tscripts: [",
		...scripts.map(
			({ group, file }) =>
				`\t\t{ group: ${JSON.stringify(group)}, load: () => require(${JSON.stringify(requirePath(workDir, file))}) },`,
		),
		"\t],",
		"\tproviders: [",
		...providers,
		"\t],",
		"})",
		"",
	].join("\n")
	const nativeModules = Object.entries(project.config.nativeModules ?? {}).map(
		([name, file]) =>
			`\t${JSON.stringify(name)}: () => require(${JSON.stringify(requirePath(workDir, path.resolve(project.root, file)))}),`,
	)
	fs.writeFileSync(
		path.join(workDir, "native-modules.js"),
		[
			"globalThis.__simlessNativeModules = {",
			...nativeModules,
			"}",
			`globalThis.__simlessStubbedModules = ${JSON.stringify(options.stubbedNativeModules)}`,
			`globalThis.__simlessClock = ${options.clock ?? "undefined"}`,
			"",
		].join("\n"),
	)
	const entryPath = path.join(workDir, "entry.js")
	fs.writeFileSync(entryPath, entry)
	return entryPath
}

// `simless render <file>#<export>`: a script rendering each component with no props.
export const writeComponentScript = (workDir: string, targets: ComponentTarget[]): string => {
	const lines = targets.map(({ file, exportName }) => {
		const name = exportName === "default" ? path.basename(file, path.extname(file)) : exportName
		const load = `require(${JSON.stringify(requirePath(workDir, file))})`
		const pick = exportName === "default" ? "(m.default ?? m)" : `m[${JSON.stringify(exportName)}]`
		return `\t{ name: ${JSON.stringify(name)}, file: ${JSON.stringify(file)}, exportName: ${JSON.stringify(exportName)}, load: () => { const m = ${load}; return ${pick} } },`
	})
	const source = [
		'import { createElement } from "react"',
		'import { render } from "./index.js"',
		"",
		"const targets = [",
		...lines,
		"]",
		"",
		"export default async () => {",
		"\tfor (const target of targets) {",
		"\t\tconst Target = target.load()",
		"\t\tif (Target == null) {",
		'\t\t\tthrow new Error(target.file + " has no export named " + target.exportName)',
		"\t\t}",
		"\t\tawait render(createElement(Target), { name: target.name })",
		"\t}",
		"}",
		"",
	].join("\n")
	const scriptPath = path.join(workDir, "components.render.js")
	fs.writeFileSync(scriptPath, source)
	return scriptPath
}

// A mock is a path relative to the project root, or a package specifier such as `react-native-reanimated/mock`.
const resolveMock = (project: Project, spec: string) => {
	if (spec.startsWith(".") || path.isAbsolute(spec)) {
		return path.resolve(project.root, spec)
	}
	return createRequire(path.join(project.root, "package.json")).resolve(spec)
}

const mockTable = (workDir: string, project: Project, options: BundleOptions): Record<string, string> => {
	const table: Record<string, string> = {}
	for (const name of BUILT_IN_MOCKS) {
		table[name] = path.join(workDir, "mocks", `${name}.js`)
	}
	for (const { name } of options.nativeExcluded) {
		table[name] ??= path.join(workDir, "mocks", "excluded.js")
	}
	for (const [name, spec] of Object.entries(project.config.mocks ?? {})) {
		table[name] = resolveMock(project, spec)
	}
	return table
}

// Wraps the project's own Metro config, so its transformer, aliases and serializer are untouched, and adds one
// thing: requests for a mocked module resolve to the mock. The mock itself still reaches the real module.
type Swap = { original: string; wrapper: string }

// Writes the runtime's stand-in for one of a dependency's own modules, pointed at the real one, for the Metro config
// to resolve in its place.
const swapFor = (workDir: string, original: string, wrapperName: string): Swap => {
	const wrapper = path.join(workDir, "mocks", wrapperName)
	const source = fs.readFileSync(wrapper, "utf8")
	fs.writeFileSync(wrapper, source.replace('"ORIGINAL"', JSON.stringify(requirePath(path.dirname(wrapper), original))))
	return { original: fs.realpathSync(original), wrapper }
}

// Where every expo-* package finds its native half; see shims/expo.js.
const moduleSwaps = (workDir: string, project: Project): Swap[] => {
	const core = expoRequire(project.root).resolve("expo-modules-core/package.json")
	return [
		swapFor(
			workDir,
			path.join(path.dirname(core), "build", "requireNativeModule.js"),
			"expo-modules-core-requireNativeModule.js",
		),
	]
}

// Mocks keyed by a project file's path (`./src/hooks/useClock.ts`) rather than a module name, by the file's real path.
const fileMockTable = (project: Project): Record<string, string> =>
	Object.fromEntries(
		Object.entries(project.config.mocks ?? {})
			.filter(([name]) => name.startsWith(".") || path.isAbsolute(name))
			.map(([name, spec]) => {
				const file = path.resolve(project.root, name)
				if (!fs.existsSync(file)) {
					throw new Error(`mocks names ${name}, which is not a file in the project`)
				}
				return [fs.realpathSync(file), resolveMock(project, spec)]
			}),
	)

const writeMetroConfig = (workDir: string, project: Project, options: BundleOptions) => {
	const existing = METRO_CONFIG_FILES.map((name) => path.join(project.root, name)).find((file) => fs.existsSync(file))
	const source = `const path = require("node:path")
const { pathToFileURL } = require("node:url")

const mocks = ${JSON.stringify(mockTable(workDir, project, options), null, "\t")}
// Project files mocked by path: whatever an import calls one (an alias, a relative path), it resolves to its mock.
const fileMocks = ${JSON.stringify(fileMockTable(project), null, "\t")}
// The render API a script imports: the copy next to the entry, so the script and the entry share one instance.
const api = ${JSON.stringify(path.join(workDir, "index.js"))}
// Packages left out of the native host, by directory: an import that resolves into one gets its mock even when
// it names the package some other way (a tsconfig path alias, a deep import).
const excluded = ${JSON.stringify(
		options.nativeExcluded.map(({ name, dir }) => ({ dir: `${dir}${path.sep}`, name })),
		null,
		"\t",
	)}
const stub = ${JSON.stringify(path.join(workDir, "mocks", "excluded.js"))}
// Every module resolved to a mock, one per line, for the CLI to report.
const mockLog = ${JSON.stringify(path.join(workDir, "mocks-used.txt"))}
const used = new Set()
const recordMock = (name, filePath) => {
	if (!used.has(name)) {
		used.add(name)
		require("node:fs").appendFileSync(mockLog, JSON.stringify([name, filePath]) + "\\n")
	}
	return { type: "sourceFile", filePath }
}
// Dependency modules the runtime stands in for, by resolved path.
const swaps = ${JSON.stringify(moduleSwaps(workDir, project), null, "\t")}
const projectConfig = ${JSON.stringify(existing ?? null)}

const loadBase = async (defaults) => {
	if (projectConfig) {
		const loaded = await import(pathToFileURL(projectConfig).href)
		const config = loaded.default ?? loaded
		return typeof config === "function" ? await config(defaults) : await config
	}
	const { getDefaultConfig } = require(require.resolve("expo/metro-config", { paths: [${JSON.stringify(project.root)}] }))
	return getDefaultConfig(${JSON.stringify(project.root)})
}

module.exports = async (defaults) => {
	const config = await loadBase(defaults)
	const upstream = config.resolver?.resolveRequest
	return {
		...config,
		resolver: {
			...config.resolver,
			resolveRequest(context, moduleName, platform) {
				if (moduleName === ${JSON.stringify(PACKAGE_NAME)}) {
					return { type: "sourceFile", filePath: api }
				}
				const mock = mocks[moduleName]
				if (mock && path.resolve(context.originModulePath) !== mock) {
					return recordMock(moduleName, mock)
				}
				const resolution = upstream
					? upstream(context, moduleName, platform)
					: context.resolveRequest(context, moduleName, platform)
				const origin = path.resolve(context.originModulePath)
				const fileMock = resolution?.type === "sourceFile" ? fileMocks[resolution.filePath] : undefined
				if (fileMock && origin !== fileMock) {
					return recordMock(resolution.filePath, fileMock)
				}
				const swap =
					resolution?.type === "sourceFile" &&
					swaps.find(({ original, wrapper }) => resolution.filePath === original && origin !== wrapper)
				if (swap) {
					return { type: "sourceFile", filePath: swap.wrapper }
				}
				const owner =
					resolution?.type === "sourceFile" &&
					excluded.find(({ dir }) => resolution.filePath.startsWith(dir) && !origin.startsWith(dir))
				return owner ? recordMock(owner.name, mocks[owner.name] ?? stub) : resolution
			},
		},
	}
}
`
	const configPath = path.join(workDir, "metro.config.cjs")
	fs.writeFileSync(configPath, source)
	return configPath
}

// The work directory sits in the project's node_modules so the generated entry resolves `react` and
// `react-native` (and the project's own modules) exactly as the app does. The runtime is copied in for the same
// reason.
// Work directories that earlier runs left behind when they were killed go first.
export const createWorkDir = (project: Project): string => {
	pruneStaleRuns(project.root)
	const workDir = path.join(projectCacheDir(project.root), `run-${process.pid}-${Date.now()}`)
	fs.mkdirSync(workDir, { recursive: true })
	fs.cpSync(path.join(PACKAGE_ROOT, "runtime"), workDir, { recursive: true })
	return workDir
}

// Deletes the work directory at the end of a run, or with --keep marks it to be kept.
export const releaseWorkDir = (workDir: string, keep: boolean | undefined, log: (line: string) => void) => {
	if (keep) {
		fs.writeFileSync(path.join(workDir, KEEP_MARKER), "")
		log(`Kept ${workDir}`)
	} else {
		fs.rmSync(workDir, { recursive: true, force: true })
	}
}

export type Bundle = {
	bundlePath: string
	sourceMapPath: string
	// For a bytecode bundle, from its bytecode offsets to the lines of the JavaScript that sourceMapPath maps.
	bytecodeMapPath?: string
	// Package name to the file that replaced it, for the packages the bundle actually imported.
	mocked: Record<string, string>
}

// React Native's Hermes compiler: in hermes-compiler since 0.83, in react-native/sdks before.
const findHermesc = (project: Project): string | null => {
	const platformDir = process.platform === "darwin" ? "osx-bin" : "linux64-bin"
	try {
		const reactNative = path.dirname(expoRequire(project.root).resolve("react-native/package.json"))
		const candidates = [path.join(reactNative, "sdks", "hermesc", platformDir, "hermesc")]
		try {
			const compiler = path.dirname(createRequire(reactNative + path.sep).resolve("hermes-compiler/package.json"))
			candidates.unshift(path.join(compiler, "hermesc", platformDir, "hermesc"))
		} catch {
			// An older React Native, with hermesc in its own sdks folder.
		}
		return candidates.find((file) => fs.existsSync(file)) ?? null
	} catch {
		return null
	}
}

// Replaces the bundle with its Hermes bytecode, which a host loads without parsing the source: about a second less
// at every render's start on an emulator. Unoptimized: optimizing takes seconds per run and gains no start time.
// Says where the bytecode's source map went, or nothing when the source stays (no hermesc found).
const compileBytecode = async (project: Project, bundlePath: string, workDir: string, options: BundleOptions) => {
	const hermesc = findHermesc(project)
	if (!hermesc) {
		if (options.verbose) {
			options.log("No hermesc in the project's React Native: the bundle stays JavaScript")
		}
		return undefined
	}
	const compiled = path.join(workDir, "main.hbc")
	await runOrThrow(hermesc, ["-emit-binary", "-O0", "-output-source-map", "-out", compiled, bundlePath])
	fs.renameSync(compiled, bundlePath)
	// Beside the source map, not in the bundle folder, which goes to the device.
	return `${compiled}.map`
}

// Bundles `script`, a module whose default export is an async function calling render(), with the runtime.
export const bundleScript = async (
	project: Project,
	scripts: ScriptFile[],
	workDir: string,
	options: BundleOptions,
): Promise<Bundle> => {
	const entry = writeEntry(workDir, project, scripts, options)
	const metroConfig = writeMetroConfig(workDir, project, options)
	const outDir = path.join(workDir, "bundle")
	fs.mkdirSync(outDir, { recursive: true })
	const bundlePath = path.join(outDir, "main.jsbundle")
	const sourceMapPath = path.join(workDir, "main.jsbundle.map")
	const common = [
		"--platform",
		options.platform,
		"--dev",
		String(options.dev),
		"--minify",
		"false",
		"--entry-file",
		entry,
		"--bundle-output",
		bundlePath,
		"--sourcemap-output",
		sourceMapPath,
		// Next to the bundle, which is where React Native looks for assets when it loads from a file.
		"--assets-dest",
		outDir,
	]
	options.log("Bundling with expo export:embed…")
	// export:embed accepts --config but never hands it to Metro; this override is the hook it does read (marked
	// internal in @expo/cli's instantiateMetro).
	await runOrThrow(NODE, [expoRequire(project.root).resolve("expo/bin/cli"), "export:embed", ...common], {
		cwd: project.root,
		env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_OVERRIDE_METRO_CONFIG: metroConfig },
		inherit: options.verbose,
	})
	const mockLog = path.join(workDir, "mocks-used.txt")
	const mocked = Object.fromEntries(
		(fs.existsSync(mockLog) ? fs.readFileSync(mockLog, "utf8") : "")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as [string, string]),
	)
	const bytecodeMapPath = options.bytecode ? await compileBytecode(project, bundlePath, workDir, options) : undefined
	return { bundlePath, sourceMapPath, bytecodeMapPath, mocked }
}
