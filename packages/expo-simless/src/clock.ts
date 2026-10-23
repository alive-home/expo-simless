// How far `timeZone`'s wall clock is ahead of UTC at `epoch`, in milliseconds.
const zoneOffset = (epoch: number, timeZone: string) => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(epoch))
	const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((each) => each.type === type)?.value ?? 0)
	const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"))
	return wall - Math.floor(epoch / 1000) * 1000
}

export const checkTimeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone })
	} catch {
		throw new Error(`Unknown time zone "${timeZone}": use an IANA name such as Europe/Amsterdam`)
	}
}

// The moment a clock setting names, in milliseconds since the epoch. One with an offset or Z is that instant; one
// without is a wall-clock time in `timeZone`, or the Mac's.
export const clockEpoch = (clock: string, timeZone?: string): number => {
	const hasOffset = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(clock)
	const instant = Date.parse(hasOffset || !timeZone ? clock : `${clock}Z`)
	if (Number.isNaN(instant)) {
		throw new Error(`clock must be an ISO date and time such as 2026-10-21T14:30:00, got ${clock}`)
	}
	if (hasOffset || !timeZone) {
		return instant
	}
	// The zone's offset at that moment, then once more at the corrected one, which settles across a DST change.
	const first = instant - zoneOffset(instant, timeZone)
	return instant - zoneOffset(first, timeZone)
}
