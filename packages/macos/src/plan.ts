import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Appearance, type Device, type JobResult, run } from "expo-simless/renderer"
import { launchHost } from "./launch.ts"

// One SwiftUI view on one device in one appearance.
export type Job = {
	id: string
	name: string
	output: string
	component: string
	device: Device
	appearance: Appearance
	background?: string
	settleMs: number
	timeoutMs: number
	fit: boolean
	padding: number
}

export type HostRun = {
	executable: string
	fonts: string[]
	verbose: boolean
	workDir: string
	locale?: string
}

const STARTUP_ALLOWANCE_MS = 30_000

const toPlanJob = (job: Job) => ({
	id: job.id,
	name: job.name,
	output: job.output,
	component: job.component,
	width: job.device.width,
	height: job.device.height,
	scale: job.device.scale,
	// A component cropped to its content is not on a screen, so it gets no status bar or home indicator inset.
	safeArea: job.fit ? { top: 0, right: 0, bottom: 0, left: 0 } : job.device.safeArea,
	cornerRadius: job.device.cornerRadius,
	appearance: job.appearance,
	background: job.background,
	settleMs: job.settleMs,
	timeoutMs: job.timeoutMs,
	fit: job.fit,
	padding: job.padding,
})

const runGroup = async (host: HostRun, jobs: Job[], index: number): Promise<JobResult[]> => {
	const planPath = path.join(host.workDir, `plan-${index}.json`)
	const resultPath = path.join(host.workDir, `result-${index}.json`)
	fs.writeFileSync(
		planPath,
		JSON.stringify({
			result: resultPath,
			fonts: host.fonts,
			verbose: host.verbose,
			locale: host.locale,
			jobs: jobs.map(toPlanJob),
		}),
	)
	const timeoutMs = STARTUP_ALLOWANCE_MS + jobs.reduce((total, job) => total + job.timeoutMs, 0)
	// An empty home per process, so what a view saves is never read by a later one or one running next to it.
	const launch = launchHost(host.executable, planPath, {
		locale: host.locale,
		home: path.join(host.workDir, `home-${index}`),
	})
	const child = await run(launch.command, launch.args, {
		env: launch.env,
		inherit: host.verbose,
		timeoutMs,
	})
	if (fs.existsSync(resultPath)) {
		return (JSON.parse(fs.readFileSync(resultPath, "utf8")) as { jobs: JobResult[] }).jobs
	}
	const tail = child.stderr.trim().split("\n").slice(-30).join("\n")
	const reason = `the host exited (code ${child.code}) before reporting${tail ? `:\n${tail}` : ""}`
	return jobs.map((job) => ({
		id: job.id,
		name: job.name,
		output: job.output,
		ok: false,
		settled: false,
		durationMs: 0,
		logs: [],
		error: reason,
	}))
}

// One host process per device and appearance, since React Native reads Dimensions, PixelRatio and the color scheme
// once at startup; and per component, since one can leave state behind in the process that changes the next (a
// pushed screen left iOS 26's scroll edge effect showing over a sheet rendered after it).
export const runJobs = async (host: HostRun, jobs: Job[]): Promise<JobResult[]> => {
	const groups = new Map<string, Job[]>()
	for (const job of jobs) {
		const key = `${job.device.name}/${job.appearance}/${job.component}`
		groups.set(key, [...(groups.get(key) ?? []), job])
	}
	const queue = [...groups.values()].map((group, index) => ({ group, index }))
	const results: JobResult[] = []
	const workers = Math.max(1, Math.min(queue.length, Math.floor(os.availableParallelism() / 2)))
	await Promise.all(
		Array.from({ length: workers }, async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				results.push(...(await runGroup(host, next.group, next.index)))
			}
		}),
	)
	const order = new Map(jobs.map((job, index) => [job.id, index]))
	return results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}
