// Stands in for expo-modules-core/build/requireNativeModule.js, which the generated Metro config swaps for this file;
// ORIGINAL is replaced with the real module's path when the work directory is written. Asks shims/expo.js first.
const original = require("ORIGINAL")

export const requireOptionalNativeModule = (moduleName) =>
	globalThis.__simlessNativeLookup(moduleName, () => original.requireOptionalNativeModule(moduleName))

export const requireNativeModule = (moduleName) => {
	const nativeModule = requireOptionalNativeModule(moduleName)
	if (!nativeModule) {
		throw new Error(`Cannot find native module '${moduleName}'`)
	}
	return nativeModule
}
