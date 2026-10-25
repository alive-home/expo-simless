import fs from "node:fs"
import { SourceMap } from "node:module"
import path from "node:path"

const FRAME = /^\s*at (.*?) \(?(?:address at )?(\S+\.jsbundle):(\d+):(\d+)\)?$/
// The runtime's own frames and React's internals say nothing about the component that failed.
const NOISE =
	/^(react|react-native|@react-native|scheduler)\/|^\.cache\/simless\/|metroRequire|guardedLoadModule|loadModuleImplementation/
const MAX_FRAMES = 8

const tryLoad = (sourceMapPath: string): SourceMap | null => {
	try {
		return new SourceMap(JSON.parse(fs.readFileSync(sourceMapPath, "utf8")))
	} catch {
		return null
	}
}

// Rewrites `at fn (…/main.jsbundle:123:45)` frames to the project's source files, drops the noise, and keeps
// the message and any component stack React appended. A bytecode bundle's frames are bytecode offsets, which its
// own map takes back to the JavaScript first.
export const symbolicator = (sourceMapPath: string, projectRoot: string, bytecodeMapPath?: string) => {
	const map = tryLoad(sourceMapPath)
	const bytecodeMap = bytecodeMapPath ? tryLoad(bytecodeMapPath) : null
	const findOrigin = (line: number, column: number): ReturnType<SourceMap["findOrigin"]> => {
		if (!bytecodeMap) {
			return map?.findOrigin(line, column) ?? {}
		}
		const source = bytecodeMap.findOrigin(line, column)
		return "lineNumber" in source ? (map?.findOrigin(source.lineNumber, source.columnNumber) ?? {}) : {}
	}
	// Expo writes sources relative to its server root behind a run of `../`, so the prefix is unreliable; the
	// rest of the path is matched against the project root and each directory above it.
	const bases: string[] = []
	for (let base = projectRoot; !bases.includes(base); base = path.dirname(base)) {
		bases.push(base)
	}
	const locate = (file: string) => {
		if (file.startsWith("file://")) {
			return new URL(file).pathname
		}
		// Node's SourceMap collapses the `../` run against "/", which leaves a path that only looks absolute.
		if (path.isAbsolute(file) && fs.existsSync(file)) {
			return file
		}
		const stripped = file.replace(/^\/+/, "").replace(/^(\.\.\/)+/, "")
		return bases.map((base) => path.join(base, stripped)).find((candidate) => fs.existsSync(candidate)) ?? stripped
	}
	const display = (file: string) => {
		const absolute = locate(file)
		const packaged = absolute.lastIndexOf("node_modules/")
		if (packaged >= 0) {
			return absolute.slice(packaged + "node_modules/".length)
		}
		return path.isAbsolute(absolute) ? path.relative(projectRoot, absolute) : absolute
	}
	return (text: string): string => {
		if (!map) {
			return text
		}
		const out: string[] = []
		let frames = 0
		let skipped = 0
		for (const line of text.split("\n")) {
			const frame = FRAME.exec(line)
			if (!frame) {
				out.push(line)
				continue
			}
			const origin = findOrigin(Number(frame[3]), Number(frame[4]))
			if (!("fileName" in origin)) {
				skipped += 1
				continue
			}
			const location = `${display(origin.fileName)}:${origin.lineNumber}:${origin.columnNumber}`
			if (NOISE.test(location) || NOISE.test(frame[1] ?? "") || frames >= MAX_FRAMES) {
				skipped += 1
				continue
			}
			frames += 1
			out.push(`    at ${origin.name || frame[1]} (${location})`)
		}
		if (skipped > 0) {
			out.push(`    … ${skipped} more frame${skipped === 1 ? "" : "s"}`)
		}
		return out.join("\n")
	}
}
