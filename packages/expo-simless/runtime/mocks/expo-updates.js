// Stands in for expo-updates: an embedded build with updates disabled and nothing to download, which is what
// a component sees on a build that has not received an update.
const NONE = { isAvailable: false, isRollBackToEmbedded: false, manifest: undefined, reason: "noUpdateAvailable" }

const exports_ = {
	__esModule: true,
	isEnabled: false,
	isEmbeddedLaunch: true,
	isEmergencyLaunch: false,
	emergencyLaunchReason: null,
	launchDuration: null,
	updateId: null,
	channel: null,
	runtimeVersion: null,
	createdAt: null,
	manifest: {},
	checkAutomatically: "ON_LOAD",
	latestContext: {},
	checkForUpdateAsync: async () => NONE,
	fetchUpdateAsync: async () => ({ isNew: false, isRollBackToEmbedded: false, manifest: undefined }),
	reloadAsync: async () => {},
	getExtraParamsAsync: async () => ({}),
	setExtraParamAsync: async () => {},
	readLogEntriesAsync: async () => [],
	clearLogEntriesAsync: async () => {},
	setUpdateURLAndRequestHeadersOverride: () => {},
	addListener: () => ({ remove: () => {} }),
	useUpdateEvents: () => {},
	useUpdates: () => ({
		currentlyRunning: { isEmbeddedLaunch: true, isEmergencyLaunch: false, updateId: undefined, channel: undefined },
		isUpdateAvailable: false,
		isUpdatePending: false,
		isChecking: false,
		isDownloading: false,
		isRestarting: false,
		restartCount: 0,
		availableUpdate: undefined,
		downloadedUpdate: undefined,
		checkError: undefined,
		downloadError: undefined,
		lastCheckForUpdateTimeSinceRestart: undefined,
	}),
	UpdateCheckResultNotAvailableReason: { NO_UPDATE_AVAILABLE_ON_SERVER: "noUpdateAvailableOnServer" },
	UpdateInfoType: { NEW: "new", ROLLBACK: "rollback" },
}
exports_.default = exports_

module.exports = exports_
