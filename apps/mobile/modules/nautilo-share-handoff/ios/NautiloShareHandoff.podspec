Pod::Spec.new do |s|
  s.name           = 'NautiloShareHandoff'
  s.version        = '0.1.0'
  s.summary        = 'One-shot native text and URL handoff into Nautilo Mobile'
  s.description    = 'Consumes the bounded iOS App Group share record for the authenticated main app.'
  s.author         = 'Nautilo'
  s.homepage       = 'https://nautilo.dev'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
