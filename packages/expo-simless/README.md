# expo-simless

Render the screens and components of an Expo app, or a SwiftUI view, to PNGs on a Mac, drawn by the real iOS
UIKit with the app's own native modules, with no simulator and no window on screen; or open one in a Mac window
to use it.

```tsx
// simless/cards.render.tsx
import { render } from "@alivelabs/expo-simless"

export default async () => {
	await render(<Card title="Hello" />, { name: "card", fit: true })
	await render(<Card title="A much longer title that wraps" />, { name: "card-long", fit: true })
}
```

```bash
simless run simless/cards.render.tsx --appearance both
simless swiftui Sources/ProfileCard.swift --view 'ProfileCard(name: "Ada")'
```

Once the host is built a run takes a few seconds, mostly Metro bundling, and each render in it 0.2 to 0.8 s.
Building the host, which compiles the app's native modules for Mac Catalyst, takes a few minutes (about five for
an app with 46 native packages) and happens again only when its native fingerprint changes (see [Caches](#caches)).

## How it works

Apple Silicon Macs run iOS UIKit natively through Mac Catalyst. That is the same UIKit an iPhone runs, not an
emulation of it. The CLI builds a small Catalyst app, the host, which:
1. starts React Native (Hermes and Fabric) and Expo with the app's own native modules, linked by CocoaPods through
   the app's own autolinking and compiled for Catalyst (see [Native modules](#native-modules)), under the
   Info.plist the app's config plugins give it;
2. loads a bundle Metro made from your project and your render script, with your Metro config, aliases and Babel
   setup, and runs the script;
3. for each `render(element)` the script awaits, mounts the element in an offscreen `UIWindow` sized and scaled
   like the device you picked, with its safe area, size classes, idiom and color scheme;
4. waits until the view tree stops changing, then draws it with `drawViewHierarchy`, writes the PNG, and resolves
   the script's `render()` call.

For SwiftUI the CLI compiles your Swift files, a generated list of the views to render, and the same capture
code into a Catalyst app, cached by the hash of its sources.

The host never shows a window or a Dock icon and never takes focus. Its window is ordered in, because the window
server renders liquid glass, blurs and other backdrop effects only for a window it knows, but it is made fully
transparent and click-through before it is, and `LSBackgroundOnly` keeps the process from activating.

Things the host fakes so the pixels match a phone rather than a Mac:
- `UIScreen` reports the device's size and scale, so `PixelRatio`, `Dimensions` and every layer's
  `contentsScale` match it. Without this text is drawn at the Mac's 2x and upscaled.
- The window counts as key and the app as active, so controls are not drawn in Catalyst's inactive style.
- A `UISwitch` with no tint is green as on iOS, not Catalyst's gray. A tint the app sets still wins.

## Install

expo-simless is the CLI and the `render()` API; a renderer package draws. For iOS that is `@alivelabs/expo-simless-macos`,
for Android `@alivelabs/expo-simless-android` (an emulator booted from a snapshot; see its README):

```bash
pnpm add -D @alivelabs/expo-simless @alivelabs/expo-simless-macos @alivelabs/expo-simless-android
```

`--platform` picks the renderer: `ios`, the default, or `android`. A renderer implements the contract in `@alivelabs/expo-simless/renderer`: it builds a native host from the
app's native modules and says how to start it on a plan; the CLI bundles the JavaScript, writes the plans and reads
the results.

## Requirements

- An Apple Silicon Mac with Xcode (the command line tools alone lack the iOS support SDK).
- Node 23.6 or later.
- An Expo app on SDK 58 or later (React Native 0.88 or later). Apps without Expo are not supported.
- CocoaPods, which links the host as it links an Expo iOS build.

## Expo apps

```bash
simless run <script> [options]               # a render script
simless render <file>[#Export]... [options]  # components that take no props
```

### Render scripts

A render script is a module, anywhere in the project, whose default export is an async function. It is bundled
with the app and runs in the app's own JS runtime inside the host, so it can import anything the app can, set up
what the app sets up at launch, and pass any props: images, callbacks, Reanimated shared values. Each `render()`
it awaits becomes one PNG per device and appearance.

```tsx
import { render, waitFor } from "@alivelabs/expo-simless"

export default async () => {
	await signInAsTestUser() // whatever the app does before its first screen
	await render(
		<Providers>
			<SettingsScreen />
		</Providers>,
		{ name: "settings" },
	)
	for (const count of [0, 1, 12]) {
		await render(<Badge count={count} />, { name: `badge-${count}`, fit: true, padding: 16 })
	}
}
```

`render(element, options)` resolves with `{ name, ok, output, error, settled }` once the PNG is written; a render
that fails resolves too, so the script goes on to the next. Its options are `name` (the PNG is
`<out>/<name>-<device>-<appearance>.png`; default the component's name, with `-2`, `-3` for repeats), `fit`,
`padding`, `background`, `settleMs` and `timeoutMs`, which override the CLI's defaults. `waitFor(promise)`, called
while a render is mounted, holds its capture until the promise settles, for setup a component starts itself.

What an app puts at its root (a store, a query client, a navigator) is ordinary code in the script or in components
the project writes for it. A screen that is a route of the app's navigator renders best through that navigator, so
it gets its header, its presentation (a formSheet with its detents) and its params. With React Navigation's static
API, a component like this opens any route over the screen it sits on, with params typed against the navigator:

```tsx
import { createStaticNavigation, type StaticParamList } from "@react-navigation/native"
import RootStack from "../src/navigation/RootStack"

type Params = StaticParamList<typeof RootStack>
type AppRouteProps<Name extends keyof Params> = undefined extends Params[Name]
	? { name: Name; params?: Params[Name] }
	: { name: Name; params: Params[Name] }

const Navigation = createStaticNavigation(RootStack)

export const AppRoute = <Name extends keyof Params>({ name, params }: AppRouteProps<Name>) => (
	<Navigation initialState={{ routes: [{ name: "Home" }, { name, params }] }} />
)
```

By default every render runs in a host process of its own, in parallel: the first process performs the first render
and reports the names of all of them, and the rest are spread over further processes, each running the script up
to its render and skipping the others (a skipped `render()` resolves at once with `{ name, skipped: true }`). One
render can leave state behind in UIKit that changes the next (a pushed screen left iOS 26's scroll edge effect
over a sheet rendered after it), which this rules out. `--shared` performs all renders of a device and appearance
in one process instead, which is faster when that does not matter.

`simless render <file>[#Export]...` is the same for components that need nothing: it renders each file's default
export, or the one `#Export` names, with no props.

| Option                 |                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `--device <name,...>`  | A preset (`simless devices`) or `WIDTHxHEIGHT@SCALE`. Default `iphone-17-pro`                        |
| `--appearance <mode>`  | `light`, `dark` or `both`                                                                            |
| `--out <dir>`          | Where the PNGs go. Default `./simless-output`                                                        |
| `--only <name,...>`    | Only the renders with these names; `*` matches anything, e.g. `--only 'onboarding-*'`                |
| `--list`               | Print the names of the script's renders without rendering                                            |
| `--shared`             | All renders of a device and appearance in one process                                                |
| `--locale <tag>`       | Render in this locale, e.g. `nl-NL`                                                                  |
| `--fit`                | Default for every render: crop to the content, with no safe area. For components, not screens        |
| `--padding <pt>`       | Default for every render: space around the content                                                   |
| `--background <color>` | Default for every render: `#RRGGBB`, `#RRGGBBAA` or `transparent`. Default: the system background    |
| `--settle <ms>`        | Default for every render: how long the view tree must stay unchanged before the capture. Default 150 |
| `--timeout <ms>`       | Default for every render. Default 15000                                                              |
| `--json`               | Print the results as JSON                                                                            |
| `--dev`                | Bundle with `__DEV__` on                                                                             |
| `--keep`               | Keep the generated entry, bundle and plans in `node_modules/.cache/simless`                          |
| `--verbose`            | Stream the bundler's and the host's logs                                                             |

### Output

Each render is one line on stdout, the PNG's path when it worked,
so the path can be opened as it is; a failed one gets the JS error with its stack mapped back to your sources, a
hint when the error looks like a missing native library or missing route params, and the last log lines. A summary
goes to stderr.

```
✓ simless-output/card-iphone-17-pro-light.png  412ms
✗ card-long  iphone-17-pro light
  TypeError: Cannot read property 'length' of undefined
      at Card (src/components/Card.tsx:18:27)
3 of 4 rendered in 6.1s
```

`--json` prints `{ ok, renders: [{ name, device, appearance, output, ok, settled, durationMs, error, logs }],
errors }` instead, with `logs` only on failed renders and `errors` for a script that threw. The exit code is 0 when
every render worked, 1 when one failed, and 2 when nothing could be rendered: bad arguments, a failed build or
bundle, or a script that threw before its first render. `settled: false` means the view tree was still changing at
the timeout and the PNG shows it as it was then.

### Reports

```bash
simless report                                   # every simless/**/*.render.tsx
simless report simless/screens --appearance both # a folder, or named scripts
```

`report` runs every render script into one folder (`./simless-report`, emptied first):
- `index.html`: every image, grouped by script, filterable by name and device, with a full-size viewer (arrow keys
  step through). It needs no server; open the file.
- `report.md`: one table per script, a row per render and a column per device, linking each PNG, with failures
  first. Written for an LLM: read it, then open only the images that matter.
- `report.json`: the same, for tools: git branch and commit, devices, and per image its path, duration, whether it
  settled, and the error of one that failed.

A script's renders are named after its path from the folder the scripts share: `screens/Home.render.tsx` renders
`screens/Home/tapped-out`, written to `screens/Home/tapped-out-<device>-<appearance>.png`. All scripts go into one
bundle, and each render's process replays only its own script, so one script's setup never reaches another's
renders and a script that throws stops itself only. `--only 'screens/Home/*'` narrows a report as it narrows a run.

The devices come from `report` in the config, so a report can cover more devices than a quick `run`:

```ts
report: {
	renders: ["simless/**/*.render.tsx"], // the default
	devices: ["iphone-se", "iphone-17-pro", "iphone-17-pro-max", "ipad-mini", "ipad-pro-13"],
	appearance: "both",
},
```

### Config

`simless.config.ts` in the project root (or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json`), for what belongs to
the project rather than to a script. `SimlessConfig` types it; Node loads a `.ts` config with its own type
stripping, so it can use types but not enums or other syntax that needs compiling.

```ts
import type { SimlessConfig } from "@alivelabs/expo-simless"

export default {
	// A JS module name, or a project file's path, to a replacement: a path relative to the project root, or a package
	// specifier. A file is replaced however an import names it (an alias, a relative path).
	mocks: {
		"some-library": "./simless/mocks/some-library.ts",
		"./src/hooks/useAnimationClock.ts": "./simless/mocks/useAnimationClock.ts",
	},
	// Native module name (what JS passes to requireNativeModule) to a stand-in, for a module the host lacks whose
	// answers a component depends on. The package's own JS still runs on top of it.
	nativeModules: {
		SomeNativeState: "./simless/native/SomeNativeState.ts",
	},
	// Packages to leave out of the host (see below).
	native: { exclude: ["some-module-that-needs-hardware"] },
	// Defaults for the CLI options.
	device: "iphone-17-pro",
	appearance: "light",
	locale: "en-US",
	// The same date and time in every render (see below).
	clock: "2026-10-21T14:30:00",
	timeZone: "Europe/Amsterdam",
} satisfies SimlessConfig
```

**A fixed clock.** With `clock` set, `Date` reads that moment while a script sets up, starts from it again when a
render mounts and runs while the render comes up, and stops once the render is ready to be captured. A state set up
as "25 minutes ago" is then exact, and dates, times, greetings and timers read the same on every run. In `show` the
clock runs on. Without an offset, `clock` is a wall-clock time in `timeZone` (an IANA name; the host runs in it), or
in the Mac's zone. Native code that reads the system clock itself still sees the real time, and an animation driven by
frame time (Reanimated's `useFrameCallback`) still moves: replace the hook that drives it with a mock that holds
still.

Most of what a host needs comes from the app itself, read with `expo config --type introspect`, so the config above
is mostly empty:
- **Fonts**: the files the `expo-font` config plugin embeds are registered in the host. `fonts: [...]` in the config
  (globs allowed) or `--font` adds others.
- **Info.plist**: the one the app's config plugins produce (URL schemes, API keys, usage descriptions, its version)
  is the host's, apart from the host's own identity and launch keys. It is written into the built host on every
  run, so changing the app config never rebuilds it.
- **Appearance**: an app that locks `userInterfaceStyle` renders in it, as a phone draws it.

When the host has them, every render is also wrapped in `SafeAreaProvider` (with the device's insets as its
initial metrics) and `GestureHandlerRootView`, which an app normally has at its root.

### Native modules

The host is built with the app's own native modules. The CLI generates a Mac Catalyst app project in
`node_modules/.cache/simless/native-host` whose Podfile runs Expo's autolinking, so it links the same packages
`expo prebuild` and `pod install` would; codegen registers third-party Fabric components as in the app; and
`xcodebuild` compiles it all for Catalyst. Expo and `expo-*` packages, `react-native-svg`, Skia, Reanimated,
Gesture Handler, Screens and the rest then run their real native code.

The first build compiles every module, a few minutes for a large app. Two runs in one project wait for each other
rather than build at once.

Making the project's modules build for Catalyst, without changing them:
- A prebuilt static library with iOS slices and no Catalyst one (Skia) gets one: the iOS arm64 objects, with the
  platform in their build version set to Mac Catalyst. It is added to the package's xcframework in `node_modules`,
  where an iOS build never looks, and written beside rather than over pnpm's hard links into its store.
- `__has_include(<AppKit/AppKit.h>)` guards written for react-native-macos are true under Catalyst and import
  AppKit into UIKit code (Reanimated); for the pods, that header resolves to an empty file instead.
- Expo's build scripts are told where the app is (`PROJECT_ROOT`), which they would otherwise look for two levels
  above `Pods/`.

A module that still does not compile for Catalyst, because the API it uses does not exist there (FamilyControls,
`QLPreviewController.canPreview`), is left out on the next attempt, along with any pod that depends on it. The CLI
says which and remembers it at that version, so an upgrade is tried again. Only compile errors do this; a failed script or link step stops the build with its
error. Some modules are left out by default because they only make sense in a running app: the Expo dev client,
`expo-updates` (which also takes over where the bundle is loaded from) and `expo-splash-screen` (which covers the
root view until the app hides it).

What a left-out module turns into:
- An Expo module keeps its JS. `requireNativeModule` answers for it with a stub whose methods return `undefined`
  (`…Async` ones resolve to it), or with the `nativeModules` stand-in when the config names one. Only modules a
  real build would have are stubbed: one that only exists on Android stays missing, so code takes its iOS path.
- Any other package is replaced in the bundle by a generic stand-in whose components render their children and
  whose functions return `undefined`, or by the project's own `mocks` entry. Imports are matched by where they
  resolve, so a tsconfig path alias or a deep import into the package is caught too.
- `expo-updates`, which is never in the host, gets a mock describing an embedded build with no update.

There are no other library mocks: anything that draws (Reanimated, gesture handler, safe area, expo-image, blur,
gradients) is compiled into the native host, so a render shows what the app shows.

Each host process starts with an empty home directory, so AsyncStorage, user defaults and files begin as on a fresh
install, and nothing a render saves is read by a later render or one running beside it.

### Sheets

Sheets are presented by UIKit as on an iPhone: the floating card at its detent, the grabber, the slide-up finished
before the capture. SwiftUI's `.sheet` and `presentationDetents`, UIKit's `sheetPresentationController`, and
react-native-screens' `formSheet` all work, in light and dark. (Catalyst would otherwise put a sheet in a separate
Mac window, which an offscreen host never shows; the host keeps it in the app's window.)

The tool does not present sheets itself: the app's navigator does. Render the screen through it, opened as the
initial route over the screen it sits on, and the render has the app's detents, header and the screen underneath.

### Using a render in a window

```bash
simless show simless/home.render.tsx --only Home-in
simless show src/components/Card.tsx
```

`show` opens one render in a Mac window at the device's size and keeps it running, with animations: click to tap,
scroll with the trackpad, drag to swipe or pull a sheet down, type with the Mac keyboard. The script sets the
state up as for a PNG, then the app is yours to navigate. It runs the bundle it started with: to see a change,
close the window and show it again. Closing the window, or Ctrl-C, ends it. Warnings and errors from the app print
in the terminal, mapped back to the source.

It takes the render named by `--only` (the script's first without it), and the first `--device` and appearance.
The window shows the app at its own size: Catalyst would draw an iPad-idiom app at 77%. Mocks and `nativeModules`
stand-ins answer as they do for a PNG, so native features the Mac lacks (Screen Time, NFC, the camera) do what the
stand-in says.

## SwiftUI

```bash
simless swiftui <file.swift>... [--view <expression>]... [options]
```

The files are compiled together, so pass every file the view needs. `--view` is any Swift expression producing
a view, and can be repeated; without it the first file's name followed by `()` is rendered. A file containing
an `@main` app cannot be one of them, since the host has its own entry point. The device, appearance, fit,
padding, background, locale and output options are the same as for React Native.

## Fidelity

- Layout, text, images and UIKit-backed controls come from the iOS frameworks that ship with the Mac's macOS,
  so they match an iPhone on the matching iOS release. The status bar and home indicator are not drawn; the
  safe area they take up is kept.
- `UIDevice.current.userInterfaceIdiom` (and with it `Platform.isPad`) reports the device preset's idiom, as the
  window's traits do; Catalyst would say `.pad` on every device.
- The display's corner radius is the device's (62pt on an iPhone 17 Pro, `simless devices` lists them), so sheets
  and other containers get the concentric corners iOS 26 gives them; a Mac reports none, which made sheet corners
  20pt instead of 56pt. The rim image Catalyst draws around a sheet, a Mac's, is kept hidden: an iPhone's sheet has
  none, and its tighter corners stood out beyond the sheet's.
- In `show`, a sheet appears without sliding up: Catalyst's UIKit runs the presentation for its duration but
  attaches no animation to it, in any Catalyst app. Other UIKit and Reanimated animations run.
- Animations are not captured mid-flight. UIKit's view animations are off, so a change UIKit would animate (a sheet
  sliding up, a header's edge effect fading) lands at its final value at once; the capture then waits for the tree
  and for Core Animation to settle, and a looping animation (an activity indicator) is drawn in whatever frame it
  is in. A Metal canvas (Skia) must also stop changing, for up to two seconds into the render, so one that
  animates for good (an animated sky) is captured as it is then.
- The safe area is the device's: a Catalyst window has an inset of its own for the Mac title bar, which the host
  takes off before adding the device's.
- A focused text field's caret is drawn steady, not blinking, and does not keep the render from settling.
- An animator scrubbed to a fraction and left paused keeps that partial effect, although UIKit's animations are off:
  `expo-blur` sets its intensity that way.
- An `InputAccessoryView` is hidden: it belongs above the keyboard, which a render never has up, and React Native
  would otherwise leave it drawn in place over the screen.
- The first Skia canvas in a host process never draws a frame; a later one draws at once. So the first job with a
  Metal layer is mounted twice, which costs one render per process.
- Liquid glass renders, from SwiftUI (`.glassEffect`, `.buttonStyle(.glass)`), UIKit (`UIGlassEffect`) and React
  Native libraries built on them (`@callstack/liquid-glass`), with the backdrop it refracts. The window server draws
  it, which is why the host's window has to be ordered in at all. Swift handed to the SwiftUI host is compiled for
  the iOS version the Mac's Catalyst runs (iOS 26 on macOS 26), so its newest APIs are available.
- An Expo app that locks `userInterfaceStyle` renders in that appearance whatever `--appearance` says, since a
  phone never draws it in the other; the CLI says so when it overrides one.
- The locale defaults to the Mac's, because real `expo-localization` reads it; `--locale`
  sets it for Foundation, Hermes' `Intl` and Expo alike.
- Rendering without a logged-in GUI session (over SSH, as a launch daemon) has not been tested yet. It needs a
  window server, so a Mac with nobody logged in is unlikely to work.

## Debugging

`--keep` leaves the generated entry, Metro config and bundle in place. `SIMLESS_DUMP_TREE=1` with `--verbose` prints,
at capture, the safe area of the window and of each screen and navigation bar, then every window of the host's scene
and its view tree, which is how to find out where UIKit put a view that did not show up; every view that rounds or
clips its corners, the layers of a presented sheet, and the glass layers with the layer each copies its shape from;
and, for a render that did not settle, the layers still animating and those that moved in its last check (a layout
that flips between two sizes shows here). `SIMLESS_HIDE_LAYERS=CASDFLayer,UIDropShadowRimPartView` hides every layer
of those classes, or of views of those classes, before the capture: how to find which layer draws something.

## Caches

Nothing is invalidated: everything cached is stored under a hash of what it was made from, so a change makes a new
entry and an unchanged project finds the old one.
- **The native host** is keyed by the app's native fingerprint, from `@expo/fingerprint` (the hash `expo run` and
  EAS decide rebuilds by): native package versions, pnpm and patch-package patches, the app's local modules,
  autolinking. The app config is left out of it, since what it changes for the host is the Info.plist, which is
  written on every run. The Xcode version, the packages left out, and simless's own native sources are part of the
  key too.
- **The SwiftUI host** is keyed by your Swift files, the `--view` expressions and the Xcode version.
- **JS** is bundled on every run; Metro's own cache keeps that to a few seconds.

Built hosts live in `~/Library/Caches/simless` (`SIMLESS_CACHE` overrides it); deleting it is always safe. The
modules learned not to build for Catalyst are in `node_modules/.cache/simless/native-host/learned-exclude.json`.
