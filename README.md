# expo-simless

Render the screens and components of an Expo app to PNGs on a Mac, with no simulator.

| Package                                               | What it is                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`@alivelabs/expo-simless`](packages/expo-simless)    | The CLI, the `render()` API for render scripts, bundling, and the renderer contract (`@alivelabs/expo-simless/renderer`) |
| [`@alivelabs/expo-simless-macos`](packages/macos)     | The iOS renderer: a Mac Catalyst host built from the app's native modules, and SwiftUI rendering                         |
| [`@alivelabs/expo-simless-android`](packages/android) | The Android renderer: a host built from the app's native modules, on an emulator booted from a snapshot                  |

```bash
pnpm install
pnpm check     # typecheck every package
pnpm lint      # biome
```

In a checkout, and in an app that links one (`link:../expo-simless/packages/expo-simless`), Node runs the TypeScript
sources as they are. The published packages carry JavaScript compiled into `dist/` instead, since Node does not strip
types from files under `node_modules`; `publishConfig` points their `bin` and `exports` there. To release:

```bash
pnpm run ci
pnpm -r publish --tag alpha   # builds each package first (prepack)
```

The documentation is in [packages/expo-simless/README.md](packages/expo-simless/README.md).
