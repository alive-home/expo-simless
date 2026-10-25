// Runs one plan on an emulator: what the CLI starts in place of a host process, since the host runs on the
// device. Usage: node runner.ts <plan.json> <runner-config.json>. It takes an emulator from the CLI's pool (booting
// one from simless's snapshot when none is free), pushes the bundle and the plan, starts the host, and pulls the
// result file and PNGs back to where the plan asked for them.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { hashOf } from "@alivelabs/expo-simless/renderer"
import { panelOf } from "./devices.ts"
import {
	adb,
	bootEmulator,
	DEVICE_ROOT,
	ensureRoot,
	freePort,
	HOST_ACTIVITY,
	HOST_PACKAGE,
	READY_LINE,
	setAnimations,
	shell,
	sleep,
	waitForBoot,
	waitForSnapshotWriter,
} from "./emulator.ts"
import type { AndroidSdk } from "./sdk.ts"

export type RunnerConfig = {
	sdk: AndroidSdk
	apk: string
	apkKey: string
	// The snapshot with this APK already installed.
	snapshot: string
	pool: string
	emulators: number
	locale?: string
	timeZone?: string
}

type Plan = {
	result: string
	verbose?: boolean
	bundle: string
	fonts?: string[]
	interactive?: boolean
	template: Record<string, unknown> & {
		output: string
		width: number
		height: number
		scale: number
		appearance: string
	}
}

type JobResult = { id: string; name: string; output: string; ok: boolean; logs: string[]; [key: string]: unknown }

// What one emulator in the pool has had done to it, so the next run skips it.
type SlotState = {
	serial: string
	pid: number
	apk?: string
	pushed: Record<string, string>
	display?: string
	timeZone?: string
}

const SLOT_WAIT_MS = 120_000
const POLL_MS = 100
const LOG_FILTER = ["ReactNativeJS:V", "ReactNative:W", "Simless:V", "AndroidRuntime:E", "*:S"]

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

// One emulator per slot; a slot is held by the runner that made its lock directory, until it ends.
const acquireSlot = async (pool: string, count: number) => {
	const started = Date.now()
	for (;;) {
		for (let index = 0; index < count; index += 1) {
			const lock = path.join(pool, `slot-${index}.lock`)
			try {
				fs.mkdirSync(lock)
				fs.writeFileSync(path.join(lock, "owner"), String(process.pid))
				return { index, release: () => fs.rmSync(lock, { recursive: true, force: true }) }
			} catch {
				// A runner the CLI killed on its timeout leaves its lock behind.
				const owner = Number(fs.readFileSync(path.join(lock, "owner"), { encoding: "utf8", flag: "a+" }) || 0)
				if (owner > 0 && !alive(owner)) {
					fs.rmSync(lock, { recursive: true, force: true })
				}
			}
		}
		if (Date.now() - started > SLOT_WAIT_MS) {
			throw new Error(`no emulator came free in ${SLOT_WAIT_MS / 1000}s`)
		}
		await sleep(150)
	}
}

const readState = (file: string): SlotState | null => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as SlotState
	} catch {
		return null
	}
}

const isBooted = async (sdk: AndroidSdk, serial: string) =>
	(await adb(sdk, serial, ["shell", "getprop", "sys.boot_completed"], 5_000)).stdout.trim() === "1"

const bootSlot = async (config: RunnerConfig, index: number): Promise<SlotState> => {
	await waitForSnapshotWriter(config.sdk)
	const port = await freePort(5600 + index * 2)
	const serial = `emulator-${port}`
	const emulator = bootEmulator(config.sdk, port, {
		window: false,
		logFile: path.join(config.pool, `emulator-${index}.log`),
		snapshot: config.snapshot,
	})
	emulator.unref()
	await adb(config.sdk, serial, ["wait-for-device"], 120_000)
	await waitForBoot(config.sdk, serial, emulator)
	await ensureRoot(config.sdk, serial)
	return { serial, pid: emulator.pid ?? 0, apk: config.apkKey, pushed: {} }
}

// Pushes a file or directory once per emulator, keyed by what it is, and says where it is on the device.
const pushOnce = async (config: RunnerConfig, state: SlotState, local: string, prefix: string) => {
	const stat = fs.statSync(local)
	const key = hashOf([local, String(stat.size), String(stat.mtimeMs)])
	const remote = `${DEVICE_ROOT}/${prefix}-${key}`
	if (state.pushed[key] !== remote) {
		await shell(config.sdk, state.serial, `rm -rf ${remote} && mkdir -p ${remote}`)
		const pushed = await adb(config.sdk, state.serial, [
			"push",
			stat.isDirectory() ? `${local}/.` : local,
			`${remote}/`,
		])
		if (pushed.code !== 0) {
			throw new Error(`adb push ${local} failed: ${pushed.stderr.trim()}`)
		}
		await shell(config.sdk, state.serial, `chmod -R a+rX ${DEVICE_ROOT}`)
		state.pushed[key] = remote
	}
	return remote
}

// The device as the plan's device and appearance: one emulator plays every preset.
const configureDisplay = async (config: RunnerConfig, state: SlotState, plan: Plan) => {
	const panel = panelOf({
		name: "",
		width: plan.template.width,
		height: plan.template.height,
		scale: plan.template.scale,
		safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
		cornerRadius: 0,
	})
	const night = plan.template.appearance === "dark" ? "yes" : "no"
	const display = `${panel.widthPx}x${panel.heightPx}@${panel.dpi}/${night}`
	if (state.display !== display) {
		await shell(
			config.sdk,
			state.serial,
			`wm size ${panel.widthPx}x${panel.heightPx}; wm density ${panel.dpi}; cmd uimode night ${night}`,
		)
		state.display = display
	}
	if (config.timeZone && state.timeZone !== config.timeZone) {
		await shell(config.sdk, state.serial, `cmd alarm set-timezone ${config.timeZone}`)
		state.timeZone = config.timeZone
	}
}

// The plan with every path moved onto the device.
const devicePlan = async (config: RunnerConfig, state: SlotState, plan: Plan, runDir: string) => {
	const bundleDir = await pushOnce(config, state, path.dirname(plan.bundle), "bundle")
	const fonts: string[] = []
	for (const font of plan.fonts ?? []) {
		fonts.push(`${await pushOnce(config, state, font, "font")}/${path.basename(font)}`)
	}
	return {
		...plan,
		result: `${runDir}/result.json`,
		bundle: `${bundleDir}/${path.basename(plan.bundle)}`,
		fonts,
		template: { ...plan.template, output: `${runDir}/out/{name}.png` },
	}
}

// A fresh install's state for every run (the host's files, AsyncStorage, preferences), as each macOS host
// process gets an empty home.
const resetHost = async (config: RunnerConfig, state: SlotState) => {
	await shell(config.sdk, state.serial, `pm clear ${HOST_PACKAGE}`)
	if (config.locale) {
		await shell(config.sdk, state.serial, `cmd locale set-app-locales ${HOST_PACKAGE} --locales ${config.locale}`)
	}
}

const startHost = async (config: RunnerConfig, state: SlotState, plan: Plan, runDir: string) => {
	await shell(config.sdk, state.serial, `mkdir -p ${runDir}/out && chmod -R 777 ${runDir}`)
	const local = path.join(path.dirname(plan.result), `device-plan-${process.pid}.json`)
	fs.writeFileSync(local, JSON.stringify(await devicePlan(config, state, plan, runDir)))
	await adb(config.sdk, state.serial, ["push", local, `${runDir}/plan.json`])
	fs.rmSync(local, { force: true })
	await adb(config.sdk, state.serial, ["logcat", "-c"])
	await shell(config.sdk, state.serial, `am start -W -n ${HOST_ACTIVITY} --es plan ${runDir}/plan.json`)
}

const logcat = async (config: RunnerConfig, state: SlotState) =>
	(await adb(config.sdk, state.serial, ["logcat", "-d", "-v", "tag", ...LOG_FILTER], 10_000)).stdout
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)

// Until the host writes its result, or its process is gone without one.
const waitForResult = async (config: RunnerConfig, state: SlotState, runDir: string) => {
	for (let gone = 0; ; ) {
		const status = await shell(
			config.sdk,
			state.serial,
			`test -f ${runDir}/result.json && echo done || (pidof ${HOST_PACKAGE} > /dev/null && echo running || echo gone)`,
		)
		if (status === "done") {
			return true
		}
		// Twice in a row: the process can be between the activity starting and the app's process showing up.
		gone = status === "gone" ? gone + 1 : 0
		if (gone >= 2) {
			return false
		}
		await sleep(POLL_MS)
	}
}

const collect = async (config: RunnerConfig, state: SlotState, plan: Plan, runDir: string) => {
	const staging = fs.mkdtempSync(path.join(path.dirname(plan.result), "pulled-"))
	try {
		await adb(config.sdk, state.serial, ["pull", `${runDir}/result.json`, staging])
		await adb(config.sdk, state.serial, ["pull", `${runDir}/out`, staging])
		const result = JSON.parse(fs.readFileSync(path.join(staging, "result.json"), "utf8")) as { jobs?: JobResult[] }
		const logs = await logcat(config, state)
		for (const job of result.jobs ?? []) {
			const output = plan.template.output.replace("{name}", job.name)
			// The path below out/ on the device, folders and all: a report names renders after their script's path.
			const pulled = path.join(staging, "out", path.relative(`${runDir}/out`, job.output))
			if (job.ok && fs.existsSync(pulled)) {
				fs.mkdirSync(path.dirname(output), { recursive: true })
				fs.copyFileSync(pulled, output)
			} else if (job.ok) {
				job.ok = false
				job.error = `the host wrote ${job.output} on the device, but it did not come back`
			}
			job.output = output
			job.logs = logs
		}
		fs.writeFileSync(plan.result, JSON.stringify(result))
	} finally {
		fs.rmSync(staging, { recursive: true, force: true })
	}
}

// With --verbose, how long each step took, to see where a run's time goes.
const stepTimer = (verbose: boolean) => {
	let last = Date.now()
	return (step: string) => {
		if (verbose) {
			const now = Date.now()
			process.stderr.write(`[info] simless android: ${step} ${now - last}ms\n`)
			last = now
		}
	}
}

const runOnPool = async (config: RunnerConfig, plan: Plan) => {
	const step = stepTimer(Boolean(plan.verbose))
	const slot = await acquireSlot(config.pool, config.emulators)
	step(`slot ${slot.index}`)
	const stateFile = path.join(config.pool, `slot-${slot.index}.json`)
	let state = readState(stateFile)
	try {
		if (!state || !alive(state.pid) || !(await isBooted(config.sdk, state.serial))) {
			state = await bootSlot(config, slot.index)
			fs.writeFileSync(stateFile, JSON.stringify(state))
			step("boot")
		}
		if (state.apk !== config.apkKey) {
			const installed = await adb(config.sdk, state.serial, ["install", "-r", "-t", "-g", config.apk], 300_000)
			if (installed.code !== 0) {
				throw new Error(`adb install failed: ${installed.stderr.trim() || installed.stdout.trim()}`)
			}
			state.apk = config.apkKey
		}
		await configureDisplay(config, state, plan)
		await resetHost(config, state)
		step("display and reset")
		const runDir = `${DEVICE_ROOT}/run-${process.pid}-${Date.now()}`
		await startHost(config, state, plan, runDir)
		step("push and start")
		// The bundle is on the device and the host starting: what is left is the render the time limit is for.
		process.stdout.write(`${READY_LINE}\n`)
		const reported = await waitForResult(config, state, runDir)
		step("run")
		if (reported) {
			await collect(config, state, plan, runDir)
			step("collect")
		} else {
			process.stderr.write(`${(await logcat(config, state)).slice(-40).join("\n")}\n`)
		}
		await shell(config.sdk, state.serial, `am force-stop ${HOST_PACKAGE}; rm -rf ${runDir}`)
		return reported ? 0 : 1
	} finally {
		if (state) {
			fs.writeFileSync(stateFile, JSON.stringify(state))
		}
		slot.release()
	}
}

// `simless show`: an emulator with its window, with animations, until the window is closed.
const runInteractive = async (config: RunnerConfig, plan: Plan) => {
	await waitForSnapshotWriter(config.sdk)
	const port = await freePort(5700)
	const serial = `emulator-${port}`
	const emulator = bootEmulator(config.sdk, port, {
		window: true,
		logFile: path.join(config.pool, `emulator-show-${process.pid}.log`),
		snapshot: config.snapshot,
	})
	const stop = () => {
		emulator.kill()
	}
	process.on("SIGTERM", stop)
	process.on("SIGINT", stop)
	const exited = new Promise<void>((resolve) => emulator.on("exit", () => resolve()))
	await adb(config.sdk, serial, ["wait-for-device"], 120_000)
	await waitForBoot(config.sdk, serial, emulator)
	await ensureRoot(config.sdk, serial)
	await setAnimations(config.sdk, serial, true)
	const state: SlotState = { serial, pid: emulator.pid ?? 0, apk: config.apkKey, pushed: {} }
	await configureDisplay(config, state, plan)
	await resetHost(config, state)
	await startHost(config, state, plan, `${DEVICE_ROOT}/run-show-${process.pid}`)
	// Messages only, as the macOS host prints them; show relays them and maps stacks back to the source.
	const logs = spawn(config.sdk.adb, ["-s", serial, "logcat", "-v", "raw", ...LOG_FILTER], {
		stdio: ["ignore", "inherit", "inherit"],
	})
	await exited
	logs.kill()
	return 0
}

const main = async () => {
	const [planPath = "", configPath = ""] = process.argv.slice(2)
	const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan
	const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as RunnerConfig
	return plan.interactive ? runInteractive(config, plan) : runOnPool(config, plan)
}

main().then(
	(code) => {
		process.exitCode = code
	},
	(error) => {
		process.stderr.write(`simless android: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 1
	},
)
