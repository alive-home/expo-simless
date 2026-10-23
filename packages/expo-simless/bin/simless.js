#!/usr/bin/env node
// The bin in a checkout (a workspace or `link:` dependency), where Node strips the types from the sources. The
// published package runs dist/bin.js instead, compiled from the same file.
import "../src/bin.ts"
