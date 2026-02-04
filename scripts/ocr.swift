#!/usr/bin/env swift
// macOS OCR using Vision framework
// Usage: ./ocr <image_path>
// Output: Recognized text to stdout

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: ocr <image_path>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL) else {
    fputs("Error: Cannot load image from \(imagePath)\n", stderr)
    exit(1)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("Error: Cannot convert to CGImage\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])

    guard let observations = request.results else {
        exit(0)
    }

    let text = observations.compactMap { observation in
        observation.topCandidates(1).first?.string
    }.joined(separator: "\n")

    print(text)
} catch {
    fputs("Error: OCR failed - \(error.localizedDescription)\n", stderr)
    exit(1)
}
