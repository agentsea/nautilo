Pod::Spec.new do |s|
  s.name           = 'NautiloFileExport'
  s.version        = '0.1.0'
  s.summary        = 'Narrow user-selected file export for Nautilo Mobile'
  s.description    = 'Exports an app-cache file through the native iOS document picker.'
  s.author         = 'Nautilo'
  s.homepage       = 'https://nautilo.dev'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
