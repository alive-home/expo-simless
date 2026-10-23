import fs from "node:fs"
import { registerHooks } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { SimlessConfig } from "../runtime/index.js"
import { type AppConfig, appFonts, lockedAppearanceOf, readAppConfig } from "./expo.ts"

// Public, so a project's simless.config.ts can type itself: `export default { ... } satisfies SimlessConfig`.
export type { SimlessConfig }

export type Project = {
	root: string
	config: SimlessConfig
	configPath: string | null
	// The Expo config after its plugins have run.
	appConfig: AppConfig
	// The app's `userInterfaceStyle` when it locks one: such an app is never drawn in the other on a phone.
	lockedAppearance: "light" | "dark" | null
}

// A .ts config is loaded by Node's own type stripping, so it may only use erasable syntax (types, not enums).
const CONFIG_FILES = [
	"simless.config.ts",
	"simless.config.mts",
	"simless.config.cts",
	"simless.config.js",
	"simless.config.mjs",
	"simless.config.cjs",
	"simless.config.json",
]

type PackageJson = {
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	version?: string
}

const readPackageJson = (file: string): PackageJson => JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson

const dependsOn = (pkg: PackageJson, name: string) => Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])

// The nearest package.json above `start` that depends on expo.
export const findProjectRoot = (start: string): string => {
	let directory = fs.statSync(start).isDirectory() ? start : path.dirname(start)
	for (;;) {
		const manifest = path.join(directory, "package.json")
		if (fs.existsSync(manifest) && dependsOn(readPackageJson(manifest), "expo")) {
			return directory
		}
		const parent = path.dirname(directory)
		if (parent === directory) {
			throw new Error(`No Expo app above ${start} (a package.json that depends on expo). Pass --project <dir>.`)
		}
		directory = parent
	}
}

// The "type" of the nearest package.json, which decides how Node reads a .ts or .js file.
const packageTypeOf = (file: string): string | null => {
	for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
		const packageJson = path.join(directory, "package.json")
		if (fs.existsSync(packageJson)) {
			return (JSON.parse(fs.readFileSync(packageJson, "utf8")) as { type?: string }).type ?? null
		}
		if (path.dirname(directory) === directory) {
			return null
		}
	}
}

// An app's package.json seldom sets "type", and Node then reads an `export default` config as CommonJS first and warns
// before it falls back to ESM. A config there is loaded as the ES module it is; an explicit "commonjs" is left alone.
const importConfig = async (file: string): Promise<unknown> => {
	const url = pathToFileURL(file).href
	const extension = path.extname(file)
	if (![".ts", ".js"].includes(extension) || packageTypeOf(file) !== null) {
		return import(url)
	}
	const format = extension === ".ts" ? "module-typescript" : "module"
	const hooks = registerHooks({
		resolve: (specifier, context, nextResolve) => {
			const resolved = nextResolve(specifier, context)
			return resolved.url === url ? { ...resolved, format } : resolved
		},
	})
	try {
		return await import(url)
	} finally {
		hooks.deregister()
	}
}

const loadConfig = async (root: string): Promise<{ config: SimlessConfig; configPath: string | null }> => {
	for (const name of CONFIG_FILES) {
		const file = path.join(root, name)
		if (!fs.existsSync(file)) {
			continue
		}
		if (name.endsWith(".json")) {
			return { config: JSON.parse(fs.readFileSync(file, "utf8")) as SimlessConfig, configPath: file }
		}
		const loaded = (await importConfig(file)) as { default?: SimlessConfig }
		return { config: loaded.default ?? (loaded as SimlessConfig), configPath: file }
	}
	return { config: {}, configPath: null }
}

export const loadProject = async (root: string): Promise<Project> => {
	if (!dependsOn(readPackageJson(path.join(root, "package.json")), "expo")) {
		throw new Error(`${root} is not an Expo app: its package.json does not depend on expo.`)
	}
	const { config, configPath } = await loadConfig(root)
	const appConfig = await readAppConfig(root)
	return { root, config, configPath, appConfig, lockedAppearance: lockedAppearanceOf(appConfig) }
}

export const resolveFonts = (project: Project, extra: string[]): string[] => {
	// The app's own, from the expo-font config plugin, then any the config or the command line adds.
	const patterns = [...appFonts(project.appConfig), ...(project.config.fonts ?? []), ...extra]
	const files = patterns.flatMap((pattern) =>
		fs.globSync(pattern, { cwd: project.root }).map((match) => path.resolve(project.root, match)),
	)
	return [...new Set(files)]
}
