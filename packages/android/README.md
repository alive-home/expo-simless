# @alivelabs/expo-simless-android

The Android renderer for [expo-simless](../expo-simless). It draws with Android's own views, on an emulator booted
from a snapshot, in a host app built from the project's own native modules.

```bash
pnpm add -D @alivelabs/expo-simless @alivelabs/expo-simless-android
simless run simless/screens/Home.render.tsx --platform android
simless show simless/screens/Home.render.tsx --only tapped-out --platform android
simless devices --platform android
```

## Requirements

- The Android SDK (Android Studio's, or `ANDROID_HOME`) with `platform-tools`, `emulator` and `cmdline-tools`.
- An emulator image whose adbd runs as root: `google_apis` or `default`, for this Mac's ABI
  (`sdkmanager "system-images;android-36;google_apis;arm64-v8a"`). The newest installed one is used.
- A JDK 17 or later (`JAVA_HOME`, or Android Studio's own).

## How it works

Paparazzi and Roborazzi render Android views on the JVM, which cannot load React Native's native libraries, so this
renderer runs the real thing on an emulator and keeps that fast:
1. **The host** is a Gradle project written into `node_modules/.cache/simless/android-host` from `host/`, modeled on
   Expo's SDK 58 template, with Expo's autolinking pointed at the project. It builds a debug APK for this Mac's ABI
   alone, kept under `~/Library/Caches/simless/android` by the project's native fingerprint (`@expo/fingerprint`
   for Android). The first build takes a few minutes; a module that does not compile is left out and the build run
   again, as the macOS host does.
2. **The bridge.** `SimlessActivity` is a `ReactActivity` behind Expo's delegate wrapper, as an Expo app's
   `MainActivity` is, so React Native sets the window up edge to edge and Expo modules' activity listeners run. It
   hands the ReactHost a `BindingsInstaller` (`host/bindings`, C++) that installs `globalThis.__simless` before the
   bundle runs: the same `mount`, `ready`, `fail`, `result`, `done` contract as the macOS host, so render scripts and
   the runtime are shared.
3. **The emulator** is simless's own AVD (`~/Library/Caches/simless/android/avd`, apart from Android Studio's),
   booted once, set up (gesture navigation, no lock screen, animations off, adbd as root, SELinux permissive) and
   saved as a snapshot; then booted once more to install the host APK and saved again. A run boots that snapshot
   read-only in under two seconds, with the host already installed. Each app keeps a host snapshot of its own (up
   to four, unused ones dropped after 14 days). Saving one boots the AVD writable, which the emulator allows only
   while no other instance has it open: it waits for other runs' emulators to close, and their new ones wait for it.
4. **A run.** The CLI starts `src/runner.ts` per plan in place of a host process. It takes an emulator from the run's
   pool (two by default, `SIMLESS_ANDROID_EMULATORS` to change), sets the device preset with `wm size` and
   `wm density`, the appearance with `cmd uimode`, the locale per app and the time zone, clears the host's data, pushes
   the bundle (once per emulator) and the plan, starts the activity, and pulls the result and PNGs back. Emulators
   stay up for the next render and stop when the CLI does. The CLI starts no more runners than there are emulators,
   and a render's time limit starts once its runner has an emulator set up and the bundle pushed, not while it
   waits for one, boots it or pushes to it.
5. **Capture.** `PixelCopy` of the activity's window, so the status and navigation bars are not in the PNG and the
   app's content under them is, as on iOS. A render is settled once nothing has drawn, and no image has been
   decoding (Glide's or Fresco's threads), for its settle time; a view that draws for good is captured two seconds
   past it.

`show` boots the same snapshot with its window and animations on, and streams the app's log until the window is
closed.

## Devices

One emulator plays every preset: a preset is the panel's pixels and density. `simless devices --platform android`
lists them; `WIDTHxHEIGHT@SCALE` in dp works too.

## Known gaps

- What config plugins write into an app's Android project (manifest entries, string resources, Gradle properties)
  is not in the host: modules that read their settings from there run on their defaults.
- The bundle is plain JavaScript, not Hermes bytecode, so a render's app start is about a second slower than a
  release build's.
