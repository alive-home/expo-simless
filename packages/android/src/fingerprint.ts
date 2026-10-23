import { expoRequire, hashOf } from "@alivelabs/expo-simless/renderer"

type FingerprintSource = {
	type: string
	filePath?: string
	id?: string
	hash: string | null
	reasons: string[]
}

type FingerprintModule = {
	createFingerprintAsync: (root: string, options: { platforms: string[] }) => Promise<{ sources: FingerprintSource[] }>
}

// What the project's native code is, as @expo/fingerprint (the hash `expo run` and EAS decide rebuilds by) sees
// it: package versions, patches, local modules, autolinking. The app config is left out: the host is a project of
// its own, and nothing in the app's config is built into it.
export const nativeFingerprint = async (root: string): Promise<string> => {
	const { createFingerprintAsync } = expoRequire(root)("@expo/fingerprint") as FingerprintModule
	const { sources } = await createFingerprintAsync(root, { platforms: ["android"] })
	return hashOf(
		sources
			.filter(
				(source) =>
					!source.reasons.some((reason) => reason.startsWith("expoConfig") || reason.startsWith("packageJson")),
			)
			.map((source) => `${source.type}:${source.filePath ?? source.id}:${source.hash}`)
			.sort(),
	)
}
