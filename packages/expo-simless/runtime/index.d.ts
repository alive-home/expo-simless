import type { ReactElement } from "react"

export type RenderOptions = {
	/**
	 * The PNG's name, before the device and appearance: `<name>-<device>-<appearance>.png`. Defaults to the
	 * component's name; a repeated name gets -2, -3.
	 */
	name?: string
	/** Crop to the content's height, with no safe area: for components, not screens. */
	fit?: boolean
	/** Space around the content, in points. */
	padding?: number
	/** `#RRGGBB`, `#RRGGBBAA` or `"transparent"`. Defaults to the system background. */
	background?: string
	/** How long the view tree must stay unchanged before the capture, in milliseconds. */
	settleMs?: number
	/** How long the render may take, in milliseconds. */
	timeoutMs?: number
	/**
	 * Milliseconds after the render is ready at which to write a PNG each, before the settled one, to see an
	 * animation part-way: `[0, 100, 200, 400]` writes `<name>-<device>-<appearance>-100ms.png` and so on.
	 */
	frames?: number[]
}

export type RenderResult = {
	name: string
	/**
	 * True when this process does not perform the render: each runs in a process of its own unless `--shared`,
	 * and `--only` picks some.
	 */
	skipped?: boolean
	ok?: boolean
	output?: string
	error?: string
	/** False when the view tree was still changing when the capture was taken. */
	settled?: boolean
	/** The PNGs `frames` asked for, in order. */
	frames?: string[]
}

/** Renders `element` to a PNG and resolves once it is written. Renders run one at a time, so await each. */
export declare const render: (element: ReactElement, options?: RenderOptions) => Promise<RenderResult>

/** Holds the capture until `promise` settles, for setup a component starts when it mounts. */
export declare const waitFor: <T>(promise: Promise<T>) => Promise<T>

/**
 * `simless.config.ts` (or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json`) in the project root:
 *
 * ```ts
 * import type { SimlessConfig } from "@alivelabs/expo-simless"
 *
 * export default {
 * 	fonts: ["src/assets/fonts/*"],
 * } satisfies SimlessConfig
 * ```
 *
 * Paths are relative to the project root. The CLI's options override the defaults set here.
 */
export type SimlessConfig = {
	/**
	 * Font files to register in the host besides the app's own (those the expo-font config plugin embeds are
	 * registered already), so `fontFamily` resolves as it does in the app. Globs are allowed.
	 */
	fonts?: string[]
	/** JS module name to a file that replaces it in the bundle: a path, or a package specifier. */
	mocks?: Record<string, string>
	/**
	 * Native module name (what JS passes to `requireNativeModule`) to a file whose default export stands in for it,
	 * for a module the host lacks whose answers a component depends on. The package's own JS still runs on top.
	 */
	nativeModules?: Record<string, string>
	/**
	 * The host is built with the app's own native modules. `exclude` names packages to leave out, for modules that
	 * cannot build or run on a Mac; one that fails to compile for Mac Catalyst is left out without being named.
	 */
	native?: { exclude?: string[] }
	/** Device preset(s), comma separated, or `WIDTHxHEIGHT@SCALE`. Default `iphone-17-pro`. */
	device?: string
	appearance?: "light" | "dark" | "both"
	/** A BCP 47 tag such as `nl-NL`. Default: the Mac's. */
	locale?: string
	/**
	 * The moment `Date` starts at in every render, as an ISO date and time, e.g. `2026-10-21T14:30:00`; it runs on
	 * from there. Without an offset it is read in `timeZone`. Default: the real time, which changes every run.
	 */
	clock?: string
	/** An IANA time zone such as `Europe/Amsterdam`, for the clock and the app alike. Default: the Mac's. */
	timeZone?: string
	/** Default for every render: `#RRGGBB`, `#RRGGBBAA` or `"transparent"`. */
	background?: string
	/** Default for every render, in milliseconds. Default 150. */
	settleMs?: number
	/** Default for every render, in milliseconds. Default 15000. */
	timeoutMs?: number
	/** Default for every render: crop to the content, with no safe area. */
	fit?: boolean
	/** Default for every render, in points. */
	padding?: number
	/** What `simless report` renders, and on what. */
	report?: {
		/** Render scripts, as paths or globs relative to the project. Default `simless/**\/*.render.tsx` and kin. */
		renders?: string[]
		/**
		 * Device presets or `WIDTHxHEIGHT@SCALE`, e.g. a small, a medium and a large phone and an iPad. iOS and Android
		 * presets may be mixed (`iphone-17-pro`, `pixel-9`): each renders on its own platform, into one report.
		 */
		devices?: string[]
		appearance?: "light" | "dark" | "both"
	}
}
