export type Insets = {
	top: number
	right: number
	bottom: number
	left: number
}

export type Device = {
	name: string
	width: number
	height: number
	scale: number
	// Portrait safe area, status bar and home indicator included; the host does not draw either.
	safeArea: Insets
	// The display's corner radius, which iOS 26 makes sheets and other containers concentric with.
	cornerRadius: number
}

// A preset of the renderer's, or a custom `402x874@3` with no safe area.
export const resolveDevice = (spec: string, presets: Record<string, Device>): Device => {
	const preset = presets[spec]
	if (preset) {
		return preset
	}
	const custom = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(spec)
	if (custom) {
		return {
			name: spec.replace("@", "at"),
			width: Number(custom[1]),
			height: Number(custom[2]),
			scale: custom[3] ? Number(custom[3]) : 3,
			safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
			cornerRadius: 0,
		}
	}
	throw new Error(`Unknown device "${spec}". Use one of ${Object.keys(presets).join(", ")}, or WIDTHxHEIGHT@SCALE.`)
}
