Pod::Spec.new do |s|
  s.name = 'NautiloVoicePcm'
  s.version = '0.1.0'
  s.summary = 'Streaming speech playback for Nautilo Mobile'
  s.description = 'A bounded PCM sink with stream-scoped cancellation.'
  s.author = 'Nautilo'
  s.homepage = 'https://nautilo.ai'
  s.platforms = { :ios => '15.1' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
