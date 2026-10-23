// Every expo-* package finds its native half through expo-modules-core's requireOptionalNativeModule. Imported before
// anything else, this decides what that answers:
// - a module named in the project's `nativeModules` config gets that file's export, whether or not it exists;
// - one the host has is returned as it is;
// - one a real build would have and the host lacks (its package was left out) gets a stub whose methods return
//   undefined (`…Async` ones resolve to it);
// - any other stays missing, as an Android-only module is on an iPhone.

// Modules packages test for to decide what environment they run in (Expo Go, an OTA update, a dev client). A stub
// would answer yes: expo-asset then resolves every image as Expo Go does, and expo-constants parses a dev launcher
// manifest that is not there. They stay missing.
const ABSENT = new Set([
	"ExpoGo",
	"ExponentKernel",
	"ExpoUpdates",
	"EXUpdates",
	"EXDevLauncher",
	"ExpoDevLauncher",
	"ExpoDevMenu",
	"ExpoDevMenuInternal",
	"EXDevMenu",
])

// A function, not an arrow: packages subclass native classes (`class File extends ExpoFileSystem.FileSystemFile`),
// and extending an arrow throws at import.
const method = (name) =>
	name.endsWith("Async")
		? async () => undefined
		: function stub() {
				return undefined
			}

// An instance of Expo's own NativeModule, so listeners and the event emitter API work as on a real one.
const stub = () =>
	new Proxy(new globalThis.expo.NativeModule(), {
		get: (target, key) => {
			if (key in target || typeof key !== "string" || key === "then") {
				return target[key]
			}
			target[key] = method(key)
			return target[key]
		},
	})

// Filled in by the generated native-modules.js: the project's `nativeModules` config, and the modules a real build
// would have that the host lacks.
const registered = globalThis.__simlessNativeModules ?? {}
const stubbed = new Set(globalThis.__simlessStubbedModules ?? [])
const resolved = {}

// `real` answers with the module the host has, or null.
const lookup = (name, real) => {
	if (typeof name !== "string") {
		return real()
	}
	if (name in resolved) {
		return resolved[name]
	}
	if (registered[name]) {
		const exports = registered[name]()
		resolved[name] = exports?.default ?? exports
		console.info(`simless: native module ${name} is the nativeModules stand-in`)
		return resolved[name]
	}
	const value = real()
	if (value != null) {
		return value
	}
	if (ABSENT.has(name) || !stubbed.has(name)) {
		return null
	}
	resolved[name] = stub()
	console.info(`simless: native module ${name} is not in the host, so it is a stub`)
	return resolved[name]
}

// Read by mocks/expo-modules-core-requireNativeModule.js, which stands in for the module every expo-* package
// finds its native half through. Expo installs globalThis.expo itself as a read-only host object that cannot be
// wrapped, so the lookup is intercepted there instead.
globalThis.__simlessNativeLookup = lookup
