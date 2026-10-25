import fs from "node:fs"
import path from "node:path"

// What simless caches, and how long it keeps it.
//
// In the project, node_modules/.cache/simless holds what one checkout builds and runs from: the generated native
// projects with their build intermediates (so a native change rebuilds incrementally), and each run's bundle and
// plans while it runs. It goes with node_modules.
//
// In cacheRoot() (~/Library/Caches/simless, or SIMLESS_CACHE, or the config's cacheDir) are the finished hosts, keyed
// by what they were built from, so every checkout and worktree of an app reuses one build; and the Android emulator
// image, one per machine. A host is marked used each time a run takes it, and one unused for MAX_AGE_DAYS is deleted
// by a later run.

const DAY_MS = 24 * 60 * 60 * 1000

export const maxAgeMs = () => (Number(process.env.SIMLESS_CACHE_MAX_AGE_DAYS) || 14) * DAY_MS

export const projectCacheDir = (root: string) => path.join(root, "node_modules", ".cache", "simless")

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

// A cached artifact's last use is its modification time.
export const markUsed = (file: string) => {
	const now = new Date()
	try {
		fs.utimesSync(file, now, now)
	} catch {
		// Gone meanwhile; the run that needs it builds it again.
	}
}

// Deletes the artifacts in `dir` that `matches` and that have not been used for maxAgeMs, apart from `keep`; and the
// scratch copies (`<name>.partial-<pid>`) of builds whose process is gone.
export const pruneUnused = (dir: string, matches: (name: string) => boolean, keep: string[] = []) => {
	if (!fs.existsSync(dir)) {
		return
	}
	const cutoff = Date.now() - maxAgeMs()
	for (const name of fs.readdirSync(dir)) {
		const file = path.join(dir, name)
		const partial = /\.partial-(\d+)$/.exec(name)
		try {
			if (partial) {
				if (!alive(Number(partial[1]))) {
					fs.rmSync(file, { recursive: true, force: true })
				}
			} else if (matches(name) && !keep.includes(file) && fs.statSync(file).mtimeMs < cutoff) {
				fs.rmSync(file, { recursive: true, force: true })
			}
		} catch {
			// Deleted by another run meanwhile.
		}
	}
}

// Marks a run's work directory as one to keep (--keep), which no later run deletes.
export const KEEP_MARKER = ".keep"

// The work directories of runs that ended without removing theirs (killed, or Ctrl-C), kept ones aside.
export const pruneStaleRuns = (root: string) => {
	const dir = projectCacheDir(root)
	if (!fs.existsSync(dir)) {
		return
	}
	for (const name of fs.readdirSync(dir)) {
		const run = /^run-(\d+)-\d+$/.exec(name)
		const file = path.join(dir, name)
		if (run && !alive(Number(run[1])) && !fs.existsSync(path.join(file, KEEP_MARKER))) {
			fs.rmSync(file, { recursive: true, force: true })
		}
	}
}

export const sizeOf = (file: string): number => {
	let stat: fs.Stats
	try {
		stat = fs.lstatSync(file)
	} catch {
		return 0
	}
	if (!stat.isDirectory()) {
		return stat.size
	}
	return fs.readdirSync(file).reduce((total, name) => total + sizeOf(path.join(file, name)), 0)
}

export const formatSize = (bytes: number) =>
	bytes >= 1e9
		? `${(bytes / 1e9).toFixed(1)} GB`
		: bytes >= 1e6
			? `${Math.round(bytes / 1e6)} MB`
			: `${Math.round(bytes / 1e3)} kB`
