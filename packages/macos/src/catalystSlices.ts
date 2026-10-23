import fs from "node:fs"
import path from "node:path"
import { runOrThrow } from "expo-simless/renderer"

// Prebuilt static libraries shipped as xcframeworks often have iOS, simulator and macOS slices and no Mac
// Catalyst one (Skia). A Catalyst object is the same arm64 code as an iOS one; what differs is the platform in
// its LC_BUILD_VERSION, which the linker checks. So the missing slice is the iOS arm64 library with that field
// rewritten in every object, added to the xcframework next to the others, where an iOS build never looks.

const SLICE_ID = "ios-arm64-maccatalyst"
const MH_MAGIC_64 = 0xfeedfacf
const MH_OBJECT = 0x1
const LC_BUILD_VERSION = 0x32
const PLATFORM_MACCATALYST = 6
// 17.0, the host's deployment target, encoded as xxxx.yy.zz.
const MIN_OS = 17 << 16

type Library = {
	LibraryIdentifier: string
	LibraryPath: string
	HeadersPath?: string
	SupportedArchitectures: string[]
	SupportedPlatform: string
	SupportedPlatformVariant?: string
	BinaryPath?: string
}

type XcframeworkInfo = {
	AvailableLibraries: Library[]
	[key: string]: unknown
}

const readPlist = async (file: string) =>
	JSON.parse((await runOrThrow("plutil", ["-convert", "json", "-o", "-", file])).stdout) as XcframeworkInfo

// Written beside and renamed over: files under node_modules/.pnpm are hard links into pnpm's global store, and
// writing one in place would change it for every project on the machine.
const writePlist = async (file: string, value: XcframeworkInfo) => {
	const json = `${file}.rnh.json`
	const plist = `${file}.rnh.plist`
	fs.writeFileSync(json, JSON.stringify(value))
	await runOrThrow("plutil", ["-convert", "xml1", "-o", plist, json])
	fs.rmSync(json)
	fs.renameSync(plist, file)
}

// Rewrites the platform of one Mach-O object in place. Returns false when the object has no LC_BUILD_VERSION
// (an old LC_VERSION_MIN_IPHONEOS is smaller and cannot be rewritten in place).
const retargetObject = (data: Buffer, offset: number): boolean => {
	if (data.readUInt32LE(offset) !== MH_MAGIC_64 || data.readUInt32LE(offset + 12) !== MH_OBJECT) {
		return true
	}
	const commands = data.readUInt32LE(offset + 16)
	let cursor = offset + 32
	for (let index = 0; index < commands; index += 1) {
		const command = data.readUInt32LE(cursor)
		const size = data.readUInt32LE(cursor + 4)
		if (command === LC_BUILD_VERSION) {
			data.writeUInt32LE(PLATFORM_MACCATALYST, cursor + 8)
			data.writeUInt32LE(MIN_OS, cursor + 12)
			return true
		}
		cursor += size
	}
	return false
}

// Walks a BSD ar archive (what libtool writes) and retargets every member.
const retargetArchive = (data: Buffer): number => {
	if (data.toString("latin1", 0, 8) !== "!<arch>\n") {
		throw new Error("not an ar archive")
	}
	let cursor = 8
	let skipped = 0
	while (cursor + 60 <= data.length) {
		const name = data.toString("latin1", cursor, cursor + 16).trim()
		const size = Number(data.toString("latin1", cursor + 48, cursor + 58).trim())
		const extendedName = name.startsWith("#1/") ? Number(name.slice(3)) : 0
		const body = cursor + 60 + extendedName
		if (!retargetObject(data, body)) {
			skipped += 1
		}
		cursor += 60 + size
		cursor += cursor % 2
	}
	return skipped
}

const addCatalystSlice = async (xcframework: string, log: (line: string) => void): Promise<boolean> => {
	const infoPath = path.join(xcframework, "Info.plist")
	const info = await readPlist(infoPath)
	const libraries = info.AvailableLibraries
	if (libraries.some((library) => library.SupportedPlatformVariant === "maccatalyst")) {
		return false
	}
	const device = libraries.find(
		(library) =>
			library.SupportedPlatform === "ios" &&
			!library.SupportedPlatformVariant &&
			library.SupportedArchitectures.includes("arm64"),
	)
	if (!device) {
		return false
	}
	const source = path.join(xcframework, device.LibraryIdentifier, device.LibraryPath)
	// A framework's binary is named after it; a bare library is the .a itself.
	const binaryOf = (root: string) =>
		root.endsWith(".framework") ? path.join(root, path.basename(root, ".framework")) : root
	const sourceBinary = binaryOf(source)
	const kind = (await runOrThrow("file", ["-b", sourceBinary])).stdout
	if (!/ar archive|current ar archive|random library/.test(kind)) {
		return false
	}
	const sliceDir = path.join(xcframework, SLICE_ID)
	fs.rmSync(sliceDir, { recursive: true, force: true })
	fs.mkdirSync(sliceDir, { recursive: true })
	const target = path.join(sliceDir, device.LibraryPath)
	fs.cpSync(source, target, { recursive: true })
	if (device.HeadersPath) {
		fs.cpSync(
			path.join(xcframework, device.LibraryIdentifier, device.HeadersPath),
			path.join(sliceDir, device.HeadersPath),
			{
				recursive: true,
			},
		)
	}
	const targetBinary = binaryOf(target)
	// The device slice may hold arm64 and arm64e; the host only builds arm64.
	if (device.SupportedArchitectures.length > 1) {
		await runOrThrow("lipo", [sourceBinary, "-thin", "arm64", "-output", targetBinary])
	}
	const data = fs.readFileSync(targetBinary)
	const skipped = retargetArchive(data)
	fs.writeFileSync(targetBinary, data)
	info.AvailableLibraries = [
		...libraries,
		{
			...device,
			LibraryIdentifier: SLICE_ID,
			SupportedArchitectures: ["arm64"],
			SupportedPlatformVariant: "maccatalyst",
		},
	]
	await writePlist(infoPath, info)
	log(
		`Added a Mac Catalyst slice to ${path.basename(xcframework)} from its iOS one` +
			(skipped > 0 ? ` (${skipped} objects without a build version left as they were)` : ""),
	)
	return true
}

// Every xcframework a linked package ships, outside its own node_modules. Returns how many it added a slice to.
export const addMissingCatalystSlices = async (packageDirs: string[], log: (line: string) => void) => {
	let added = 0
	for (const dir of packageDirs) {
		if (!dir || !fs.existsSync(dir)) {
			continue
		}
		const xcframeworks = fs
			.globSync("**/*.xcframework", { cwd: dir })
			.filter((match) => !match.includes("node_modules") && !match.includes(".xcframework/"))
		for (const match of xcframeworks) {
			if (await addCatalystSlice(path.join(dir, match), log)) {
				added += 1
			}
		}
	}
	return added
}
