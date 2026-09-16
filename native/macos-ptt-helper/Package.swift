// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "nautilo-ptt-helper",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .executable(
      name: "nautilo-ptt-helper",
      targets: ["NautiloPTTHelper"]
    )
  ],
  targets: [
    .executableTarget(
      name: "NautiloPTTHelper",
      path: "Sources"
    )
  ]
)
