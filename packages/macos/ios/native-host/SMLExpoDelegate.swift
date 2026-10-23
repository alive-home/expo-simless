// `internal`, as in the ExpoModulesProvider.swift Expo generates into the same target: Swift rejects one module
// imported at two access levels.
internal import Expo
import React

// Expo's factory insists on an ExpoReactNativeFactoryDelegate, and a Swift class cannot be subclassed from
// Objective-C, so this is the delegate SMLReactHost.mm creates when Expo is linked.
@objc(SMLExpoDelegate)
final class SMLExpoDelegate: ExpoReactNativeFactoryDelegate {
	override func bundleURL() -> URL? {
		guard let path = SMLCapture.plan().bundlePath else {
			return nil
		}
		return URL(fileURLWithPath: path)
	}
}
