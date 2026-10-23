import { createRequire } from "node:module"
import path from "node:path"
import { runOrThrow } from "./process.ts"

// The parts of `expo config --type introspect` this reads: the config after its plugins have run, as prebuild
// would write it.
export type AppConfig = {
	userInterfaceStyle?: string
	plugins?: Array<string | [string, unknown]>
	ios?: { userInterfaceStyle?: string; infoPlist?: Record<string, unknown> }
}

// Resolved through the project's own `expo`, so the CLI uses the versions its build would.
export const expoRequire = (root: string) => {
	const projectRequire = createRequire(path.join(root, "package.json"))
	return createRequire(projectRequire.resolve("expo/package.json"))
}

export const readAppConfig = async (root: string): Promise<AppConfig> => {
	const cli = expoRequire(root).resolve("expo/bin/cli")
	const { stdout } = await runOrThrow(process.execPath, [cli, "config", "--type", "introspect", "--json"], {
		cwd: root,
		env: { ...process.env, EXPO_NO_TELEMETRY: "1" },
	})
	return JSON.parse(stdout) as AppConfig
}

export const lockedAppearanceOf = (config: AppConfig): "light" | "dark" | null => {
	const style = config.ios?.userInterfaceStyle ?? config.userInterfaceStyle
	return style === "light" || style === "dark" ? style : null
}

type FontPluginOptions = { fonts?: string[]; ios?: { fonts?: string[] } }

// The files the expo-font config plugin embeds in the app, relative to the project root.
export const appFonts = (config: AppConfig): string[] =>
	(config.plugins ?? []).flatMap((plugin) => {
		if (!Array.isArray(plugin) || plugin[0] !== "expo-font") {
			return []
		}
		const options = (plugin[1] ?? {}) as FontPluginOptions
		return [...(options.fonts ?? []), ...(options.ios?.fonts ?? [])]
	})
