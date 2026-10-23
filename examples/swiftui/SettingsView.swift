import SwiftUI

struct SettingsView: View {
	var name = "Ada Lovelace"
	@State private var notifications = true
	@State private var focus = false

	var body: some View {
		NavigationStack {
			List {
				Section {
					HStack(spacing: 14) {
						Circle()
							.fill(.indigo.gradient)
							.frame(width: 56, height: 56)
							.overlay(Text(String(name.prefix(1))).font(.title2.bold()).foregroundStyle(.white))
						VStack(alignment: .leading) {
							Text(name).font(.headline)
							Text("Rendered without a simulator").font(.subheadline).foregroundStyle(.secondary)
						}
					}
				}
				Section("Preferences") {
					Toggle("Notifications", isOn: $notifications)
					Toggle("Focus mode", isOn: $focus)
					LabeledContent("Version", value: "0.1.0")
				}
				Section {
					Button("Sign out", role: .destructive) {}
				}
			}
			.navigationTitle("Settings")
		}
	}
}
