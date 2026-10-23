import type { Device } from "expo-simless/renderer"

const phone = (
	name: string,
	width: number,
	height: number,
	top: number,
	cornerRadius: number,
	bottom = 34,
	scale = 3,
): Device => ({
	name,
	width,
	height,
	scale,
	safeArea: { top, right: 0, bottom, left: 0 },
	cornerRadius,
})

const tablet = (name: string, width: number, height: number, cornerRadius: number): Device => ({
	name,
	width,
	height,
	scale: 2,
	safeArea: { top: 32, right: 0, bottom: 25, left: 0 },
	cornerRadius,
})

export const DEVICES: Record<string, Device> = Object.fromEntries(
	[
		// Insets and corner radii as the iOS 26.5 simulator reports them.
		phone("iphone-17-pro", 402, 874, 62, 62),
		phone("iphone-17-pro-max", 440, 956, 62, 62),
		phone("iphone-17", 402, 874, 62, 62),
		phone("iphone-16e", 390, 844, 47, 47.33),
		phone("iphone-se", 375, 667, 20, 0, 0, 2),
		tablet("ipad-pro-11", 834, 1210, 30),
		tablet("ipad-pro-13", 1032, 1376, 30),
		tablet("ipad-mini", 744, 1133, 21.5),
	].map((device) => [device.name, device]),
)

export const DEFAULT_DEVICE = "iphone-17-pro"
