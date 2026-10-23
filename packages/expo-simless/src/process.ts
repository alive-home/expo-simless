import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// The Node to run the Expo CLI, autolinking and other tools with. Under Bun (`bunx --bun simless`) that is the first
// `node` on the PATH that is not Bun itself, since Expo's config loader does not run on Bun and `bunx --bun` puts a
// `node` linked to Bun first on the PATH. Its directory then goes first on this process's PATH, so the tools those
// start in turn (fingerprinting, the Podfile's autolinking, Gradle's) find it too.
const findNode = (): string => {
	if (!process.versions.bun) {
		return process.execPath
	}
	const bun = fs.realpathSync(process.execPath)
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(directory, "node")
		try {
			if (fs.realpathSync(candidate) !== bun) {
				fs.accessSync(candidate, fs.constants.X_OK)
				process.env.PATH = [directory, process.env.PATH].join(path.delimiter)
				return candidate
			}
		} catch {}
	}
	throw new Error("simless runs the Expo CLI with Node, and found no node on the PATH besides Bun")
}

export const NODE = findNode()

export const cacheRoot = (): string =>
	process.env.SIMLESS_CACHE ?? path.join(os.homedir(), "Library", "Caches", "simless")

export type RunOptions = {
	cwd?: string
	env?: NodeJS.ProcessEnv
	// Stream the child's output instead of only returning it.
	inherit?: boolean
	timeoutMs?: number
}

export type RunResult = {
	code: number
	stdout: string
	stderr: string
}

export const run = (command: string, args: string[], options: RunOptions = {}): Promise<RunResult> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk
			if (options.inherit) {
				process.stderr.write(chunk)
			}
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk
			if (options.inherit) {
				process.stderr.write(chunk)
			}
		})
		const timer = options.timeoutMs
			? setTimeout(() => {
					child.kill("SIGKILL")
				}, options.timeoutMs)
			: null
		child.on("error", reject)
		child.on("close", (code, signal) => {
			if (timer) {
				clearTimeout(timer)
			}
			resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr })
		})
	})

export const runOrThrow = async (command: string, args: string[], options: RunOptions = {}): Promise<RunResult> => {
	const result = await run(command, args, options)
	if (result.code !== 0) {
		const output = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-40).join("\n")
		throw new Error(`${path.basename(command)} ${args[0] ?? ""} failed (exit ${result.code})\n${output}`)
	}
	return result
}

export const hashOf = (parts: Array<string | Buffer>): string => {
	const hash = createHash("sha256")
	for (const part of parts) {
		hash.update(part)
		hash.update("\0")
	}
	return hash.digest("hex").slice(0, 16)
}

// Builds into a scratch directory and renames it into place, so a killed build never leaves a half-made app
// that a later run would trust.
export const buildAtomically = async (destination: string, build: (scratch: string) => Promise<void>) => {
	const scratch = `${destination}.partial-${process.pid}`
	fs.rmSync(scratch, { recursive: true, force: true })
	fs.mkdirSync(scratch, { recursive: true })
	try {
		await build(scratch)
		fs.rmSync(destination, { recursive: true, force: true })
		fs.renameSync(scratch, destination)
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true })
	}
}
