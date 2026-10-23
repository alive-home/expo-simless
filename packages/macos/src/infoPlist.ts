import fs from "node:fs"
import path from "node:path"
import { type AppConfig, hashOf, runOrThrow } from "@alivelabs/expo-simless/renderer"

// The host's own: its identity, the way it launches and runs as a hidden iPad-idiom Catalyst app, and keys that
// name files only the real app bundle has (a launch storyboard, embedded fonts, which the host registers itself).
// The appearance is the render's.
const HOST_KEYS = new Set([
	"CFBundleDevelopmentRegion",
	"CFBundleExecutable",
	"CFBundleIdentifier",
	"CFBundleInfoDictionaryVersion",
	"CFBundleName",
	"CFBundlePackageType",
	"CFBundleSignature",
	"LSBackgroundOnly",
	"LSMinimumSystemVersion",
	"LSRequiresIPhoneOS",
	"LSUIElement",
	"RCTMetroPort",
	"UIAppFonts",
	"UIApplicationSceneManifest",
	"UIBackgroundModes",
	"UIDeviceFamily",
	"UILaunchStoryboardName",
	"UIRequiredDeviceCapabilities",
	"UISupportedInterfaceOrientations",
	"UISupportedInterfaceOrientations~ipad",
	"UIUserInterfaceStyle",
])

// Kept beside the built host's Info.plist, which applyInfoPlist rewrites.
export const HOST_INFO_PLIST = "simless-host-info.json"

// Gives a built host the app's Info.plist, as its config plugins made it, under the host's own keys: modules that
// read their settings from it (URL schemes, API keys, the app's version) find what they find in the app. The host
// is unsigned, so the file can change without a rebuild.
export const applyInfoPlist = async (appPath: string, config: AppConfig) => {
	const contents = path.join(appPath, "Contents")
	if (!fs.existsSync(path.join(contents, HOST_INFO_PLIST))) {
		await recordHostInfoPlist(appPath)
	}
	const host = JSON.parse(fs.readFileSync(path.join(contents, HOST_INFO_PLIST), "utf8")) as Record<string, unknown>
	const app = Object.fromEntries(Object.entries(config.ios?.infoPlist ?? {}).filter(([key]) => !HOST_KEYS.has(key)))
	const merged = JSON.stringify({ ...host, ...app })
	const marker = path.join(contents, "simless-info.hash")
	const hash = hashOf([merged])
	if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === hash) {
		return
	}
	// Renamed into place, so another run starting the host meanwhile reads the old file or the new one.
	const json = path.join(contents, `Info.${process.pid}.json`)
	const plist = path.join(contents, `Info.${process.pid}.plist`)
	fs.writeFileSync(json, merged)
	await runOrThrow("plutil", ["-convert", "xml1", "-o", plist, json])
	fs.rmSync(json)
	fs.renameSync(plist, path.join(contents, "Info.plist"))
	fs.writeFileSync(marker, hash)
}

// Saves the host's own Info.plist from a fresh build, as JSON, for applyInfoPlist to start from on every run.
export const recordHostInfoPlist = async (appPath: string) => {
	const contents = path.join(appPath, "Contents")
	const { stdout } = await runOrThrow("plutil", ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")])
	fs.writeFileSync(path.join(contents, HOST_INFO_PLIST), stdout)
}
