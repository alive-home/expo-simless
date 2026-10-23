import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runOrThrow } from "expo-simless/renderer"

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const NATIVE_ROOT = path.join(PACKAGE_ROOT, "ios")

// iOS 17 is the first with UITraitOverrides, which the capture uses to set idiom, size class and scale.
export const CATALYST_TARGET = "arm64-apple-ios17.0-macabi"

// The iOS version this Mac's Mac Catalyst runs (macOS 26 runs iOS 26, 15 ran 18, 14 ran 17). Swift a user hands
// to the SwiftUI host is compiled for it, so it can use everything the Mac's UIKit has.
export const hostCatalystTarget = async (): Promise<string> => {
	const macOS = Number((await runOrThrow("sw_vers", ["-productVersion"])).stdout.trim().split(".")[0])
	const iOS = macOS >= 26 ? macOS : macOS + 3
	return `arm64-apple-ios${Math.max(iOS, 17)}.0-macabi`
}

export const macSdkPath = async (): Promise<string> =>
	(await runOrThrow("xcrun", ["--sdk", "macosx", "--show-sdk-path"])).stdout.trim()

export const toolchainVersion = async (): Promise<string> =>
	(await runOrThrow("xcrun", ["clang", "--version"])).stdout.split("\n")[0] ?? ""

export const writeInfoPlist = (appPath: string, executable: string, bundleIdentifier: string) => {
	const template = fs.readFileSync(path.join(NATIVE_ROOT, "Info.plist"), "utf8")
	const plist = template
		.replaceAll("$(EXECUTABLE_NAME)", executable)
		.replaceAll("$(BUNDLE_IDENTIFIER)", bundleIdentifier)
	fs.mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true })
	fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), plist)
}

export const compileCapture = async (sdk: string, output: string) => {
	await runOrThrow("xcrun", [
		"clang",
		"-c",
		"-fobjc-arc",
		"-fmodules",
		"-target",
		CATALYST_TARGET,
		"-isysroot",
		sdk,
		"-iframework",
		path.join(sdk, "System/iOSSupport/System/Library/Frameworks"),
		path.join(NATIVE_ROOT, "shared", "SMLCapture.m"),
		"-o",
		output,
	])
}
