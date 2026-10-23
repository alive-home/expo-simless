# expo-simless

Render the screens and components of an Expo app to PNGs on a Mac, with no simulator.

| Package                                     | What it is                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`expo-simless`](packages/expo-simless)     | The CLI, the `render()` API for render scripts, bundling, and the renderer contract (`expo-simless/renderer`) |
| [`@expo-simless/macos`](packages/macos)     | The iOS renderer: a Mac Catalyst host built from the app's native modules, and SwiftUI rendering              |
| [`@expo-simless/android`](packages/android) | The Android renderer: a host built from the app's native modules, on an emulator booted from a snapshot       |

```bash
pnpm install
pnpm check     # typecheck every package
pnpm lint      # biome
```

The documentation is in [packages/expo-simless/README.md](packages/expo-simless/README.md).
