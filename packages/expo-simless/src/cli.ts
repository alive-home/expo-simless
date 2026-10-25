import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import {
	bundleScript,
	type ComponentTarget,
	createWorkDir,
	releaseWorkDir,
	type ScriptFile,
	writeComponentScript,
} from "./bundle.ts"
import { type CleanScope, cleanCache, showCache } from "./cacheCommand.ts"
import { checkTimeZone, clockEpoch } from "./clock.ts"
import { type Device, resolveDevice } from "./devices.ts"
import { findProjectRoot, loadProject, type Project, resolveFonts, type SimlessConfig } from "./project.ts"
import {
	type Appearance,
	isPlatform,
	loadAvailableRenderer,
	loadRenderer,
	type NativeHost,
	PLATFORMS,
	type Platform,
	type RenderDefaults,
	type Renderer,
	type Variant,
} from "./renderer.ts"
import { prepareReportDir, writeReport } from "./report.ts"
import { listRenders, runScript, type ScriptOutcome } from "./script.ts"
import { showScript } from "./show.ts"
import { symbolicator } from "./symbolicate.ts"

const USAGE = `simless: render React Native components and SwiftUI views to PNG with real UIKit, no simulator.

Usage
  simless run <script> [options]               Run a render script: every render() it awaits is a PNG
  simless render <file>[#Export]... [options]  Render components that take no props
  simless report [script | folder]... [options] Run every render script into one report: index.html to look
                                                through, report.md for an LLM, report.json, and the PNGs
  simless show <script | file[#Export]> [options]
                                                Open one render in a window you can click, scroll and type in
  simless swiftui <file.swift>... [options]     Render SwiftUI views
  simless devices                               List device presets
  simless cache [clean [project | all]]         Show what simless caches and where, or remove it

A render script is a module whose default export is an async function:

  import { render } from "@alivelabs/expo-simless"

  export default async () => {
    await render(<ProfileCard name="Ada" />, { name: "profile-card", fit: true })
    for (const tab of ["week", "month"] as const) {
      await render(<StatisticsScreen tab={tab} />, { name: \`statistics-\${tab}\` })
    }
  }

It runs in the app's own JS runtime, so props can be anything: images, callbacks, shared values. Per render:
name, fit, padding, background, settleMs, timeoutMs. render() resolves with { name, ok, output, error }.

Output
  <out>/<name>-<device>-<appearance>.png for every render, and one line each on stdout:
    ✓ simless-output/profile-card-iphone-17-pro-light.png  412ms
    ✗ statistics-week  iphone-17-pro light
      TypeError: Cannot read property 'total' of undefined
        at StatisticsScreen (src/screens/StatisticsScreen.tsx:41:18)
  --json prints { ok, renders: [{ name, device, appearance, output, ok, settled, durationMs, error, logs }],
  errors }, with logs only for failed renders. Exit code 0 when every render worked, 1 when one failed, 2 when
  nothing could be rendered (bad arguments, a failed build or bundle, a script that throws before its first render).

Options
  --platform <name>        ios (drawn by @alivelabs/expo-simless-macos) or android (@alivelabs/expo-simless-android). Default ios
  --device <name,...>      Device preset(s) or WIDTHxHEIGHT@SCALE (default iphone-17-pro on ios; simless devices
                           lists them). This flag and --only take a comma-separated list, or repeat
  --appearance <mode>      light, dark or both (default light)
  --out <dir>              Where the PNGs go (default ./simless-output)
  --only <name,...>        Only the renders with these names; * matches anything, e.g. --only 'onboarding-*'
  --list                   Print the names of the script's renders, one per line, without rendering
  --locale <tag>           Render in this locale, e.g. nl-NL (default: the Mac's)
  --clock <iso>            Start Date at this moment in every render, e.g. 2026-10-21T14:30:00 (default: now)
  --time-zone <zone>       Render in this IANA time zone, e.g. Europe/Amsterdam (default: the Mac's)
  --font <path>            Register a font file in the host (repeatable)
  --json                   Print the results as JSON
  --verbose                Stream bundler and host logs

  Defaults for every render, which a render's own options override:
  --fit                    Crop to the content's height, with no safe area (for components, not screens)
  --padding <pt>           Space around the content (default 0)
  --background <color>     #RRGGBB, #RRGGBBAA or transparent (default: the system background)
  --settle <ms>            How long the view tree must stay unchanged before capture (default 150)
  --timeout <ms>           Per render (default 15000)

run and render
  --shared                 Perform all renders of a device and appearance in one process: faster, but a render
                           can leave state behind that changes the next. Default: a process per render
  --project <dir>          The React Native project (default: the nearest one above the file)
  --dev                    Bundle with __DEV__ on
  --keep                   Keep the generated bundle and plans in node_modules/.cache/simless

report
  Renders the scripts named, or report.renders from simless.config.ts, or every simless/**/*.render.tsx, on
  report.devices (default: --device). Each script's renders are named after its path: screens/Home/tapped-in.
  The devices may be iOS and Android presets together; each platform renders its own, into one report.
  --platform keeps one platform's devices.
  --out <dir>              Where the report goes (default ./simless-report), emptied first
  --compare <dir>          An earlier report: each image is set beside the earlier one for the same render, device
                           and appearance, with the share of pixels that changed. Copy the earlier report's folder
                           first if it is the default one, since --out empties its folder

show
  --only <name>            The render to open (default: the script's first)
  Uses the first --device and appearance.

swiftui
  --view <expression>      A Swift expression for a view, e.g. 'ProfileCard(name: "Ada")' (repeatable).
                           Default: the first file's name followed by ()
`

type Options = {
	platform?: string
	device?: string
	appearance?: string
	out?: string
	only?: string
	list?: boolean
	background?: string
	fit?: boolean
	padding?: string
	settle?: string
	timeout?: string
	font?: string[]
	locale?: string
	clock?: string
	"time-zone"?: string
	compare?: string
	json?: boolean
	verbose?: boolean
	shared?: boolean
	project?: string
	dev?: boolean
	keep?: boolean
	view?: string[]
	help?: boolean
}

const parse = () =>
	parseArgs({
		allowPositionals: true,
		options: {
			platform: { type: "string" },
			device: { type: "string", multiple: true },
			appearance: { type: "string" },
			out: { type: "string" },
			only: { type: "string", multiple: true },
			list: { type: "boolean" },
			background: { type: "string" },
			fit: { type: "boolean" },
			padding: { type: "string" },
			settle: { type: "string" },
			timeout: { type: "string" },
			font: { type: "string", multiple: true },
			locale: { type: "string" },
			clock: { type: "string" },
			"time-zone": { type: "string" },
			compare: { type: "string" },
			json: { type: "boolean" },
			verbose: { type: "boolean" },
			shared: { type: "boolean" },
			project: { type: "string" },
			dev: { type: "boolean" },
			keep: { type: "boolean" },
			view: { type: "string", multiple: true },
			help: { type: "boolean", short: "h" },
		},
	})

// Every render worked, one failed, nothing could be rendered.
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_UNUSABLE = 2

const log = (line: string) => {
	process.stderr.write(`${line}\n`)
}

const appearancesOf = (value: string | undefined): Appearance[] => {
	if (value === undefined || value === "light") {
		return ["light"]
	}
	if (value === "dark") {
		return ["dark"]
	}
	if (value === "both") {
		return ["light", "dark"]
	}
	throw new Error(`--appearance must be light, dark or both, got ${value}`)
}

const platformOf = (options: Options): Platform => {
	const platform = options.platform ?? "ios"
	if (!isPlatform(platform)) {
		throw new Error(`--platform must be ios or android, got ${platform}`)
	}
	return platform
}

const devicesOf = (value: string | undefined, renderer: Renderer): Device[] =>
	(value ?? renderer.defaultDevice)
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean)
		.map((name) => resolveDevice(name, renderer.devices))

const numberOf = (value: string | undefined, fallback: number, flag: string): number => {
	if (value === undefined) {
		return fallback
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${flag} must be a non-negative number, got ${value}`)
	}
	return parsed
}

type Defaults = Pick<
	SimlessConfig,
	"device" | "appearance" | "background" | "settleMs" | "timeoutMs" | "fit" | "padding"
>

const renderDefaults = (options: Options, defaults: Defaults): RenderDefaults => ({
	background: options.background ?? defaults.background,
	settleMs: numberOf(options.settle, defaults.settleMs ?? 150, "--settle"),
	timeoutMs: numberOf(options.timeout, defaults.timeoutMs ?? 15_000, "--timeout"),
	fit: options.fit ?? defaults.fit ?? false,
	padding: numberOf(options.padding, defaults.padding ?? 0, "--padding"),
})

const variantsOf = (options: Options, defaults: Defaults, renderer: Renderer): Variant[] =>
	devicesOf(options.device ?? defaults.device, renderer).flatMap((device) =>
		appearancesOf(options.appearance ?? defaults.appearance).map((appearance) => ({ device, appearance })),
	)

const displayPath = (file: string) => {
	const relative = path.relative(process.cwd(), file)
	return relative.startsWith("..") ? file : relative
}

const indent = (text: string, by: string) => text.split("\n").join(`\n${by}`)

// Signs that a component reached for native code the host does not have.
const NATIVE_MISSING =
	/TurboModuleRegistry|could not be found|Cannot find native module|NativeModules|is not a function \(it is undefined\)|Unimplemented component/

const hintFor = (error: string) => {
	if (/\bparams\b/.test(error)) {
		return "hint: the screen reads route params, so render it with them, as its navigator would pass them"
	}
	if (/timed out waiting/.test(error)) {
		return (
			"hint: a render is ready once the promises passed to waitFor settle and the app hides a splash screen it\n" +
			"kept up (SplashScreen.preventAutoHideAsync until hideAsync); one of them never did"
		)
	}
	if (NATIVE_MISSING.test(error)) {
		return (
			"hint: a native library the host lacks, because it does not build for Mac Catalyst, needs a mock or a\n" +
			"nativeModules stand-in in simless.config.ts, e.g.\n" +
			'mocks: { "some-native-lib": "./simless/mocks/some-native-lib.js" }'
		)
	}
	return null
}

type Reported = {
	name: string
	device: string
	appearance: Appearance
	output: string
	ok: boolean
	settled: boolean
	durationMs: number
	logs: string[]
	error?: string
	frames?: string[]
}

// One line per render, or with `quiet` only the failures; the exit code for them.
const printResults = (
	renders: Reported[],
	errors: ScriptOutcome["errors"],
	options: Options,
	startedAt: number,
	quiet = false,
): number => {
	const failed = renders.filter((render) => !render.ok)
	const code =
		renders.length === 0 && errors.length > 0
			? EXIT_UNUSABLE
			: failed.length > 0 || errors.length > 0
				? EXIT_FAILED
				: EXIT_OK
	if (options.json) {
		const body = {
			ok: code === EXIT_OK,
			renders: renders.map(({ logs, ...render }) => (render.ok ? render : { ...render, logs })),
			errors,
		}
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
		return code
	}
	for (const render of renders) {
		if (render.ok) {
			if (quiet) {
				continue
			}
			const note = render.settled ? "" : "  (still changing at the timeout)"
			process.stdout.write(`✓ ${displayPath(render.output)}  ${render.durationMs}ms${note}\n`)
			for (const frame of render.frames ?? []) {
				process.stdout.write(`  ${displayPath(frame)}\n`)
			}
			continue
		}
		const error = render.error ?? "failed"
		process.stdout.write(`✗ ${render.name}  ${render.device} ${render.appearance}\n  ${indent(error, "  ")}\n`)
		const hint = hintFor(error)
		if (hint) {
			process.stdout.write(`  ${indent(hint, "  ")}\n`)
		}
		// React logs the error it caught too, with the bundle's unsymbolicated stack: the line above already has it.
		const logs = render.logs
			.filter((line) => !line.startsWith("[info] simless") && !line.includes("componentStack:"))
			.slice(-15)
		if (logs.length > 0) {
			process.stdout.write(`  last logs:\n    ${logs.join("\n    ")}\n`)
		}
	}
	for (const { device, appearance, error } of errors) {
		process.stdout.write(`✗ the script stopped  ${device} ${appearance}\n  ${indent(error, "  ")}\n`)
	}
	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
	log(`${renders.length - failed.length} of ${renders.length} rendered in ${seconds}s`)
	return code
}

const timeZoneOf = (options: Options, project: Project) => {
	const timeZone = options["time-zone"] ?? project.config.timeZone
	if (timeZone) {
		checkTimeZone(timeZone)
	}
	return timeZone
}

const clockOf = (options: Options, project: Project) => {
	const clock = options.clock ?? project.config.clock
	return clock ? clockEpoch(clock, timeZoneOf(options, project)) : undefined
}

const bundleOptionsFor = (renderer: Renderer, host: NativeHost, options: Options, project: Project) => ({
	platform: renderer.platform,
	clock: clockOf(options, project),
	dev: Boolean(options.dev),
	verbose: Boolean(options.verbose),
	log,
	nativeLinked: host.linked,
	nativeExcluded: host.excluded,
	stubbedNativeModules: host.stubbedNativeModules,
})

const existingFile = (file: string) => {
	const resolved = path.resolve(file)
	if (!fs.existsSync(resolved)) {
		throw new Error(`No such file: ${resolved}`)
	}
	return resolved
}

const namesOf = (value: string | undefined) =>
	value
		? value
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean)
		: null

type RunMode = "run" | "report"

// A report's devices, grouped by the platform whose presets name them: one report can hold iPhones and Pixels. A
// custom WIDTHxHEIGHT@SCALE goes to --platform, or iOS. --platform keeps that platform's devices alone, and a platform
// this machine cannot render (no Android SDK, say) is left out with a word on why, as long as another remains.
const reportPlatforms = async (
	project: Project,
	options: Options,
	devices: string | undefined,
): Promise<Array<{ renderer: Renderer; devices: string | undefined }>> => {
	const fallback = platformOf(options)
	const names = (devices ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean)
	if (names.length === 0) {
		return [{ renderer: await loadAvailableRenderer(fallback, project.root), devices }]
	}
	const installed = new Map<Platform, Renderer>()
	for (const platform of PLATFORMS) {
		try {
			installed.set(platform, await loadRenderer(platform, project.root))
		} catch {
			// Not installed: none of its presets can be named, and a device naming one says so below.
		}
	}
	const groups = new Map<Platform, string[]>()
	for (const name of names) {
		const platform = PLATFORMS.find((candidate) => installed.get(candidate)?.devices[name]) ?? fallback
		if (options.platform && platform !== options.platform) {
			continue
		}
		groups.set(platform, [...(groups.get(platform) ?? []), name])
	}
	const runs: Array<{ renderer: Renderer; devices: string | undefined }> = []
	const skipped: string[] = []
	for (const [platform, list] of groups) {
		try {
			runs.push({ renderer: await loadAvailableRenderer(platform, project.root), devices: list.join(",") })
		} catch (error) {
			skipped.push(`${list.join(", ")}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	if (runs.length === 0) {
		throw new Error(skipped.join("\n") || `No report device is a ${options.platform} device`)
	}
	for (const reason of skipped) {
		log(`Leaving out ${reason}`)
	}
	return runs
}

// Bundles the scripts the project's way and runs them on every device and appearance asked for. A report renders
// on the devices its config names, on every platform they belong to, into a folder of its own, and writes the report
// beside the images.
const runReactNative = async (
	project: Project,
	makeScripts: (workDir: string) => ScriptFile[],
	options: Options,
	mode: RunMode,
): Promise<number> => {
	const startedAt = Date.now()
	const reportConfig = mode === "report" ? (project.config.report ?? {}) : {}
	const defaults = {
		...project.config,
		device: reportConfig.devices?.join(",") ?? project.config.device,
		appearance: reportConfig.appearance ?? project.config.appearance,
	}
	const requested = options.appearance ?? defaults.appearance
	if (project.lockedAppearance && requested && requested !== project.lockedAppearance) {
		log(
			`The app sets userInterfaceStyle "${project.lockedAppearance}", so it renders ${project.lockedAppearance} as it does on a phone.`,
		)
	}
	const appearanceOptions = project.lockedAppearance ? { ...options, appearance: project.lockedAppearance } : options
	const platforms =
		mode === "report"
			? await reportPlatforms(project, options, options.device ?? defaults.device)
			: [{ renderer: await loadAvailableRenderer(platformOf(options), project.root), devices: options.device }]
	const runs = platforms.map(({ renderer, devices }) => ({
		renderer,
		variants: variantsOf({ ...appearanceOptions, device: devices }, defaults, renderer),
	}))
	const outDir = path.resolve(options.out ?? (mode === "report" ? "simless-report" : "simless-output"))
	const compareDir = mode === "report" && options.compare ? path.resolve(options.compare) : undefined
	if (compareDir) {
		if (!fs.existsSync(path.join(compareDir, "report.json"))) {
			throw new Error(`--compare needs an earlier report's folder (with its report.json), got ${compareDir}`)
		}
		if (compareDir === outDir) {
			throw new Error("--compare cannot be the folder the report is written to, which is emptied first: copy it")
		}
	}
	if (mode === "report" && !options.list) {
		prepareReportDir(outDir)
	}
	const verbose = Boolean(options.verbose)
	const only = namesOf(options.only)
	const renders: Awaited<ReturnType<typeof runScript>>["renders"] = []
	const errors: Awaited<ReturnType<typeof runScript>>["errors"] = []
	let names: string[] = []
	for (const { renderer, variants } of runs) {
		const workDir = createWorkDir(project)
		try {
			const host = await renderer.prepare(project, { log, verbose })
			const bundle = await bundleScript(
				project,
				makeScripts(workDir),
				workDir,
				bundleOptionsFor(renderer, host, options, project),
			)
			const mockedNames = Object.keys(bundle.mocked).sort()
			if (mockedNames.length > 0 && verbose) {
				log(`Mocked in the bundle (not in the host): ${mockedNames.join(", ")}`)
			}
			const script = {
				host,
				bundle: bundle.bundlePath,
				workDir,
				outDir,
				fonts: resolveFonts(project, options.font ?? []),
				verbose,
				locale: options.locale ?? project.config.locale,
				timeZone: timeZoneOf(options, project),
				defaults: renderDefaults(options, project.config),
				only,
				shared: Boolean(options.shared),
			}
			const symbolicate = symbolicator(bundle.sourceMapPath, project.root)
			const [firstVariant] = variants
			if (options.list && firstVariant) {
				const listed = await listRenders(script, firstVariant)
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ names: listed.names, error: listed.error }, null, 2)}\n`)
				} else {
					process.stdout.write(listed.names.map((name) => `${name}\n`).join(""))
				}
				if (listed.error) {
					log(`The script stopped:\n  ${indent(symbolicate(listed.error), "  ")}`)
					return EXIT_UNUSABLE
				}
				return EXIT_OK
			}
			if (mode === "report") {
				log(`Rendering on ${variants.map(({ device, appearance }) => `${device.name} ${appearance}`).join(", ")}…`)
			}
			const outcome = await runScript(script, variants)
			renders.push(
				...outcome.renders.map((render) => (render.error ? { ...render, error: symbolicate(render.error) } : render)),
			)
			errors.push(...outcome.errors.map((error) => ({ ...error, error: symbolicate(error.error) })))
			if (outcome.names.length > names.length) {
				names = outcome.names
			}
		} finally {
			releaseWorkDir(workDir, options.keep, log)
		}
	}
	if (renders.length === 0 && errors.length === 0) {
		log(
			only
				? `No render matches --only ${options.only}. The renders: ${names.join(", ") || "none"}`
				: "The scripts finished without calling render().",
		)
		return EXIT_UNUSABLE
	}
	if (mode === "run") {
		return printResults(renders, errors, options, startedAt)
	}
	const written = await writeReport({
		compare: compareDir,
		outDir,
		projectRoot: project.root,
		names,
		renders,
		errors,
		variants: runs.flatMap(({ variants }) => variants),
		startedAt,
	})
	const code = printResults(renders, errors, options, startedAt, true)
	if (!options.json) {
		process.stdout.write(`Report: ${displayPath(written.html)}\nFor an LLM: ${displayPath(written.markdown)}\n`)
	}
	return code
}

const projectFor = (options: Options, file: string) =>
	loadProject(options.project ? path.resolve(options.project) : findProjectRoot(file))

// The render scripts a report draws: the ones named, files or folders, or else those the config or the convention
// points at. Each script's renders are grouped under its path from the folder they share.
const reportScripts = (project: Project, positionals: string[]): ScriptFile[] => {
	const isScript = (file: string) => /\.render\.[cm]?[jt]sx?$/.test(file)
	const inFolder = (folder: string) =>
		fs
			.globSync("**/*.render.*", { cwd: folder })
			.map((file) => path.join(folder, file))
			.filter(isScript)
	const named = positionals.flatMap((positional) => {
		const resolved = existingFile(positional)
		return fs.statSync(resolved).isDirectory() ? inFolder(resolved) : [resolved]
	})
	const patterns = project.config.report?.renders
	const files =
		positionals.length > 0
			? named
			: patterns
				? patterns.flatMap((pattern) =>
						fs.globSync(pattern, { cwd: project.root }).map((file) => path.join(project.root, file)),
					)
				: inFolder(path.join(project.root, "simless"))
	const unique = [...new Set(files.filter(isScript))].sort()
	if (unique.length === 0) {
		throw new Error("No render scripts to report on: name some, or add simless/<name>.render.tsx files")
	}
	const shared = unique.reduce(
		(common, file) => {
			let dir = common
			while (!`${path.dirname(file)}${path.sep}`.startsWith(`${dir}${path.sep}`)) {
				dir = path.dirname(dir)
			}
			return dir
		},
		path.dirname(unique[0] ?? project.root),
	)
	return unique.map((file) => ({
		group: path
			.relative(shared, file)
			.replace(/\.render\.[cm]?[jt]sx?$/, "")
			.split(path.sep)
			.join("/"),
		file,
	}))
}

const reportCommand = async (positionals: string[], options: Options): Promise<number> => {
	const project = await projectFor(options, positionals[0] ? existingFile(positionals[0]) : process.cwd())
	const scripts = reportScripts(project, positionals)
	return runReactNative(project, () => scripts, options, "report")
}

// One render in a window people can use, until the window is closed.
const showReactNative = async (positionals: string[], options: Options): Promise<number> => {
	const [file, ...extra] = positionals
	if (file === undefined || extra.length > 0) {
		throw new Error("show takes one script or component, e.g. simless show simless/screens.render.tsx --only Home")
	}
	const [target = "", exportName = "default"] = file.split("#")
	const resolved = existingFile(target)
	const isScript = /\.render\.[cm]?[jt]sx?$/.test(resolved) && !file.includes("#")
	const project = await projectFor(options, resolved)
	const renderer = await loadAvailableRenderer(platformOf(options), project.root)
	const [variant] = variantsOf(
		project.lockedAppearance ? { ...options, appearance: project.lockedAppearance } : options,
		project.config,
		renderer,
	)
	if (variant === undefined) {
		throw new Error("show needs a device")
	}
	const verbose = Boolean(options.verbose)
	const workDir = createWorkDir(project)
	try {
		const host = await renderer.prepare(project, { log, verbose })
		await showScript({
			project,
			host,
			script: isScript ? resolved : writeComponentScript(workDir, [{ file: resolved, exportName }]),
			workDir,
			variant,
			fonts: resolveFonts(project, options.font ?? []),
			locale: options.locale ?? project.config.locale,
			timeZone: timeZoneOf(options, project),
			defaults: renderDefaults(options, project.config),
			only: namesOf(options.only),
			verbose,
			bundleOptions: bundleOptionsFor(renderer, host, options, project),
			log,
		})
		return EXIT_OK
	} finally {
		releaseWorkDir(workDir, options.keep, log)
	}
}

const runCommand = async (positionals: string[], options: Options): Promise<number> => {
	const [file, ...extra] = positionals
	if (file === undefined || extra.length > 0) {
		throw new Error("run takes one script, e.g. simless run simless/screens.render.tsx")
	}
	const script = existingFile(file)
	return runReactNative(await projectFor(options, script), () => [{ group: "", file: script }], options, "run")
}

const renderCommand = async (positionals: string[], options: Options): Promise<number> => {
	if (positionals.length === 0) {
		throw new Error("render needs a component file, e.g. simless render src/components/Card.tsx")
	}
	const targets: ComponentTarget[] = positionals.map((positional) => {
		const [file = "", exportName = "default"] = positional.split("#")
		return { file: existingFile(file), exportName }
	})
	return runReactNative(
		await projectFor(options, targets[0]?.file ?? process.cwd()),
		(workDir) => [{ group: "", file: writeComponentScript(workDir, targets) }],
		options,
		"run",
	)
}

const renderSwiftUI = async (positionals: string[], options: Options): Promise<number> => {
	const startedAt = Date.now()
	if (positionals.length === 0) {
		throw new Error("swiftui needs at least one .swift file")
	}
	const renderer = await loadAvailableRenderer(platformOf(options))
	if (!renderer.renderSwiftUI) {
		throw new Error(`The ${renderer.name} renderer does not render SwiftUI`)
	}
	const sources = positionals.map(existingFile)
	const firstName = path.basename(sources[0] ?? "", ".swift")
	const results = await renderer.renderSwiftUI(
		{
			sources,
			expressions: options.view?.length ? options.view : [`${firstName}()`],
			variants: variantsOf(options, {}, renderer),
			outDir: path.resolve(options.out ?? "simless-output"),
			defaults: renderDefaults(options, {}),
			fonts: (options.font ?? []).map((font) => path.resolve(font)),
			locale: options.locale,
		},
		{ log, verbose: Boolean(options.verbose) },
	)
	return printResults(results, [], options, startedAt)
}

const listDevices = async (options: Options): Promise<number> => {
	const renderer = await loadRenderer(platformOf(options))
	for (const device of Object.values(renderer.devices)) {
		const { top, bottom } = device.safeArea
		process.stdout.write(
			`${device.name.padEnd(20)} ${device.width}x${device.height}@${device.scale}  safe area ${top}/${bottom}  corners ${device.cornerRadius}\n`,
		)
	}
	return EXIT_OK
}

// The project the command is run in, if any: the cache command also works outside one, for the shared cache.
const projectRootOrNull = (options: Options) => {
	try {
		return findProjectRoot(options.project ? path.resolve(options.project) : process.cwd())
	} catch {
		return null
	}
}

const cacheCommand = async (positionals: string[], options: Options): Promise<number> => {
	const [action, scope = "default"] = positionals
	const root = projectRootOrNull(options)
	if (root) {
		// Reads cacheDir from the config.
		await loadProject(root)
	}
	if (action === undefined) {
		showCache(root)
		return EXIT_OK
	}
	if (action !== "clean" || !["default", "project", "all"].includes(scope)) {
		log("Usage: simless cache [clean [project | all]]")
		return EXIT_UNUSABLE
	}
	cleanCache(root, scope as CleanScope, log)
	return EXIT_OK
}

export const main = async (): Promise<number> => {
	const { values, positionals } = parse()
	// Repeating a list flag adds to it, as a comma does: `--device a --device b` is `--device a,b`.
	const options: Options = { ...values, device: values.device?.join(","), only: values.only?.join(",") }
	const [command, ...rest] = positionals
	if (options.help || command === undefined) {
		process.stdout.write(USAGE)
		return command === undefined && !options.help ? EXIT_UNUSABLE : EXIT_OK
	}
	if (command === "run") {
		return runCommand(rest, options)
	}
	if (command === "render") {
		return renderCommand(rest, options)
	}
	if (command === "report") {
		return reportCommand(rest, options)
	}
	if (command === "show") {
		return showReactNative(rest, options)
	}
	if (command === "swiftui") {
		return renderSwiftUI(rest, options)
	}
	if (command === "devices") {
		return listDevices(options)
	}
	if (command === "cache") {
		return cacheCommand(rest, options)
	}
	log(`Unknown command ${command}\n`)
	process.stdout.write(USAGE)
	return EXIT_UNUSABLE
}
