import fs from "node:fs"
import path from "node:path"
import { pixelChange } from "./png.ts"
import { run } from "./process.ts"
import type { Appearance, Variant } from "./renderer.ts"
import { reportPage } from "./reportPage.ts"
import { groupOf, type RenderOutcome, type ScriptError } from "./script.ts"

// What `simless report` writes next to the PNGs: report.json for tools, report.md for people and LLMs (it names
// every image, so a reader opens only the ones it needs), index.html to look through.

const REPORT_VERSION = 1

type ReportImage = {
	device: string
	appearance: Appearance
	image: string
	ok: boolean
	settled: boolean
	durationMs: number
	error?: string
	// With --compare: the earlier report's image, copied under before/, and the share of pixels that differ (0 to 1).
	before?: string
	change?: number
}

type ReportRender = {
	name: string
	images: ReportImage[]
}

type ReportGroup = {
	name: string
	renders: ReportRender[]
}

type Git = {
	branch: string
	commit: string
	dirty: boolean
}

export type Report = {
	version: number
	createdAt: string
	durationMs: number
	git: Git | null
	// The project's package name, or its folder's.
	project: string
	devices: Array<{ name: string; width: number; height: number; scale: number; cornerRadius: number }>
	appearances: Appearance[]
	summary: { images: number; ok: number; failed: number; unsettled: number }
	groups: ReportGroup[]
	errors: ScriptError[]
	// With --compare: the report the images were compared with.
	compare?: Comparison
}

type Comparison = {
	git: Git | null
	createdAt: string
	changed: number
	same: number
	// Images with nothing to compare with: new renders or devices.
	added: number
	// Renders the earlier report had and this one does not, as group/name, among the scripts this one ran.
	removed: string[]
}

type ReportInput = {
	outDir: string
	projectRoot: string
	names: string[]
	renders: RenderOutcome[]
	errors: ScriptError[]
	variants: Variant[]
	startedAt: number
	// An earlier report's folder, to set each image beside.
	compare?: string
}

const gitState = async (root: string): Promise<Git | null> => {
	const git = (args: string[]) => run("git", args, { cwd: root })
	const [branch, commit, status] = await Promise.all([
		git(["rev-parse", "--abbrev-ref", "HEAD"]),
		git(["rev-parse", "--short", "HEAD"]),
		git(["status", "--porcelain"]),
	]).catch(() => [])
	if (!branch || !commit || !status || branch.code !== 0 || commit.code !== 0) {
		return null
	}
	return { branch: branch.stdout.trim(), commit: commit.stdout.trim(), dirty: status.stdout.trim() !== "" }
}

const projectName = (root: string) => {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string }
		return manifest.name ?? path.basename(root)
	} catch {
		return path.basename(root)
	}
}

// Less than this share of pixels differing is a sub-pixel shift between runs, not a change.
const CHANGE_THRESHOLD = 0.02

export const isChanged = (change: number | undefined) => change !== undefined && change >= CHANGE_THRESHOLD

const fullName = (group: string, render: string) => (group ? `${group}/${render}` : render)

// Sets each image beside the earlier report's for the same render, device and appearance, copying the earlier one
// into this report's before/ folder so the report stands on its own.
const compareWith = (report: Report, outDir: string, earlierDir: string): Comparison => {
	const earlier = JSON.parse(fs.readFileSync(path.join(earlierDir, "report.json"), "utf8")) as Report
	const earlierImages = new Map<string, string>()
	for (const group of earlier.groups) {
		for (const render of group.renders) {
			for (const image of render.images) {
				if (image.ok) {
					earlierImages.set(`${fullName(group.name, render.name)}|${image.device}|${image.appearance}`, image.image)
				}
			}
		}
	}
	const current = new Set<string>()
	let changed = 0
	let same = 0
	let added = 0
	for (const group of report.groups) {
		for (const render of group.renders) {
			current.add(fullName(group.name, render.name))
			for (const image of render.images) {
				const before = earlierImages.get(`${fullName(group.name, render.name)}|${image.device}|${image.appearance}`)
				const beforeFile = before ? path.join(earlierDir, before) : null
				if (!image.ok || !beforeFile || !fs.existsSync(beforeFile)) {
					added += image.ok ? 1 : 0
					continue
				}
				const copy = path.join(outDir, "before", before as string)
				fs.mkdirSync(path.dirname(copy), { recursive: true })
				fs.copyFileSync(beforeFile, copy)
				image.before = toPosix(path.relative(outDir, copy))
				image.change = pixelChange(fs.readFileSync(beforeFile), fs.readFileSync(path.join(outDir, image.image)))
				if (isChanged(image.change)) {
					changed += 1
				} else {
					same += 1
				}
			}
		}
	}
	// Only scripts this report ran: a report of some scripts says nothing about the others.
	const groups = new Set(report.groups.map((group) => group.name))
	const removed = earlier.groups
		.filter((group) => groups.has(group.name))
		.flatMap((group) => group.renders.map((render) => fullName(group.name, render.name)))
		.filter((name) => !current.has(name))
	return { git: earlier.git, createdAt: earlier.createdAt, changed, same, added, removed }
}

const toPosix = (file: string) => file.split(path.sep).join("/")

const buildReport = async (input: ReportInput): Promise<Report> => {
	const devices = [...new Map(input.variants.map(({ device }) => [device.name, device])).values()]
	const appearances = [...new Set(input.variants.map(({ appearance }) => appearance))]
	const deviceOrder = (name: string) => devices.findIndex((device) => device.name === name)
	const groups = new Map<string, Map<string, ReportImage[]>>()
	for (const name of input.names) {
		const group = groupOf(name)
		const renders = groups.get(group) ?? new Map<string, ReportImage[]>()
		renders.set(name, [])
		groups.set(group, renders)
	}
	for (const render of input.renders) {
		const images = groups.get(groupOf(render.name))?.get(render.name)
		images?.push({
			device: render.device,
			appearance: render.appearance,
			image: toPosix(path.relative(input.outDir, render.output)),
			ok: render.ok,
			settled: render.settled,
			durationMs: render.durationMs,
			...(render.error ? { error: render.error } : {}),
		})
	}
	const all = input.renders
	return {
		version: REPORT_VERSION,
		createdAt: new Date().toISOString(),
		durationMs: Date.now() - input.startedAt,
		git: await gitState(input.projectRoot),
		project: projectName(input.projectRoot),
		devices: devices.map(({ name, width, height, scale, cornerRadius }) => ({
			name,
			width,
			height,
			scale,
			cornerRadius,
		})),
		appearances,
		summary: {
			images: all.length,
			ok: all.filter((render) => render.ok).length,
			failed: all.filter((render) => !render.ok).length,
			unsettled: all.filter((render) => render.ok && !render.settled).length,
		},
		groups: [...groups].map(([name, renders]) => ({
			name,
			renders: [...renders].map(([full, images]) => ({
				name: name ? full.slice(name.length + 1) : full,
				images: images.sort(
					(a, b) =>
						appearances.indexOf(a.appearance) - appearances.indexOf(b.appearance) ||
						deviceOrder(a.device) - deviceOrder(b.device),
				),
			})),
		})),
		errors: input.errors,
	}
}

const firstLine = (text: string) => text.split("\n")[0]?.slice(0, 200) ?? ""

const duration = (ms: number) => {
	const seconds = Math.round(ms / 1000)
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const markdown = (report: Report): string => {
	const { summary, git } = report
	const lines = [
		"# simless report",
		"",
		[
			git ? `${git.branch} @ ${git.commit}${git.dirty ? " with uncommitted changes" : ""}` : null,
			report.createdAt.replace("T", " ").slice(0, 16),
			`${summary.images} images in ${duration(report.durationMs)}`,
		]
			.filter(Boolean)
			.join(" · "),
		"",
		`${summary.ok} drawn, ${summary.failed} failed${summary.unsettled > 0 ? `, ${summary.unsettled} still changing at the timeout` : ""}.`,
		"",
		"Images are PNGs relative to this file, one per render, device and appearance; open only the ones you need.",
		`Devices: ${report.devices.map((device) => `${device.name} ${device.width}x${device.height}pt @${device.scale}x`).join(", ")}.`,
		"",
	]
	const failed = report.groups.flatMap((group) =>
		group.renders.flatMap((render) =>
			render.images
				.filter((image) => !image.ok)
				.map((image) => ({ name: group.name ? `${group.name}/${render.name}` : render.name, image })),
		),
	)
	if (failed.length > 0 || report.errors.length > 0) {
		lines.push("## Failed", "")
		for (const { name, image } of failed) {
			lines.push(`- ${name} (${image.device}, ${image.appearance}): ${firstLine(image.error ?? "failed")}`)
		}
		for (const error of report.errors) {
			lines.push(`- A script stopped (${error.device}, ${error.appearance}): ${firstLine(error.error)}`)
		}
		lines.push("")
	}
	const comparison = report.compare
	if (comparison) {
		const against = comparison.git ? `${comparison.git.branch} @ ${comparison.git.commit}` : "an earlier report"
		lines.push(
			"## Changed",
			"",
			`Compared with ${against} (${comparison.createdAt.replace("T", " ").slice(0, 16)}): ${comparison.changed} changed, ` +
				`${comparison.same} the same (under ${CHANGE_THRESHOLD * 100}% of pixels), ${comparison.added} new.` +
				(comparison.removed.length > 0 ? ` Gone: ${comparison.removed.join(", ")}.` : ""),
			"",
		)
		for (const group of report.groups) {
			for (const render of group.renders) {
				for (const image of render.images) {
					if (isChanged(image.change) && image.before) {
						lines.push(
							`- ${fullName(group.name, render.name)} (${image.device}, ${image.appearance}): ` +
								`${((image.change ?? 0) * 100).toFixed(1)}% of pixels, before ${encodeURI(image.before)}, after ${encodeURI(image.image)}`,
						)
					}
				}
			}
		}
		lines.push("")
	}
	const columns = report.appearances.flatMap((appearance) =>
		report.devices.map((device) => ({ device: device.name, appearance })),
	)
	const heading = (column: { device: string; appearance: Appearance }) =>
		report.appearances.length > 1 ? `${column.device} ${column.appearance}` : column.device
	for (const group of report.groups) {
		lines.push(`## ${group.name || "renders"}`, "")
		lines.push(`| Render | ${columns.map(heading).join(" | ")} |`)
		lines.push(`| --- | ${columns.map(() => "---").join(" | ")} |`)
		for (const render of group.renders) {
			const cells = columns.map((column) => {
				const image = render.images.find(
					(candidate) => candidate.device === column.device && candidate.appearance === column.appearance,
				)
				if (!image) {
					return ""
				}
				if (!image.ok) {
					return "failed"
				}
				return `[png](${encodeURI(image.image)})${image.settled ? "" : " (changing)"}`
			})
			lines.push(`| ${render.name} | ${cells.join(" | ")} |`)
		}
		lines.push("")
	}
	return lines.join("\n")
}

// Marks a folder as a report's from the start of the run, so one that stopped halfway (no report.json yet) is
// still recognized as simless's own and emptied by the next.
const REPORT_MARKER = ".simless-report"

// The folder holds only a report: it is emptied first, so a render that is gone leaves no stale image behind.
export const prepareReportDir = (outDir: string) => {
	if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
		const isReport = ["report.json", REPORT_MARKER].some((file) => fs.existsSync(path.join(outDir, file)))
		if (!isReport) {
			throw new Error(`${outDir} is not empty and holds no earlier report; pick another --out`)
		}
		fs.rmSync(outDir, { recursive: true, force: true })
	}
	fs.mkdirSync(outDir, { recursive: true })
	fs.writeFileSync(path.join(outDir, REPORT_MARKER), "")
}

export const writeReport = async (input: ReportInput): Promise<{ html: string; markdown: string; report: Report }> => {
	const report = await buildReport(input)
	if (input.compare) {
		report.compare = compareWith(report, input.outDir, input.compare)
	}
	const files = {
		json: path.join(input.outDir, "report.json"),
		markdown: path.join(input.outDir, "report.md"),
		html: path.join(input.outDir, "index.html"),
	}
	fs.writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`)
	fs.writeFileSync(files.markdown, markdown(report))
	fs.writeFileSync(files.html, reportPage(report))
	return { html: files.html, markdown: files.markdown, report }
}
