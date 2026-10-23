import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "./process.ts"
import type { Appearance, JobResult, NativeHost, RenderDefaults, Variant } from "./renderer.ts"

export type ScriptRun = {
	host: NativeHost
	bundle: string
	workDir: string
	outDir: string
	fonts: string[]
	verbose: boolean
	locale?: string
	timeZone?: string
	defaults: RenderDefaults
	// Render names to perform, with `*` as a wildcard; null for all.
	only: string[] | null
	// All renders of a device and appearance in one process, instead of one process each.
	shared: boolean
}

export type RenderOutcome = JobResult & {
	name: string
	device: string
	appearance: Appearance
}

export type ScriptError = {
	device: string
	appearance: Appearance
	error: string
}

export type ScriptOutcome = {
	renders: RenderOutcome[]
	errors: ScriptError[]
	// Every render the script asks for, in order, whether or not it was performed.
	names: string[]
}

type Selection = {
	// One script of several, whose renders `indices` counts from 0; null for every script.
	group: string | null
	indices: number[] | null
	patterns: string[] | null
	limit: number | null
}

type ProcessResult = {
	jobs: JobResult[]
	names: string[]
	error?: string
}

// Bundle load, the first frame and the script's own setup, on top of each render's timeout.
const STARTUP_ALLOWANCE_MS = 30_000
// A shared process performs an unknown number of renders; this is only there to end a script that hangs.
const SHARED_PROCESS_LIMIT_MS = 30 * 60_000

export const groupOf = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf("/")))

const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_")

const matches = (name: string, pattern: string) =>
	new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	).test(name)

const isWanted = (name: string, only: string[] | null) =>
	only === null || only.some((pattern) => matches(name, pattern))

// Where the host writes a render's PNG: the plan's template, whose `{name}` it replaces with the render's name.
const outputTemplate = (script: ScriptRun, { device, appearance }: Variant) =>
	path.join(script.outDir, `{name}-${safe(device.name)}-${appearance}.png`)

// A render whose process ended before reporting it (the host exited, or the script stopped before reaching it): failed,
// rather than missing from the totals and the exit code.
const unreported = (script: ScriptRun, variant: Variant, name: string, index: number, error: string): JobResult => ({
	id: String(index),
	name,
	output: outputTemplate(script, variant).replace("{name}", name),
	ok: false,
	settled: false,
	durationMs: 0,
	logs: [],
	error,
})

let processCount = 0

const runProcess = async (script: ScriptRun, variant: Variant, selection: Selection): Promise<ProcessResult> => {
	const index = processCount++
	const planPath = path.join(script.workDir, `plan-${index}.json`)
	const resultPath = path.join(script.workDir, `result-${index}.json`)
	const { device, appearance } = variant
	fs.writeFileSync(
		planPath,
		JSON.stringify({
			result: resultPath,
			bundle: script.bundle,
			fonts: script.fonts,
			verbose: script.verbose,
			locale: script.locale,
			selection: JSON.stringify(selection),
			template: {
				output: outputTemplate(script, variant),
				width: device.width,
				height: device.height,
				scale: device.scale,
				safeArea: device.safeArea,
				cornerRadius: device.cornerRadius,
				appearance,
				...script.defaults,
			},
		}),
	)
	// An empty home per process, so what a render saves (AsyncStorage, user defaults, files) is never read by a later
	// render or by one running next to it, the way a fresh install starts empty.
	const launch = script.host.launch(planPath, {
		locale: script.locale,
		timeZone: script.timeZone,
		home: path.join(script.workDir, `home-${index}`),
	})
	const renders = selection.limit ?? selection.indices?.length ?? 1
	const child = await run(launch.command, launch.args, {
		env: launch.env,
		inherit: script.verbose,
		timeoutMs: script.shared ? SHARED_PROCESS_LIMIT_MS : STARTUP_ALLOWANCE_MS + renders * script.defaults.timeoutMs,
	})
	if (fs.existsSync(resultPath)) {
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Partial<ProcessResult>
		return { jobs: result.jobs ?? [], names: result.names ?? [], error: result.error }
	}
	const tail = child.stderr.trim().split("\n").slice(-30).join("\n")
	return {
		jobs: [],
		names: [],
		error: `the host exited (code ${child.code}) before reporting${tail ? `:\n${tail}` : ""}`,
	}
}

// The names the script asks for, without rendering any of them.
export const listRenders = async (script: ScriptRun, variant: Variant): Promise<ProcessResult> =>
	runProcess(script, variant, { group: null, indices: [], patterns: null, limit: 0 })

// Every render the script asks for, on every device in every appearance. By default each render gets a process of
// its own, since one can leave state behind that changes the next (a pushed screen left iOS 26's scroll edge effect
// over a sheet rendered after it): the first process performs the first wanted render and reports every name, and
// the rest are spread over parallel processes. React Native reads Dimensions and the color scheme once at startup,
// so devices and appearances never share a process.
export const runScript = async (script: ScriptRun, variants: Variant[]): Promise<ScriptOutcome> => {
	const renders: RenderOutcome[] = []
	const errors: ScriptError[] = []
	let names: string[] = []
	const record = (variant: Variant, result: ProcessResult) => {
		const label = { device: variant.device.name, appearance: variant.appearance }
		renders.push(...result.jobs.map((job) => ({ ...job, ...label })))
		if (result.error) {
			errors.push({ ...label, error: result.error })
		}
		if (result.names.length > names.length) {
			names = result.names
		}
	}
	// Variants whose first process ended before it listed the script's renders, so none of theirs were performed.
	const unlisted: Array<{ variant: Variant; error: string }> = []
	const workers = Math.max(1, Math.floor(os.availableParallelism() / 2))
	const queue: Array<() => Promise<void>> = []
	const startVariant = (variant: Variant) => async () => {
		if (script.shared) {
			record(
				variant,
				await runProcess(script, variant, { group: null, indices: null, patterns: script.only, limit: null }),
			)
			return
		}
		const first = await runProcess(script, variant, { group: null, indices: null, patterns: script.only, limit: 1 })
		if (first.names.length === 0 && first.error) {
			unlisted.push({ variant, error: first.error })
			return
		}
		record(variant, first)
		const done = new Set(first.jobs.map((job) => Number(job.id)))
		const seenInGroup = new Map<string, number>()
		first.names.forEach((name, index) => {
			// A render replays only its own script: `group/name`, and its place among that script's renders.
			const group = groupOf(name)
			const indexInGroup = seenInGroup.get(group) ?? 0
			seenInGroup.set(group, indexInGroup + 1)
			if (isWanted(name, script.only) && !done.has(index)) {
				queue.push(async () => {
					const result = await runProcess(script, variant, {
						group,
						indices: [indexInGroup],
						patterns: null,
						limit: 1,
					})
					if (result.jobs.length === 0) {
						const error = result.error ?? first.error ?? "the host did not report this render"
						record(variant, { ...result, jobs: [unreported(script, variant, name, index, error)], error: undefined })
						return
					}
					// A script error in a process that only replays the run up to its render repeats the first one's.
					record(variant, first.error ? { ...result, error: undefined } : result)
				})
			}
		})
	}
	queue.push(...variants.map(startVariant))
	let running = 0
	await new Promise<void>((resolve, reject) => {
		const next = () => {
			while (running < workers && queue.length > 0) {
				const task = queue.shift()
				if (task) {
					running += 1
					task().then(() => {
						running -= 1
						next()
					}, reject)
				}
			}
			if (running === 0 && queue.length === 0) {
				resolve()
			}
		}
		next()
	})
	// Another variant's first process named the renders: on this one they all failed with its error. With no names at
	// all (every variant stopped), the script error stands alone.
	for (const { variant, error } of unlisted) {
		const wanted = names.map((name, index) => ({ name, index })).filter(({ name }) => isWanted(name, script.only))
		record(variant, {
			names: [],
			error: wanted.length === 0 ? error : undefined,
			jobs: wanted.map(({ name, index }) => unreported(script, variant, name, index, error)),
		})
	}
	const order = (outcome: RenderOutcome) => names.indexOf(outcome.name)
	const variantOrder = (outcome: { device: string; appearance: Appearance }) =>
		variants.findIndex((variant) => variant.device.name === outcome.device && variant.appearance === outcome.appearance)
	renders.sort((a, b) => order(a) - order(b) || variantOrder(a) - variantOrder(b))
	return { renders, errors, names }
}
