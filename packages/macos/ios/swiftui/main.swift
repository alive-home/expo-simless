import SwiftUI
import UIKit

// `rnhViews` is generated next to this file by the CLI: one entry per view expression it was asked to render.
final class SMLSwiftUIAppDelegate: UIResponder, UIApplicationDelegate {
	var window: UIWindow?
	private var pending: [SMLJob] = []

	func application(
		_ application: UIApplication,
		didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
	) -> Bool {
		pending = SMLCapture.plan().jobs
		SMLCapture.whenSceneIsActive { self.runNext() }
		return true
	}

	private func runNext() {
		guard !pending.isEmpty else {
			SMLCapture.finish()
			return
		}
		let job = pending.removeFirst()
		SMLCapture.start(job)
		guard let makeView = rnhViews[job.component] else {
			SMLCapture.finish(job, error: "no view registered as \(job.component)", settled: false)
			runNext()
			return
		}
		let controller = UIHostingController(rootView: makeView())
		controller.view.backgroundColor = .clear
		let window = SMLCapture.makeWindow(for: job, rootViewController: controller)
		self.window = window
		// Padding as extra safe area, so a view that ignores the safe area still fills the frame.
		controller.additionalSafeAreaInsets.top += job.padding
		controller.additionalSafeAreaInsets.left += job.padding
		controller.additionalSafeAreaInsets.bottom += job.padding
		controller.additionalSafeAreaInsets.right += job.padding
		SMLCapture.waitUntilSettled(window, job: job) { settled in
			if job.fit {
				let fitting = controller.sizeThatFits(in: CGSize(width: job.size.width - 2 * job.padding, height: .greatestFiniteMagnitude))
				job.contentHeight = fitting.height + job.safeArea.top + job.safeArea.bottom + 2 * job.padding
			}
			do {
				try SMLCapture.writePNG(of: window, job: job)
				SMLCapture.finish(job, error: nil, settled: settled)
			} catch {
				SMLCapture.finish(job, error: error.localizedDescription, settled: settled)
			}
			SMLCapture.tearDownWindow(window)
			self.window = nil
			self.runNext()
		}
	}
}

_ = SMLCapture.loadPlan()
SMLCapture.prepareProcess()
_ = UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(SMLSwiftUIAppDelegate.self))
