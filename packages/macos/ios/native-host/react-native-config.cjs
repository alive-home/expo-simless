// Prints the React Native autolinking config Expo's autolinking makes for the project, the JSON
// `use_native_modules!` reads, minus the excluded packages and with the iOS source directory moved to the host,
// which use_native_modules! makes pod paths relative to. Usage: node react-native-config.cjs <projectRoot>
// <excludeJson> <hostDir>
const { execFileSync } = require("node:child_process")
const { createRequire } = require("node:module")
const path = require("node:path")

const [projectRoot, excludeJson, hostDir] = process.argv.slice(2)
const exclude = new Set(JSON.parse(excludeJson))
const projectRequire = createRequire(path.join(projectRoot, "package.json"))
const autolinking = projectRequire.resolve("expo-modules-autolinking", {
	paths: [projectRequire.resolve("expo/package.json")],
})

const config = JSON.parse(
	execFileSync(
		process.execPath,
		[
			"--no-warnings",
			"--eval",
			`require(${JSON.stringify(autolinking)})(process.argv.slice(1))`,
			"react-native-config",
			"--json",
			"--platform",
			"ios",
		],
		{ cwd: projectRoot, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
	),
)
for (const name of Object.keys(config.dependencies ?? {})) {
	if (exclude.has(name)) {
		delete config.dependencies[name]
	}
}
config.project = { ...config.project, ios: { ...config.project?.ios, sourceDir: hostDir } }
process.stdout.write(JSON.stringify(config))
