// Replaces a package whose native code was left out of the host and that has no mock of its own. Capitalized
// exports are components that render their children, `use*` hooks return undefined, `…Async` functions resolve
// to undefined, and anything else is a function returning undefined.
const isPlainName = (name) => typeof name === "string" && name !== "then"

// One component for every capitalized export: it renders its children, which is all a left-out wrapper or
// provider needs to do for the tree under it to render.
const Excluded = ({ children }) => (typeof children === "function" ? null : (children ?? null))

const member = (name) => {
	if (/^[A-Z]/.test(name)) {
		return Excluded
	}
	if (name.endsWith("Async")) {
		return async () => undefined
	}
	return () => undefined
}

const exports_ = { __esModule: true, default: Excluded }

module.exports = new Proxy(exports_, {
	get: (target, name) => {
		if (name in target || !isPlainName(name)) {
			return target[name]
		}
		target[name] = member(name)
		return target[name]
	},
})
