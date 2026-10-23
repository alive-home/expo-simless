# Creates SimlessHost.xcodeproj: one Mac Catalyst app target over the host sources, which `pod install`
# then wires to the project's native modules. Usage: ruby create_project.rb <dir>
require 'xcodeproj'

dir, = ARGV

project = Xcodeproj::Project.new(File.join(dir, 'SimlessHost.xcodeproj'))
target = project.new_target(:application, 'SimlessHost', :ios, '17.0')
group = project.main_group.new_group('SimlessHost', 'SimlessHost')

%w[SMLReactHost.mm SMLCapture.m SMLExpoDelegate.swift].each do |name|
  target.add_file_references([group.new_file(name)])
end
%w[SMLCapture.h SimlessHost-Bridging-Header.h Info.plist].each { |name| group.new_file(name) }

target.build_configurations.each do |config|
  settings = config.build_settings
  settings['INFOPLIST_FILE'] = 'SimlessHost/Info.plist'
  settings['GENERATE_INFOPLIST_FILE'] = 'NO'
  settings['PRODUCT_NAME'] = 'SimlessHost'
  settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.alivelabs.simless.native'
  settings['DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER'] = 'NO'
  settings['SUPPORTS_MACCATALYST'] = 'YES'
  # iPad only: Catalyst then runs the app as "Scale interface to match iPad", with iOS-styled controls.
  settings['TARGETED_DEVICE_FAMILY'] = '2'
  settings['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'
  settings['SWIFT_VERSION'] = '5.0'
  settings['SWIFT_OBJC_BRIDGING_HEADER'] = 'SimlessHost/SimlessHost-Bridging-Header.h'
  settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'
  settings['CLANG_ENABLE_MODULES'] = 'YES'
  settings['CODE_SIGN_STYLE'] = 'Manual'
  settings['CODE_SIGN_IDENTITY'] = '-'
  settings['DEVELOPMENT_TEAM'] = ''
  settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
end
target.add_system_framework('CoreText')

project.save

scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(target, nil)
scheme.save_as(project.path, 'SimlessHost', true)
