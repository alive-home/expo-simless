import type { Device } from "expo-simless/renderer"

// A preset is the panel itself: what `wm size` and `wm density` set on the emulator, so one emulator plays every
// device. Widths and heights in dp follow from it, as on a phone.
const device = (name: string, widthPx: number, heightPx: number, dpi: number): Device => {
	const scale = dpi / 160
	return {
		name,
		// To a tenth of a dp, which still rounds back to the panel's own pixels.
		width: Math.round((widthPx / scale) * 10) / 10,
		height: Math.round((heightPx / scale) * 10) / 10,
		scale,
		// A first guess for the safe area provider; react-native-safe-area-context reads the real insets once the
		// window is laid out.
		safeArea: { top: 48, right: 0, bottom: 24, left: 0 },
		cornerRadius: 0,
	}
}

export const DEVICES: Record<string, Device> = Object.fromEntries(
	[
		device("pixel-9", 1080, 2424, 420),
		device("pixel-9-pro-xl", 1344, 2992, 480),
		device("pixel-4a", 1080, 2340, 440),
		device("small-phone", 720, 1520, 320),
		device("pixel-tablet", 1600, 2560, 320),
	].map((preset) => [preset.name, preset]),
)

export const DEFAULT_DEVICE = "pixel-9"

// The panel for any device, a preset or a custom WIDTHxHEIGHT@SCALE in dp.
export const panelOf = (target: Device) => ({
	widthPx: Math.round(target.width * target.scale),
	heightPx: Math.round(target.height * target.scale),
	dpi: Math.round(target.scale * 160),
})
