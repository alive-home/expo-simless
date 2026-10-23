import zlib from "node:zlib"

type Pixels = {
	width: number
	height: number
	// RGBA, 8 bits a channel.
	data: Buffer
}

// The 8-bit RGB or RGBA, non-interlaced PNGs the hosts write; anything else is reported as unreadable.
const decodePng = (buffer: Buffer): Pixels | null => {
	let offset = 8
	let width = 0
	let height = 0
	let bitDepth = 0
	let colorType = 0
	let interlace = 0
	const chunks: Buffer[] = []
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset)
		const type = buffer.toString("ascii", offset + 4, offset + 8)
		const data = buffer.subarray(offset + 8, offset + 8 + length)
		if (type === "IHDR") {
			width = data.readUInt32BE(0)
			height = data.readUInt32BE(4)
			bitDepth = data[8] ?? 0
			colorType = data[9] ?? 0
			interlace = data[12] ?? 0
		} else if (type === "IDAT") {
			chunks.push(data)
		} else if (type === "IEND") {
			break
		}
		offset += 12 + length
	}
	if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
		return null
	}
	const channels = colorType === 6 ? 4 : 3
	const raw = zlib.inflateSync(Buffer.concat(chunks))
	const stride = width * channels
	const out = Buffer.alloc(width * height * 4)
	let previous = Buffer.alloc(stride)
	for (let y = 0; y < height; y += 1) {
		const start = y * (stride + 1)
		const filter = raw[start]
		const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride))
		for (let x = 0; x < stride; x += 1) {
			const left = x >= channels ? (line[x - channels] ?? 0) : 0
			const up = previous[x] ?? 0
			const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0
			let value = line[x] ?? 0
			if (filter === 1) {
				value += left
			} else if (filter === 2) {
				value += up
			} else if (filter === 3) {
				value += (left + up) >> 1
			} else if (filter === 4) {
				const estimate = left + up - upLeft
				const toLeft = Math.abs(estimate - left)
				const toUp = Math.abs(estimate - up)
				const toUpLeft = Math.abs(estimate - upLeft)
				value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
			}
			line[x] = value & 255
		}
		for (let x = 0; x < width; x += 1) {
			const target = (y * width + x) * 4
			out[target] = line[x * channels] ?? 0
			out[target + 1] = line[x * channels + 1] ?? 0
			out[target + 2] = line[x * channels + 2] ?? 0
			out[target + 3] = channels === 4 ? (line[x * channels + 3] ?? 0) : 255
		}
		previous = line
	}
	return { width, height, data: out }
}

// A channel moving by less than this is antialiasing, not a change anyone would see.
const CHANNEL_TOLERANCE = 8

// The share of pixels that differ between two PNGs: 0 for the same image, 1 for a different size or a file that
// cannot be read.
export const pixelChange = (before: Buffer, after: Buffer): number => {
	if (before.equals(after)) {
		return 0
	}
	const a = decodePng(before)
	const b = decodePng(after)
	if (!a || !b || a.width !== b.width || a.height !== b.height) {
		return 1
	}
	let differing = 0
	for (let index = 0; index < a.data.length; index += 4) {
		for (let channel = 0; channel < 4; channel += 1) {
			if (Math.abs((a.data[index + channel] ?? 0) - (b.data[index + channel] ?? 0)) > CHANNEL_TOLERANCE) {
				differing += 1
				break
			}
		}
	}
	return differing / (a.width * a.height)
}
