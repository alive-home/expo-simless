import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { markUsed, pruneUnused, run } from "@alivelabs/expo-simless/renderer"
import { type AndroidSdk, avdHome, sdkEnv } from "./sdk.ts"

export const HOST_PACKAGE = "dev.simless.host"
export const HOST_ACTIVITY = `${HOST_PACKAGE}/.SimlessActivity`
// Where the runner keeps bundles, fonts and each run's plan and PNGs on the device.
export const DEVICE_ROOT = "/data/local/tmp/simless"
// What the runner prints once it has an emulator set up for its plan, with the bundle on it and the host starting;
// the CLI's time limit for the render starts then, not while it waits for an emulator, boots one or pushes to it.
export const READY_LINE = "simless android: ready"

// The state every run starts from: booted, adbd running as root, SELinux permissive (so the host reads what the
// runner pushes to /data/local/tmp), gesture navigation, no lock screen, animations off.
export const BASE_SNAPSHOT = "simless"
// The base with a host APK installed, one per APK; booting it skips the install.
export const hostSnapshotOf = (apkKey: string) => `host-${apkKey}`
const BOOT_TIMEOUT_MS = 180_000
const POLL_MS = 100

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const avdNameOf = (sdk: AndroidSdk) => `simless-${sdk.image.api}-${sdk.image.tag}-${sdk.image.abi}`

export const adb = (sdk: AndroidSdk, serial: string, args: string[], timeoutMs?: number) =>
	run(sdk.adb, ["-s", serial, ...args], { env: sdkEnv(sdk), timeoutMs })

export const shell = async (sdk: AndroidSdk, serial: string, command: string) => {
	const result = await adb(sdk, serial, ["shell", command], 60_000)
	if (result.code !== 0) {
		throw new Error(
			`adb shell ${command} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
		)
	}
	return result.stdout.trim()
}

const portFree = (port: number) =>
	new Promise<boolean>((resolve) => {
		const server = net.createServer()
		server.once("error", () => resolve(false))
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
	})

// An emulator takes a console port and the one after it; ports from 5600 keep clear of Android Studio's 5554 on.
export const freePort = async (from = 5600): Promise<number> => {
	for (let port = from; port < 5900; port += 2) {
		if ((await portFree(port)) && (await portFree(port + 1))) {
			return port
		}
	}
	throw new Error("No free port pair for an emulator between 5600 and 5900")
}

export const bootEmulator = (
	sdk: AndroidSdk,
	port: number,
	// `snapshot` boots from that snapshot, read-only unless `writable`; without it the AVD boots cold.
	options: { window: boolean; logFile: string; snapshot?: string; writable?: boolean },
): ChildProcess => {
	const log = fs.openSync(options.logFile, "a")
	return spawn(
		sdk.emulator,
		[
			"-avd",
			avdNameOf(sdk),
			"-port",
			String(port),
			"-no-audio",
			"-no-boot-anim",
			"-gpu",
			"host",
			...(options.snapshot
				? ["-snapshot", options.snapshot, "-no-snapshot-save", ...(options.writable ? [] : ["-read-only"])]
				: ["-no-snapshot-load"]),
			...(options.window ? [] : ["-no-window"]),
		],
		// A headless one outlives the runner that boots it, for the next render; the CLI stops it when it ends.
		{ env: sdkEnv(sdk), detached: !options.window, stdio: ["ignore", log, log] },
	)
}

export const waitForBoot = async (sdk: AndroidSdk, serial: string, emulator?: ChildProcess) => {
	const started = Date.now()
	while (Date.now() - started < BOOT_TIMEOUT_MS) {
		if (emulator && emulator.exitCode !== null) {
			throw new Error(`the emulator exited (code ${emulator.exitCode}) while booting`)
		}
		const result = await adb(sdk, serial, ["shell", "getprop", "sys.boot_completed"], 5_000)
		if (result.stdout.trim() === "1") {
			return
		}
		await sleep(POLL_MS)
	}
	throw new Error(`${serial} did not finish booting in ${BOOT_TIMEOUT_MS / 1000}s`)
}

// The snapshot carries both; a cold boot (an emulator update that cannot load the snapshot) does not.
export const ensureRoot = async (sdk: AndroidSdk, serial: string) => {
	if ((await shell(sdk, serial, "id -u")) !== "0") {
		await adb(sdk, serial, ["root"], 30_000)
		await adb(sdk, serial, ["wait-for-device"], 60_000)
	}
	await shell(sdk, serial, "setenforce 0")
}

export const setAnimations = (sdk: AndroidSdk, serial: string, on: boolean) => {
	const scale = on ? 1 : 0
	return shell(
		sdk,
		serial,
		["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]
			.map((name) => `settings put global ${name} ${scale}`)
			.join("; "),
	)
}

const SETUP = [
	"cmd overlay enable com.android.internal.systemui.navbar.gestural",
	"settings put secure show_ime_with_hard_keyboard 0",
	"settings put system screen_off_timeout 2147483647",
	"svc power stayon true",
	"locksettings set-disabled true",
	"wm dismiss-keyguard",
	"settings put global sysui_demo_allowed 1",
	"settings put global package_verifier_enable 0",
	"settings put global verifier_verify_adb_installs 0",
]

const snapshotsDir = (sdk: AndroidSdk) => path.join(avdHome(), `${avdNameOf(sdk)}.avd`, "snapshots")

export const hasSnapshot = (sdk: AndroidSdk, name: string) => fs.existsSync(path.join(snapshotsDir(sdk), name))

const createAvd = (sdk: AndroidSdk) => {
	fs.mkdirSync(avdHome(), { recursive: true })
	execFileSync(
		sdk.avdmanager,
		["create", "avd", "--force", "-n", avdNameOf(sdk), "-k", sdk.image.id, "-d", "pixel_9"],
		{
			env: sdkEnv(sdk),
			input: "no\n",
			stdio: ["pipe", "ignore", "pipe"],
		},
	)
	const config = path.join(avdHome(), `${avdNameOf(sdk)}.avd`, "config.ini")
	const settings: Record<string, string> = {
		"hw.gpu.enabled": "yes",
		"hw.gpu.mode": "host",
		// A hardware keyboard keeps the on-screen one from covering a focused field in a capture.
		"hw.keyboard": "yes",
		"hw.audioInput": "no",
		showDeviceFrame: "no",
		"disk.dataPartition.size": "6G",
	}
	const lines = fs
		.readFileSync(config, "utf8")
		.split("\n")
		.filter((line) => !Object.keys(settings).some((key) => line.startsWith(`${key}=`)))
	fs.writeFileSync(config, [...lines, ...Object.entries(settings).map(([key, value]) => `${key}=${value}`)].join("\n"))
}

type SnapshotSpec = {
	name: string
	// The snapshot it starts from, or none for a cold boot of a new AVD.
	from?: string
	message: string
	prepare: (serial: string) => Promise<void>
	// Run once the snapshot is saved, while no emulator has the AVD open.
	afterSave?: () => void
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

// Held by the run making a snapshot, which boots the AVD writable.
const snapshotLockOf = (sdk: AndroidSdk) => path.join(avdHome(), `${avdNameOf(sdk)}.lock`)

const lockOwner = (lock: string) =>
	Number(fs.readFileSync(path.join(lock, "owner"), { encoding: "utf8", flag: "a+" }) || 0)

// Held unless its owner is gone; one just made has no owner yet, and counts as held.
const isLockHeld = (lock: string) => {
	if (!fs.existsSync(lock)) {
		return false
	}
	const owner = lockOwner(lock)
	return owner === 0 || alive(owner)
}

const takeLock = (lock: string): boolean => {
	try {
		fs.mkdirSync(lock)
	} catch {
		if (isLockHeld(lock)) {
			return false
		}
		// Its owner was killed while making a snapshot.
		fs.rmSync(lock, { recursive: true, force: true })
		return takeLock(lock)
	}
	fs.writeFileSync(path.join(lock, "owner"), String(process.pid))
	return true
}

// The emulator boots an AVD writable only while no other instance has it open, and an emulator booted meanwhile
// would start from a snapshot being written; so a run waits for one being made before it boots.
export const waitForSnapshotWriter = async (sdk: AndroidSdk) => {
	while (isLockHeld(snapshotLockOf(sdk))) {
		await sleep(1000)
	}
}

// The emulators that have simless's AVD open now: every run's, and `show`'s.
const openEmulators = (sdk: AndroidSdk) => {
	try {
		return execFileSync("pgrep", ["-f", "--", `-avd ${avdNameOf(sdk)} `], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean).length
	} catch {
		// pgrep exits 1 when nothing matches.
		return 0
	}
}

// Boots, prepares and saves one snapshot of simless's AVD, once. Concurrent runs wait on the one making it, and it
// waits for the emulators other runs have open, since the AVD only boots writable with none.
const ensureSnapshot = async (sdk: AndroidSdk, spec: SnapshotSpec, log: (line: string) => void, logFile: string) => {
	if (hasSnapshot(sdk, spec.name)) {
		return
	}
	const lock = snapshotLockOf(sdk)
	fs.mkdirSync(avdHome(), { recursive: true })
	if (!takeLock(lock)) {
		while (isLockHeld(lock) && !hasSnapshot(sdk, spec.name)) {
			await sleep(1000)
		}
		if (!hasSnapshot(sdk, spec.name)) {
			await ensureSnapshot(sdk, spec, log, logFile)
		}
		return
	}
	try {
		if (openEmulators(sdk) > 0) {
			log("Waiting for another simless run's Android emulators to close…")
			while (openEmulators(sdk) > 0) {
				await sleep(2000)
			}
		}
		log(spec.message)
		if (!spec.from) {
			createAvd(sdk)
		}
		const port = await freePort()
		const serial = `emulator-${port}`
		const emulator = bootEmulator(sdk, port, { window: false, logFile, snapshot: spec.from, writable: true })
		try {
			await adb(sdk, serial, ["wait-for-device"], BOOT_TIMEOUT_MS)
			await waitForBoot(sdk, serial, emulator)
			await ensureRoot(sdk, serial)
			await spec.prepare(serial)
			const saved = await adb(sdk, serial, ["emu", "avd", "snapshot", "save", spec.name], 120_000)
			if (!hasSnapshot(sdk, spec.name)) {
				throw new Error(`the emulator did not save its snapshot: ${saved.stdout.trim()} ${saved.stderr.trim()}`)
			}
		} finally {
			await adb(sdk, serial, ["emu", "kill"], 10_000)
			emulator.kill()
		}
		spec.afterSave?.()
	} finally {
		fs.rmSync(lock, { recursive: true, force: true })
	}
}

// Host snapshots kept, each about a gigabyte: one per app (or native change) in use, so two apps on one Mac do not
// replace each other's at every switch.
const MAX_HOST_SNAPSHOTS = 4

const pruneHostSnapshots = (sdk: AndroidSdk, current: string) => {
	const dir = snapshotsDir(sdk)
	pruneUnused(dir, (name) => name.startsWith("host-"), [path.join(dir, current)])
	const rest = fs
		.readdirSync(dir)
		.filter((name) => name.startsWith("host-") && name !== current)
		.map((name) => ({ name, used: fs.statSync(path.join(dir, name)).mtimeMs }))
		.sort((a, b) => b.used - a.used)
	for (const { name } of rest.slice(MAX_HOST_SNAPSHOTS - 1)) {
		fs.rmSync(path.join(dir, name), { recursive: true, force: true })
	}
}

// simless's own AVD, booted once and set up, then the host APK installed on it: the snapshot every run boots from.
// Host snapshots no run has booted for a while are deleted when another is made.
export const ensureHostSnapshot = async (
	sdk: AndroidSdk,
	apk: string,
	apkKey: string,
	log: (line: string) => void,
	logFile: string,
) => {
	await ensureSnapshot(
		sdk,
		{
			name: BASE_SNAPSHOT,
			message: `Setting up simless's Android emulator (${sdk.image.id}), once…`,
			prepare: async (serial) => {
				await shell(sdk, serial, SETUP.join("; "))
				await setAnimations(sdk, serial, false)
				// Lets the launcher and SystemUI finish what the first boot starts, so the snapshot is of a quiet device.
				await sleep(5000)
			},
		},
		log,
		logFile,
	)
	const name = hostSnapshotOf(apkKey)
	await ensureSnapshot(
		sdk,
		{
			name,
			from: BASE_SNAPSHOT,
			message: "Installing the host on simless's Android emulator…",
			prepare: async (serial) => {
				const installed = await adb(sdk, serial, ["install", "-r", "-t", "-g", apk], 300_000)
				if (installed.code !== 0) {
					throw new Error(`adb install failed: ${installed.stderr.trim() || installed.stdout.trim()}`)
				}
			},
			afterSave: () => pruneHostSnapshots(sdk, name),
		},
		log,
		logFile,
	)
	markUsed(path.join(snapshotsDir(sdk), name))
	return name
}
