import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { type BundleOptions, bundleScript } from "./bundle.ts"
import type { Project } from "./project.ts"
import type { NativeHost, RenderDefaults, Variant } from "./renderer.ts"
import { symbolicator } from "./symbolicate.ts"

export type ShowSession = {
	project: Project
	host: NativeHost
	script: string
	workDir: string
	variant: Variant
	fonts: string[]
	locale?: string
	timeZone?: string
	defaults: RenderDefaults
	// The render to show, with `*` as a wildcard; null for the script's first.
	only: string[] | null
	verbose: boolean
	bundleOptions: BundleOptions
	log: (line: string) => void
}

// Runs a render in a window people can use. Resolves when the window is closed.
export const showScript = async (session: ShowSession): Promise<void> => {
	const { project, workDir, variant, log } = session
	const startedAt = Date.now()
	const bundle = await bundleScript(project, [{ group: "", file: session.script }], workDir, session.bundleOptions)
	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
	const symbolicate = symbolicator(bundle.sourceMapPath, project.root, bundle.bytecodeMapPath)

	const planPath = path.join(workDir, "plan-show.json")
	fs.writeFileSync(
		planPath,
		JSON.stringify({
			result: path.join(workDir, "result-show.json"),
			bundle: bundle.bundlePath,
			fonts: session.fonts,
			verbose: session.verbose,
			locale: session.locale,
			interactive: true,
			selection: JSON.stringify({ indices: null, patterns: session.only, limit: 1 }),
			template: {
				output: path.join(workDir, "{name}.png"),
				width: variant.device.width,
				height: variant.device.height,
				scale: variant.device.scale,
				safeArea: variant.device.safeArea,
				cornerRadius: variant.device.cornerRadius,
				appearance: variant.appearance,
				...session.defaults,
			},
		}),
	)
	const launch = session.host.launch(planPath, {
		locale: session.locale,
		timeZone: session.timeZone,
		home: path.join(workDir, "home-show"),
	})
	const child = spawn(launch.command, launch.args, {
		env: launch.env,
		stdio: ["ignore", "pipe", "pipe"],
	})
	// Line by line, so a stack trace that arrives in pieces is still mapped back to the source.
	const relay = (stream: NodeJS.ReadableStream) => {
		let pending = ""
		stream.on("data", (chunk: Buffer) => {
			pending += chunk
			const lines = pending.split("\n")
			pending = lines.pop() ?? ""
			for (const line of lines) {
				if (session.verbose || !line.startsWith("[info] simless")) {
					process.stderr.write(`${symbolicate(line)}\n`)
				}
			}
		})
	}
	relay(child.stdout)
	relay(child.stderr)
	log(
		`Showing on ${variant.device.name} (${variant.appearance}), bundled in ${seconds}s. ` +
			"Close the window or press Ctrl-C to stop.",
	)

	const stop = () => {
		child.kill("SIGTERM")
	}
	process.on("SIGINT", stop)
	process.on("SIGTERM", stop)
	await new Promise<void>((resolve) => {
		child.on("close", () => resolve())
	})
	process.off("SIGINT", stop)
	process.off("SIGTERM", stop)
}
