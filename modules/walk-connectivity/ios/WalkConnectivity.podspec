Pod::Spec.new do |s|
  s.name = 'WalkConnectivity'
  s.version = '1.0.0'
  s.summary = 'Watch Connectivity bridge for Walking Study'
  s.homepage = 'https://github.com/coconocokun/routing-ios-app'
  s.license = { :type => 'UNLICENSED' }
  s.author = 'Walking Study'
  s.source = { :path => '.' }
  s.platform = :ios, '16.4'
  s.static_framework = true
  s.source_files = '*.swift'
  s.framework = 'WatchConnectivity'
  s.dependency 'ExpoModulesCore'
end
