import fs from "node:fs"
import path from "node:path"
import {
	buildAtomically,
	cacheRoot,
	hashOf,
	markUsed,
	pruneUnused,
	type RendererContext,
	runOrThrow,
	type SwiftUIRequest,
	type SwiftUIResult,
} from "@alivelabs/expo-simless/renderer"
import { type Job, runJobs } from "./plan.ts"
import {
	compileCapture,
	hostCatalystTarget,
	macSdkPath,
	NATIVE_ROOT,
	toolchainVersion,
	writeInfoPlist,
} from "./toolchain.ts"

const EXECUTABLE = "SimlessSwiftUI"

type SwiftUIView = {
	key: string
	// A Swift expression producing a View, e.g. `ContentView()` or `Card(title: "Hi")`.
	expression: string
}

const registrySource = (views: SwiftUIView[]) =>
	[
		"import SwiftUI",
		"",
		"@MainActor let rnhViews: [String: @MainActor () -> AnyView] = [",
		...views.map((view) => `\t${JSON.stringify(view.key)}: { AnyView(${view.expression}) },`),
		"]",
		"",
	].join("\n")

const ensureSwiftUIHost = async (
	sources: string[],
	views: SwiftUIView[],
	options: { verbose: boolean; log: (line: string) => void },
): Promise<string> => {
	const harness = [
		path.join(NATIVE_ROOT, "swiftui", "main.swift"),
		path.join(NATIVE_ROOT, "shared", "SMLCapture.h"),
		path.join(NATIVE_ROOT, "shared", "SMLCapture.m"),
		path.join(NATIVE_ROOT, "Info.plist"),
	]
	const registry = registrySource(views)
	const target = await hostCatalystTarget()
	const key = hashOf([
		target,
		await toolchainVersion(),
		registry,
		...harness.map((file) => fs.readFileSync(file)),
		...sources.flatMap((file) => [file, fs.readFileSync(file)]),
	])
	const appPath = path.join(cacheRoot(), "swiftui", `${EXECUTABLE}-${key}.app`)
	const executable = path.join(appPath, "Contents", "MacOS", EXECUTABLE)
	// One app per set of Swift sources and views, so each edit leaves one behind: the unused ones go.
	markUsed(appPath)
	pruneUnused(path.dirname(appPath), (name) => name.startsWith(`${EXECUTABLE}-`) && name.endsWith(".app"), [appPath])
	if (fs.existsSync(executable)) {
		return executable
	}

	options.log(`Compiling ${sources.length} Swift file${sources.length === 1 ? "" : "s"} for Mac Catalyst…`)
	const sdk = await macSdkPath()
	await buildAtomically(appPath, async (scratch) => {
		writeInfoPlist(scratch, EXECUTABLE, "com.alivelabs.simless.swiftui")
		const captureObject = path.join(scratch, "SMLCapture.o")
		await compileCapture(sdk, captureObject)
		const registryPath = path.join(scratch, "Registry.swift")
		fs.writeFileSync(registryPath, registry)
		await runOrThrow(
			"xcrun",
			[
				"swiftc",
				"-target",
				target,
				"-sdk",
				sdk,
				"-Fsystem",
				path.join(sdk, "System/iOSSupport/System/Library/Frameworks"),
				// Most SwiftUI code in the wild predates Swift 6's strict concurrency checking.
				"-swift-version",
				"5",
				"-Onone",
				"-import-objc-header",
				path.join(NATIVE_ROOT, "shared", "SMLCapture.h"),
				path.join(NATIVE_ROOT, "swiftui", "main.swift"),
				registryPath,
				...sources,
				captureObject,
				"-framework",
				"CoreText",
				"-o",
				path.join(scratch, "Contents", "MacOS", EXECUTABLE),
			],
			{ inherit: options.verbose },
		)
		fs.rmSync(captureObject)
		fs.rmSync(registryPath)
	})
	return executable
}

const safeName = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_")

export const renderSwiftUI = async (request: SwiftUIRequest, context: RendererContext): Promise<SwiftUIResult[]> => {
	const { expressions } = request
	const views = expressions.map((expression, index) => ({
		key: `v${index}`,
		expression,
		name: safeName(expression.replace(/\(.*$/s, "")) + (expressions.length > 1 ? `-${index + 1}` : ""),
	}))
	const jobs: Job[] = views
		.flatMap((view) =>
			request.variants.map(({ device, appearance }) => ({
				name: view.name,
				output: path.join(request.outDir, `${view.name}-${safeName(device.name)}-${appearance}.png`),
				component: view.key,
				device,
				appearance,
				...request.defaults,
			})),
		)
		.map((job, index) => ({ ...job, id: String(index) }))
	const executable = await ensureSwiftUIHost(request.sources, views, context)
	const workDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "simless-"))
	try {
		const results = await runJobs(
			{ executable, workDir, fonts: request.fonts, verbose: context.verbose, locale: request.locale },
			jobs,
		)
		const byId = new Map(jobs.map((job) => [job.id, job]))
		return results.map((result) => ({
			...result,
			device: byId.get(result.id)?.device.name ?? "",
			appearance: byId.get(result.id)?.appearance ?? "light",
		}))
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true })
	}
}
