// Found first on the pods' header search path. Under Mac Catalyst the macOS SDK makes <AppKit/AppKit.h> resolve,
// so `__has_include(<AppKit/AppKit.h>)` guards written for react-native-macos import AppKit into UIKit code, and its
// QuickDraw `Rect` and `Point` clash with C++ types of those names (Reanimated). Catalyst code cannot use AppKit,
// so here it resolves to nothing.
#pragma once
