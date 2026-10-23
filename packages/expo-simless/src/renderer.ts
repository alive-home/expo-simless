import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Device } from "./devices.ts"
import type { Project } from "./project.ts"

// What a renderer package (@alivelabs/expo-simless-macos, @alivelabs/expo-simless-android) builds on. The CLI bundles the app's
// JavaScript, writes plans and reads results; a renderer builds the native host that runs them.

export type { Device, Insets } from "./devices.ts"
export { type AppConfig, expoRequire } from "./expo.ts"
export {
	buildAtomically,
	cacheRoot,
	hashOf,
	NODE,
	type RunOptions,
	type RunResult,
	run,
	runOrThrow,
} from "./process.ts"
export type { Project } from "./project.ts"

export type Appearance = "light" | "dark"

export type Platform = "ios" | "android"

// What every render of one run shares; a render's own options (render(element, { fit })) override these.
export type RenderDefaults = {
	background?: string
	settleMs: number
	timeoutMs: number
	fit: boolean
	padding: number
}

export type Variant = {
	device: Device
	appearance: Appearance
}

// What the host reports for one render, in the plan's result file.
export type JobResult = {
	id: string
	name: string
	output: string
	ok: boolean
	settled: boolean
	durationMs: number
	logs: string[]
	error?: string
	// The PNGs the render's `frames` option asked for, in order.
	frames?: string[]
}

export type HostLaunchOptions = {
	// A BCP 47 tag such as nl-NL, or undefined for the system's.
	locale?: string
	// An empty directory of the host's own: what one render saves is never read by another.
	home: string
	// An IANA zone such as Europe/Amsterdam, or undefined for the system's.
	timeZone?: string
}

export type HostLaunch = {
	command: string
	args: string[]
	env: NodeJS.ProcessEnv
}

export type NativeHost = {
	// Packages whose native code is in the host, and React Native ones left out of it, which the bundle stands in
	// for unless the project mocks them.
	linked: string[]
	excluded: Array<{ name: string; dir: string }>
	// Expo modules a real build would have that the host does not; the bundle stubs them.
	stubbedNativeModules: string[]
	// How to start the host on a plan. It writes the plan's result file and exits or, for an interactive plan,
	// runs until its window is closed.
	launch: (plan: string, options: HostLaunchOptions) => HostLaunch
}

export type RendererContext = {
	log: (line: string) => void
	verbose: boolean
}

// SwiftUI views on their own, with no React Native project.
export type SwiftUIRequest = {
	sources: string[]
	// Swift expressions producing a View, e.g. 'ProfileCard(name: "Ada")'.
	expressions: string[]
	variants: Variant[]
	outDir: string
	defaults: RenderDefaults
	fonts: string[]
	locale?: string
}

export type SwiftUIResult = JobResult & {
	device: string
	appearance: Appearance
}

export type Renderer = {
	name: string
	// What Metro bundles the app for.
	platform: Platform
	devices: Record<string, Device>
	defaultDevice: string
	// Why this machine cannot render, or null when it can.
	unavailable: () => Promise<string | null>
	prepare: (project: Project, context: RendererContext) => Promise<NativeHost>
	renderSwiftUI?: (request: SwiftUIRequest, context: RendererContext) => Promise<SwiftUIResult[]>
}

const RENDERER_PACKAGES: Record<Platform, string> = {
	ios: "@alivelabs/expo-simless-macos",
	android: "@alivelabs/expo-simless-android",
}

export const isPlatform = (value: string): value is Platform => value in RENDERER_PACKAGES

export const PLATFORMS = Object.keys(RENDERER_PACKAGES) as Platform[]

// The renderer package for a platform, which the project installs next to expo-simless, found from the project's
// directory (or the current one).
export const loadRenderer = async (platform: Platform, from = process.cwd()): Promise<Renderer> => {
	const name = RENDERER_PACKAGES[platform]
	let entry: string
	try {
		entry = createRequire(path.join(from, "package.json")).resolve(name)
	} catch {
		throw new Error(`Rendering for ${platform} needs ${name}: add it to the project's devDependencies`)
	}
	const loaded = (await import(pathToFileURL(entry).href)) as { renderer?: Renderer }
	if (!loaded.renderer) {
		throw new Error(`${name} exports no renderer`)
	}
	return loaded.renderer
}

// The renderer, once it has said it can run here.
export const loadAvailableRenderer = async (platform: Platform, from?: string): Promise<Renderer> => {
	const renderer = await loadRenderer(platform, from)
	const reason = await renderer.unavailable()
	if (reason) {
		throw new Error(reason)
	}
	return renderer
}
