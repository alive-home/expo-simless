#!/usr/bin/env node
import { main } from "./cli.ts"

main().then(
	(code) => {
		process.exitCode = code
	},
	(error) => {
		process.stderr.write(`simless: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 2
	},
)
