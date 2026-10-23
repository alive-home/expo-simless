import type { Renderer } from "expo-simless/renderer"
import { DEFAULT_DEVICE, DEVICES } from "./devices.ts"
import { launchHost } from "./launch.ts"
import { cocoapodsAvailable, ensureNativeHost, expoModuleNames } from "./nativeHost.ts"
import { renderSwiftUI } from "./swiftui.ts"

// Draws with the iOS UIKit a Mac runs through Mac Catalyst, in a host built from the app's own native modules.
export const renderer: Renderer = {
	name: "macos",
	platform: "ios",
	devices: DEVICES,
	defaultDevice: DEFAULT_DEVICE,
	unavailable: async () =>
		process.platform === "darwin" ? null : "@expo-simless/macos renders through Mac Catalyst, so it only runs on macOS",
	prepare: async (project, { log, verbose }) => {
		// The host is built with the app's own native modules, which CocoaPods links as it does for the app.
		if (!(await cocoapodsAvailable())) {
			throw new Error("simless builds its host with CocoaPods, as an Expo iOS build does: brew install cocoapods")
		}
		const host = await ensureNativeHost(project, project.config.native?.exclude ?? [], { log, verbose })
		return {
			linked: host.linked.map((pkg) => pkg.jsName),
			excluded: host.excluded
				.filter((pkg) => pkg.kind === "react-native")
				.map((pkg) => ({ name: pkg.jsName, dir: pkg.root })),
			stubbedNativeModules: host.excluded.filter((pkg) => pkg.kind === "expo").flatMap(expoModuleNames),
			launch: (plan, options) => launchHost(host.executable, plan, options),
		}
	},
	renderSwiftUI,
}
