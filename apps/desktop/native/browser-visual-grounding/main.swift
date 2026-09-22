import AppKit
import Foundation
import Vision

struct Box: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct TextObservation: Codable {
    let text: String
    let box: Box
    let confidence: Float
}

struct Result: Codable {
    let imagePath: String
    let recognitionMode: String
    let width: Int
    let height: Int
    let durationMs: Double
    let globalDurationMs: Double
    let cropDurationMs: Double
    let cropRequestCount: Int
    let text: [TextObservation]
    let rectangles: [Box]
    let contours: [Box]
    let contourCount: Int
}

func imageBox(_ normalized: CGRect, width: Int, height: Int) -> Box {
    let x = Int((normalized.minX * Double(width)).rounded())
    let y = Int(((1 - normalized.maxY) * Double(height)).rounded())
    return Box(
        x: max(0, x),
        y: max(0, y),
        width: max(1, Int((normalized.width * Double(width)).rounded())),
        height: max(1, Int((normalized.height * Double(height)).rounded()))
    )
}

func containsCenter(_ outer: Box, _ inner: Box) -> Bool {
    let x = inner.x + inner.width / 2
    let y = inner.y + inner.height / 2
    return x >= outer.x && x <= outer.x + outer.width
        && y >= outer.y && y <= outer.y + outer.height
}

func mappedCropBox(_ normalized: CGRect, cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int) -> Box {
    let local = imageBox(normalized, width: cropWidth, height: cropHeight)
    return Box(x: cropX + local.x, y: cropY + local.y, width: local.width, height: local.height)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 3, arguments[0] == "--recognition", arguments[1] == "hybrid" else {
    fputs("usage: nautilo-browser-visual-grounding --recognition hybrid <png>\n", stderr)
    exit(1)
}
let imagePath = arguments[2]
let started = Date()
guard let image = NSImage(contentsOfFile: imagePath),
      let data = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: data),
      let cgImage = bitmap.cgImage else {
    fputs("could not decode image\n", stderr)
    exit(2)
}

let textRequest = VNRecognizeTextRequest()
textRequest.recognitionLevel = .fast
textRequest.usesLanguageCorrection = false
textRequest.recognitionLanguages = ["en-US"]

let rectangleRequest = VNDetectRectanglesRequest()
rectangleRequest.maximumObservations = 100
rectangleRequest.minimumSize = 0.005
rectangleRequest.minimumAspectRatio = 0.05
rectangleRequest.maximumAspectRatio = 1.0
rectangleRequest.quadratureTolerance = 20

let contourRequest = VNDetectContoursRequest()
contourRequest.maximumImageDimension = 1024
contourRequest.contrastAdjustment = 1.0

do {
    try VNImageRequestHandler(cgImage: cgImage).perform([textRequest, rectangleRequest, contourRequest])
} catch {
    fputs("vision extraction failed\n", stderr)
    exit(3)
}

let globalDurationMs = Date().timeIntervalSince(started) * 1000
let width = cgImage.width
let height = cgImage.height
var text = (textRequest.results ?? []).compactMap { observation -> TextObservation? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    return TextObservation(
        text: candidate.string,
        box: imageBox(observation.boundingBox, width: width, height: height),
        confidence: candidate.confidence
    )
}
let rectangles = (rectangleRequest.results ?? []).map {
    imageBox($0.boundingBox, width: width, height: height)
}
let contourObservation = contourRequest.results?.first
var contours: [Box] = []
if let contourObservation {
    for index in 0..<contourObservation.contourCount {
        guard let contour = try? contourObservation.contour(at: index) else { continue }
        let box = imageBox(contour.normalizedPath.boundingBox, width: width, height: height)
        let area = box.width * box.height
        if box.width >= 18 && box.height >= 12 && area >= 360
            && box.width < Int(Double(width) * 0.94)
            && box.height < Int(Double(height) * 0.94)
            && area < Int(Double(width * height) * 0.55) {
            contours.append(box)
        }
    }
}

let cropStarted = Date()
var cropRequestCount = 0
let maximumCropWidth = max(220, min(640, width / 3))
let maximumCropHeight = max(180, min(480, height / 3))
var claimedTextLikeContours: [Box] = []
var cropCandidates: [Box] = []
for rectangle in rectangles.sorted(by: { $0.width * $0.height < $1.width * $1.height }) {
    let aspectRatio = Double(rectangle.width) / Double(rectangle.height)
    let controlSized = rectangle.width >= 40 && rectangle.width <= maximumCropWidth
        && rectangle.height >= 40 && rectangle.height <= maximumCropHeight
        && aspectRatio >= 0.4 && aspectRatio <= 3
    let alreadyLabelled = text.contains { containsCenter(rectangle, $0.box) }
    let textLikeContours = contours.filter { contour in
        contour.width <= Int(Double(rectangle.width) * 0.6)
            && contour.height <= Int(Double(rectangle.height) * 0.6)
            && containsCenter(rectangle, contour)
    }
    let hasUnclaimedTextLikeContour = textLikeContours.contains { contour in
        !claimedTextLikeContours.contains { claimed in
            abs((claimed.x + claimed.width / 2) - (contour.x + contour.width / 2)) <= 8
                && abs((claimed.y + claimed.height / 2) - (contour.y + contour.height / 2)) <= 8
        }
    }
    if controlSized && !alreadyLabelled && hasUnclaimedTextLikeContour {
        cropCandidates.append(rectangle)
        claimedTextLikeContours.append(contentsOf: textLikeContours)
    }
}

for candidate in cropCandidates {
    let padding = 6
    let cropX = max(0, candidate.x - padding)
    let cropY = max(0, candidate.y - padding)
    let cropWidth = min(width - cropX, candidate.width + padding * 2)
    let cropHeight = min(height - cropY, candidate.height + padding * 2)
    guard let crop = cgImage.cropping(to: CGRect(x: cropX, y: cropY, width: cropWidth, height: cropHeight)) else { continue }
    cropRequestCount += 1
    let cropRequest = VNRecognizeTextRequest()
    cropRequest.recognitionLevel = .accurate
    cropRequest.usesLanguageCorrection = true
    cropRequest.recognitionLanguages = ["en-US"]
    guard (try? VNImageRequestHandler(cgImage: crop).perform([cropRequest])) != nil else { continue }
    for observation in cropRequest.results ?? [] {
        guard let recognized = observation.topCandidates(1).first else { continue }
        let box = mappedCropBox(
            observation.boundingBox,
            cropX: cropX,
            cropY: cropY,
            cropWidth: cropWidth,
            cropHeight: cropHeight
        )
        guard containsCenter(candidate, box) else { continue }
        let duplicate = text.contains {
            $0.text == recognized.string
                && abs(($0.box.x + $0.box.width / 2) - (box.x + box.width / 2)) <= 12
                && abs(($0.box.y + $0.box.height / 2) - (box.y + box.height / 2)) <= 12
        }
        if !duplicate {
            text.append(TextObservation(text: recognized.string, box: box, confidence: recognized.confidence))
        }
    }
}

let cropDurationMs = Date().timeIntervalSince(cropStarted) * 1000
let result = Result(
    imagePath: imagePath,
    recognitionMode: "hybrid",
    width: width,
    height: height,
    durationMs: Date().timeIntervalSince(started) * 1000,
    globalDurationMs: globalDurationMs,
    cropDurationMs: cropDurationMs,
    cropRequestCount: cropRequestCount,
    text: text,
    rectangles: rectangles,
    contours: contours,
    contourCount: contourObservation?.contourCount ?? 0
)
do {
    let encoded = try JSONEncoder().encode(result)
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data([0x0A]))
} catch {
    fputs("could not encode result\n", stderr)
    exit(4)
}
