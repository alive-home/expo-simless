# @expo-simless/macos

The iOS renderer for [expo-simless](../expo-simless). It draws with the iOS UIKit an Apple Silicon Mac runs through
Mac Catalyst, in a host built from the app's own native modules with CocoaPods, and renders SwiftUI views on their
own (`simless swiftui`).
- `ios/`: the host's native code (the capture, the React Native runner, the SwiftUI harness, the CocoaPods project
  template).
- `src/`: building and caching the host, its Info.plist, the device presets, and SwiftUI.

Install it next to `expo-simless`; the CLI finds it from the project.
