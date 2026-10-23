// Bundled by Metro inside the project being rendered, not run by Node. The CLI copies it next to the generated
// entry, and the project's imports of "@alivelabs/expo-simless" resolve to that copy, so `react` and
// `react-native` are the project's own and there is one instance of this module.
import { Component, createElement, isValidElement, useEffect, useRef } from "react"
import { AppRegistry, StyleSheet, View } from "react-native"

// Installed by the native host before the bundle runs; see ios/react-native/SMLReactHost.mm.
const host = globalThis.__simless
// Present when the config sets a clock; see shims/clock.js.
const clock = globalThis.__simlessClockControl

// Two frames after the first commit, so a layout effect's follow-up render has landed before the native side
// starts waiting for the view tree to settle.
const FRAMES_BEFORE_READY = 2
const RESULT_POLL_MS = 16

// Which renders this process performs: the CLI runs each in a process of its own by default. A run of several
// scripts (simless report) names each script's renders after it, `group/name`; `group` limits a process to one
// script, whose renders `indices` then counts from 0.
// { group: string | null, indices: number[] | null, patterns: string[] | null, limit: number | null }
const selection = host?.selection
	? JSON.parse(host.selection)
	: { group: null, indices: null, patterns: null, limit: null }

let providers = []
const elements = new Map()
// Every render asked for, by full name, in the order asked.
const names = []
let group = ""
let groupIndex = 0
let usedNames = new Map()
let performed = 0
let activeJobId = null
let activeHolds = null
// Settles when the app hides a splash screen it kept up (see mocks/expo-splash-screen.js); null while none is up.
let splash = null
let hideSplash = null

export const __splash = {
	hold: () => {
		splash ??= new Promise((resolve) => {
			hideSplash = resolve
		})
	},
	release: () => {
		hideSplash?.()
		splash = null
		hideSplash = null
	},
}

const describe = (error) => {
	if (error instanceof Error) {
		// Hermes stacks start with "Name: message"; some errors carry only a message.
		return error.stack?.includes(error.message) ? error.stack : `${error.message}\n${error.stack ?? ""}`
	}
	return String(error)
}

// `*` matches any run of characters; anything else matches itself.
const matches = (name, pattern) =>
	new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	).test(name)

const isSelected = (index, name) => {
	if (selection.indices && !selection.indices.includes(index)) {
		return false
	}
	if (selection.patterns && !selection.patterns.some((pattern) => matches(name, pattern))) {
		return false
	}
	return selection.limit == null || performed < selection.limit
}

const safeName = (value) => value.replace(/[^A-Za-z0-9._-]+/g, "_")

// The same on every run of the script, so a render keeps its name (and its PNG) in whichever process performs it.
const nameFor = (element, options, index) => {
	const type = element.type
	const base = safeName(options.name ?? type?.displayName ?? type?.name ?? `render-${index + 1}`)
	const seen = (usedNames.get(base) ?? 0) + 1
	usedNames.set(base, seen)
	return seen === 1 ? base : `${base}-${seen}`
}

class Boundary extends Component {
	state = { failed: false }

	static getDerivedStateFromError() {
		return { failed: true }
	}

	componentDidCatch(error, info) {
		host.fail(this.props.jobId, `${describe(error)}${info?.componentStack ?? ""}`)
	}

	render() {
		return this.state.failed ? null : this.props.children
	}
}

// `layout` is filled by the root's onLayout; it is read when the last frame fires, not when the effect runs.
// `holds` are the promises passed to waitFor; ready waits for them and for a splash screen the app keeps up, then
// for two more frames.
const Ready = ({ jobId, layout, holds, children }) => {
	useEffect(() => {
		let frames = FRAMES_BEFORE_READY
		let handle = 0
		let cancelled = false
		const tick = () => {
			frames -= 1
			if (frames > 0) {
				handle = requestAnimationFrame(tick)
				return
			}
			if (holds.size > 0 || splash) {
				Promise.allSettled([...holds, splash].filter(Boolean)).then(() => {
					if (!cancelled) {
						frames = FRAMES_BEFORE_READY
						handle = requestAnimationFrame(tick)
					}
				})
				return
			}
			// A window people use keeps its clock running; a capture holds it, so a timer is the same on every run.
			if (!host.interactive) {
				clock?.hold()
			}
			host.ready(jobId, layout.height)
		}
		handle = requestAnimationFrame(tick)
		return () => {
			cancelled = true
			cancelAnimationFrame(handle)
		}
	}, [jobId, layout, holds])
	return children
}

// The providers an app has at its root, set up for the job's device so the first render already has its insets.
const withProviders = (tree, job) => {
	// Both default to flex: 1, which collapses to nothing under a root sized by its content (fit).
	const style = job.fit ? styles.content : styles.fill
	let wrapped = tree
	for (const { kind, load } of providers) {
		const moduleExports = load()
		if (kind === "safeArea" && moduleExports.SafeAreaProvider) {
			const initialMetrics = { insets: job.safeArea, frame: { x: 0, y: 0, width: job.width, height: job.height } }
			wrapped = createElement(moduleExports.SafeAreaProvider, { initialMetrics, style }, wrapped)
		}
		if (kind === "gestureHandler" && moduleExports.GestureHandlerRootView) {
			wrapped = createElement(moduleExports.GestureHandlerRootView, { style }, wrapped)
		}
	}
	return wrapped
}

// The root of every surface the host mounts; the job's id says which element render() handed over.
const Root = (job) => {
	const layout = useRef({ height: 0 }).current
	const holds = useRef(new Set()).current
	activeJobId = job.jobId
	activeHolds = holds
	const element = elements.get(job.jobId)
	if (element === undefined) {
		host.fail(job.jobId, "simless: the host mounted a render the script did not ask for")
		return null
	}
	const onLayout = (event) => {
		layout.height = event.nativeEvent.layout.height
	}
	return createElement(
		View,
		{ style: [job.fit ? null : styles.fill, { padding: job.padding }], collapsable: false, onLayout },
		createElement(
			Boundary,
			{ jobId: job.jobId },
			createElement(Ready, { jobId: job.jobId, layout, holds }, withProviders(element, job)),
		),
	)
}

const resultOf = (jobId) =>
	new Promise((resolve) => {
		const check = () => {
			const raw = host.result(jobId)
			if (raw === undefined) {
				setTimeout(check, RESULT_POLL_MS)
				return
			}
			resolve(JSON.parse(raw))
		}
		check()
	})

// Renders `element` to a PNG and resolves once it is written, with { name, ok, output, error, settled }. Renders
// run one at a time, so await each. A render this process does not perform (the CLI gives each render a process
// of its own, and --only picks some) resolves at once with { name, skipped: true }.
export const render = async (element, options = {}) => {
	if (!isValidElement(element)) {
		throw new TypeError('render() takes a React element, e.g. await render(<Card title="Hi" />)')
	}
	const index = groupIndex
	groupIndex += 1
	const base = nameFor(element, options, index)
	const name = group ? `${group}/${base}` : base
	names.push(name)
	if (!isSelected(index, name)) {
		return { name, skipped: true }
	}
	performed += 1
	const jobId = String(names.length - 1)
	elements.set(jobId, element)
	const { fit, padding, background, settleMs, timeoutMs, frames } = options
	clock?.start()
	host.mount(jobId, JSON.stringify({ name, fit, padding, background, settleMs, timeoutMs, frames }))
	const result = await resultOf(jobId)
	elements.delete(jobId)
	activeJobId = null
	activeHolds = null
	return { name, ...result }
}

// Holds the capture of the render on screen until `promise` settles, for setup a component starts when it mounts
// (data loading, a store rehydrating). Setup the script can await before render() needs none of this.
export const waitFor = (promise) => {
	const holds = activeHolds
	if (holds) {
		holds.add(promise)
		promise.finally(() => holds.delete(promise))
	}
	return promise
}

const runScript = async (load) => {
	const script = load()
	const main = script?.default ?? script
	if (typeof main !== "function") {
		throw new Error(
			"simless: a render script's default export must be a function, e.g.\n" +
				'  export default async () => {\n    await render(<Card title="Hi" />)\n  }',
		)
	}
	await main()
}

// Called by the generated entry: registers the surface root and runs each script's default export in turn. A
// script that throws stops itself, not the scripts after it.
export const __run = ({ scripts, providers: available }) => {
	providers = available
	const previousHandler = ErrorUtils.getGlobalHandler()
	ErrorUtils.setGlobalHandler((error, isFatal) => {
		if (activeJobId !== null) {
			host.fail(activeJobId, describe(error))
			return
		}
		previousHandler(error, isFatal)
	})
	AppRegistry.registerComponent("Simless", () => Root)
	const errors = []
	Promise.resolve()
		.then(async () => {
			for (const script of scripts) {
				if (selection.group != null && selection.group !== script.group) {
					continue
				}
				group = script.group
				groupIndex = 0
				usedNames = new Map()
				try {
					await runScript(script.load)
				} catch (error) {
					errors.push(group ? `${group}: ${describe(error)}` : describe(error))
				}
			}
		})
		.then(() => {
			host.done(JSON.stringify(errors.length === 0 ? { names } : { names, error: errors.join("\n\n") }))
		})
}

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	content: {
		flex: 0,
	},
})
