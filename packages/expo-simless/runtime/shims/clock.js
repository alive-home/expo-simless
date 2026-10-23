// With a clock set (`clock` in simless.config.ts), `Date` reads that moment while a script sets up, starts from it
// again when a render mounts and runs while the render comes up, and stops once the render is ready to capture (see
// index.js). So a state set up as "25 minutes ago" is exact, and a timer on screen reads the same on every run. A
// window from `simless show` keeps it running. Imported before any app module.
const fixed = globalThis.__simlessClock

if (typeof fixed === "number") {
	const RealDate = Date
	let base = fixed
	let runningSince = null
	const now = () => (runningSince === null ? base : base + (RealDate.now() - runningSince))
	globalThis.__simlessClockControl = {
		start: () => {
			base = fixed
			runningSince = RealDate.now()
		},
		hold: () => {
			base = now()
			runningSince = null
		},
	}
	// A function, not a subclass: `Date()` without `new` still returns a string, and instances are real Dates.
	function SimlessDate(...args) {
		if (!new.target) {
			return new RealDate(now()).toString()
		}
		return args.length === 0 ? new RealDate(now()) : new RealDate(...args)
	}
	SimlessDate.prototype = RealDate.prototype
	SimlessDate.now = now
	SimlessDate.parse = RealDate.parse
	SimlessDate.UTC = RealDate.UTC
	globalThis.Date = SimlessDate
}
