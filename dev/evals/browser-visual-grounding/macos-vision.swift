#!/usr/bin/env swift

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
    let width: Int
    let height: Int
    let durationMs: Double
    let text: [TextObservation]
    let rectangles: [Box]
    let contours: [Box]
    let contourCount: Int
}

func imageBox(_ normalized: CGRect, width: Int, height: Int) -> Box {
    let x = Int((normalized.minX * Double(width)).rounded())
    let y = Int(((1 - normalized.maxY) * Double(height)).rounded())
    let boxWidth = max(1, Int((normalized.width * Double(width)).rounded()))
    let boxHeight = max(1, Int((normalized.height * Double(height)).rounded()))
    return Box(x: max(0, x), y: max(0, y), width: boxWidth, height: boxHeight)
}

let encoder = JSONEncoder()

for imagePath in CommandLine.arguments.dropFirst() {
    let started = Date()
    guard let image = NSImage(contentsOfFile: imagePath),
          let data = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: data),
          let cgImage = bitmap.cgImage else {
        fputs("Could not decode \(imagePath)\n", stderr)
        exit(2)
    }

    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .fast
    textRequest.usesLanguageCorrection = false

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
        fputs("Vision failed for \(imagePath): \(error)\n", stderr)
        exit(3)
    }
    let durationMs = Date().timeIntervalSince(started) * 1000
    let width = cgImage.width
    let height = cgImage.height
    let text = (textRequest.results ?? []).compactMap { observation -> TextObservation? in
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
    let result = Result(
        imagePath: imagePath,
        width: width,
        height: height,
        durationMs: durationMs,
        text: text,
        rectangles: rectangles,
        contours: contours,
        contourCount: contourObservation?.contourCount ?? 0
    )
    let encoded = try encoder.encode(result)
    print(String(decoding: encoded, as: UTF8.self))
}
