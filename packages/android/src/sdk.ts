import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cacheRoot, run } from "expo-simless/renderer"

export type SystemImage = {
	// The sdkmanager id, e.g. system-images;android-36;google_apis;arm64-v8a.
	id: string
	api: number
	tag: string
	abi: string
}

export type AndroidSdk = {
	root: string
	adb: string
	emulator: string
	avdmanager: string
	image: SystemImage
	javaHome: string
	abi: string
}

// The emulator's ABI that runs natively here: the host is built for it alone.
export const hostAbi = () => (process.arch === "arm64" ? "arm64-v8a" : "x86_64")

// Images whose adbd can run as root: the runner reads and writes the host's files and relaxes SELinux, which a
// Google Play image does not allow.
const ROOTABLE_TAGS = ["google_apis", "default"]

const sdkRoot = () =>
	[process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), "Library", "Android", "sdk")].find(
		(dir): dir is string => Boolean(dir && fs.existsSync(dir)),
	)

const pickSystemImage = (root: string, abi: string): SystemImage | null => {
	const images: SystemImage[] = []
	const base = path.join(root, "system-images")
	for (const platform of fs.existsSync(base) ? fs.readdirSync(base) : []) {
		const api = Number(/^android-(\d+)/.exec(platform)?.[1])
		if (!Number.isFinite(api)) {
			continue
		}
		for (const tag of ROOTABLE_TAGS) {
			if (fs.existsSync(path.join(base, platform, tag, abi, "system.img"))) {
				images.push({ id: `system-images;${platform};${tag};${abi}`, api, tag, abi })
			}
		}
	}
	images.sort((a, b) => b.api - a.api || ROOTABLE_TAGS.indexOf(a.tag) - ROOTABLE_TAGS.indexOf(b.tag))
	return images[0] ?? null
}

const javaHome = async (): Promise<string | null> => {
	const candidates = [
		process.env.JAVA_HOME,
		"/Applications/Android Studio.app/Contents/jbr/Contents/Home",
		(await run("/usr/libexec/java_home", ["-v", "17+"]).catch(() => null))?.stdout.trim(),
	]
	return candidates.find((dir): dir is string => Boolean(dir && fs.existsSync(path.join(dir, "bin", "java")))) ?? null
}

let found: Promise<AndroidSdk | string> | null = null

// The SDK, or what is missing from it, in words a person can act on.
export const findSdk = (): Promise<AndroidSdk | string> => {
	found ??= (async () => {
		const root = sdkRoot()
		if (!root) {
			return "@expo-simless/android needs the Android SDK: install Android Studio, or set ANDROID_HOME"
		}
		const abi = hostAbi()
		const adb = path.join(root, "platform-tools", "adb")
		const emulator = path.join(root, "emulator", "emulator")
		const avdmanager = [path.join(root, "cmdline-tools", "latest", "bin", "avdmanager")]
			.concat(
				fs.existsSync(path.join(root, "cmdline-tools"))
					? fs
							.readdirSync(path.join(root, "cmdline-tools"))
							.map((v) => path.join(root, "cmdline-tools", v, "bin", "avdmanager"))
					: [],
			)
			.find((file) => fs.existsSync(file))
		const missing = [
			fs.existsSync(adb) ? null : "platform-tools",
			fs.existsSync(emulator) ? null : "emulator",
			avdmanager ? null : "cmdline-tools;latest",
		].filter(Boolean)
		if (missing.length > 0) {
			return `The Android SDK at ${root} lacks ${missing.join(", ")}: sdkmanager ${missing.map((m) => `"${m}"`).join(" ")}`
		}
		const image = pickSystemImage(root, abi)
		if (!image) {
			return (
				`@expo-simless/android needs an emulator image it can run as root (google_apis or default, ${abi}): ` +
				`sdkmanager "system-images;android-36;google_apis;${abi}"`
			)
		}
		const java = await javaHome()
		if (!java) {
			return "@expo-simless/android builds its host with Gradle, which needs a JDK 17 or later: set JAVA_HOME"
		}
		return { root, adb, emulator, avdmanager: avdmanager ?? "", image, javaHome: java, abi }
	})()
	return found
}

export const androidCacheDir = () => path.join(cacheRoot(), "android")

// Where simless keeps its own emulator, apart from the person's Android Studio emulators.
export const avdHome = () => path.join(androidCacheDir(), "avd")

export const sdkEnv = (sdk: AndroidSdk): NodeJS.ProcessEnv => ({
	...process.env,
	ANDROID_HOME: sdk.root,
	ANDROID_SDK_ROOT: sdk.root,
	ANDROID_AVD_HOME: avdHome(),
	JAVA_HOME: sdk.javaHome,
})
