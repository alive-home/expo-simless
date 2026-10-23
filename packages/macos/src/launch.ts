import fs from "node:fs"
import path from "node:path"
import type { HostLaunch, HostLaunchOptions } from "@alivelabs/expo-simless/renderer"

// How to start a Catalyst host on a plan, in a home of its own.
export const launchHost = (
	executable: string,
	plan: string,
	{ locale, home, timeZone }: HostLaunchOptions,
): HostLaunch => {
	fs.mkdirSync(path.join(home, "Library", "Application Support"), { recursive: true })
	return {
		command: executable,
		// Foundation, Hermes' Intl and SwiftUI all take the process locale from these.
		args: [
			"--plan",
			plan,
			...(locale ? ["-AppleLanguages", `(${locale})`, "-AppleLocale", locale.replace("-", "_")] : []),
		],
		// Where Foundation keeps an app's files (AsyncStorage, user defaults), so the host's are its own.
		// TZ is the zone Foundation and Hermes both read.
		env: { ...process.env, CFFIXED_USER_HOME: home, HOME: home, ...(timeZone ? { TZ: timeZone } : {}) },
	}
}
