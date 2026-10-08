import AppKit
@preconcurrency import ApplicationServices
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

private let maximumPNGBytes = 12 * 1024 * 1024
private let maximumTextCharacters = 16_000
private let helperBundleID = "io.dsh.context-snapshot.helper"

/// Device-specific modifier flags distinguish a chord from two presses of one key.
struct DoubleCommandState {
    private(set) var latched = false

    mutating func update(left: Bool, right: Bool) -> Bool {
        if !left || !right {
            latched = false
            return false
        }
        guard !latched else { return false }
        latched = true
        return true
    }
}

private struct CaptureFailure: Error {
    let code: String
    let message: String
}

private final class JSONWriter: @unchecked Sendable {
    private let lock = NSLock()

    func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            diagnose("Cannot encode protocol response")
            return
        }
        data.append(0x0a)
        lock.lock()
        defer { lock.unlock() }
        do { try FileHandle.standardOutput.write(contentsOf: data) }
        catch { diagnose("Protocol output failed: \(error.localizedDescription)") }
    }
}

private func diagnose(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
}

private func permissionState() -> [String: Bool] {
    ["screenRecording": CGPreflightScreenCaptureAccess(),
     "accessibility": AXIsProcessTrusted(),
     "inputMonitoring": CGPreflightListenEventAccess()]
}

private func axValue(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axValue(element, attribute) as? String
}

private func focusedWindow(_ pid: pid_t) -> AXUIElement? {
    guard AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.025)
    guard let value = axValue(application, kAXFocusedWindowAttribute as CFString),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func axWindowFrame(_ window: AXUIElement?) -> CGRect? {
    guard let window,
          let position = axValue(window, kAXPositionAttribute as CFString),
          let size = axValue(window, kAXSizeAttribute as CFString),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}

private func boundedText(_ fragments: [String], maximum: Int = maximumTextCharacters) -> String {
    String(fragments.joined(separator: "\n").prefix(maximum))
}

/// Read visible accessibility content with strict node, time and character limits.
/// Secure text fields are excluded, including their descendants.
private func collectWindowText(_ window: AXUIElement?) -> String {
    guard let window, AXIsProcessTrusted() else { return "" }
    AXUIElementSetMessagingTimeout(window, 0.025)
    let deadline = ProcessInfo.processInfo.systemUptime + 1.0
    var stack = [window]
    var fragments: [String] = []
    var seen = Set<String>()
    var characterCount = 0
    var nodeCount = 0
    while let element = stack.popLast() {
        guard nodeCount < 300, characterCount < maximumTextCharacters,
              ProcessInfo.processInfo.systemUptime < deadline else { break }
        nodeCount += 1
        let role = axString(element, kAXRoleAttribute as CFString) ?? ""
        let subrole = axString(element, kAXSubroleAttribute as CFString) ?? ""
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" { continue }
        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            guard ProcessInfo.processInfo.systemUptime < deadline else { break }
            guard let raw = axString(element, attribute as CFString) else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = String(trimmed.prefix(maximumTextCharacters - characterCount))
            if !text.isEmpty && seen.insert(text).inserted {
                fragments.append(text)
                characterCount += text.count + 1
            }
        }
        guard ProcessInfo.processInfo.systemUptime < deadline else { break }
        if let children = axValue(element, kAXChildrenAttribute as CFString) as? [AXUIElement] {
            stack.append(contentsOf: children.prefix(max(0, 300 - nodeCount)).reversed())
        }
    }
    return boundedText(fragments)
}

private struct WindowTarget {
    let app: NSRunningApplication
    let id: CGWindowID
    let title: String
    let frame: CGRect
    let accessibilityWindow: AXUIElement?
}

private func isExcludedApplication(_ app: NSRunningApplication) -> Bool {
    let bundle = app.bundleIdentifier ?? ""
    let name = app.localizedName?.lowercased() ?? ""
    return app.processIdentifier == ProcessInfo.processInfo.processIdentifier
        || bundle == helperBundleID
        || bundle == "com.deepseek.dsh"
        || bundle.hasPrefix("com.deepseek.dsh.")
        || name == "deepseek harness"
        || name == "dsh"
}

private func foregroundTarget() throws -> WindowTarget {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        throw CaptureFailure(code: "NO_FRONTMOST_WINDOW", message: "No foreground application is available")
    }
    guard !isExcludedApplication(app) else {
        throw CaptureFailure(code: "SELF_WINDOW", message: "The snapshot helper and DeepSeek Harness windows are skipped")
    }
    let focused = focusedWindow(app.processIdentifier)
    let focusedTitle = focused.flatMap { axString($0, kAXTitleAttribute as CFString) } ?? ""
    let focusedFrame = axWindowFrame(focused)
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else {
        throw CaptureFailure(code: "NO_FRONTMOST_WINDOW", message: "Cannot list visible windows")
    }
    let candidates: [(CGWindowID, CGRect, String)] = rows.compactMap { row in
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
              (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
              let id = row[kCGWindowNumber as String] as? NSNumber,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds), frame.width > 1, frame.height > 1 else { return nil }
        return (CGWindowID(id.uint32Value), frame, row[kCGWindowName as String] as? String ?? "")
    }
    guard !candidates.isEmpty else {
        throw CaptureFailure(code: "NO_FRONTMOST_WINDOW", message: "The foreground application has no visible standard window")
    }
    let focusedCandidate = focusedFrame.flatMap { frame in
        candidates.first { abs($0.1.minX - frame.minX) < 3 && abs($0.1.minY - frame.minY) < 3
            && abs($0.1.width - frame.width) < 3 && abs($0.1.height - frame.height) < 3 }
    } ?? candidates.first { !focusedTitle.isEmpty && $0.2 == focusedTitle }
    let selected = focusedCandidate ?? candidates[0]
    return WindowTarget(app: app, id: selected.0, title: selected.2.isEmpty ? focusedTitle : selected.2,
                        frame: selected.1, accessibilityWindow: focusedCandidate == nil ? nil : focused)
}

private func pngData(_ image: CGImage) throws -> Data {
    guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw CaptureFailure(code: "ENCODE_FAILED", message: "Cannot encode the window screenshot as PNG")
    }
    guard data.count <= maximumPNGBytes else {
        throw CaptureFailure(code: "IMAGE_TOO_LARGE", message: "The PNG exceeds the 12 MiB snapshot limit")
    }
    return data
}

private final class OneFrameCollector: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var completion: ((Result<CGImage, Error>) -> Void)?
    var stream: SCStream?

    init(completion: @escaping (Result<CGImage, Error>) -> Void) { self.completion = completion }

    func finish(_ result: Result<CGImage, Error>) {
        lock.lock()
        let callback = completion
        completion = nil
        let captureStream = stream
        stream = nil
        lock.unlock()
        guard let callback else { return }
        if let captureStream { captureStream.stopCapture { _ in } }
        callback(result)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { finish(.failure(error)) }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let source = CIImage(cvPixelBuffer: buffer)
        guard let image = CIContext().createCGImage(source, from: source.extent) else {
            finish(.failure(CaptureFailure(code: "CAPTURE_FAILED", message: "Cannot decode the window capture frame")))
            return
        }
        finish(.success(image))
    }
}

/// ScreenCaptureKit returns an immutable enumeration snapshot from its callback.
/// Swift's SDK declaration does not mark that snapshot as Sendable yet.
private struct ShareableContentSnapshot: @unchecked Sendable {
    let value: SCShareableContent
}

private func shareableContent() async throws -> ShareableContentSnapshot {
    try await withCheckedThrowingContinuation { continuation in
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
            if let content { continuation.resume(returning: ShareableContentSnapshot(value: content)) }
            else { continuation.resume(throwing: error ?? CaptureFailure(code: "CAPTURE_FAILED", message: "Cannot enumerate capture windows")) }
        }
    }
}

@MainActor
private func screenshot(_ target: WindowTarget) async throws -> CGImage {
    let content = try await shareableContent().value
    guard let window = content.windows.first(where: { $0.windowID == target.id }) else {
        throw CaptureFailure(code: "WINDOW_CLOSED", message: "The selected foreground window closed before capture")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 1
    let downscale = min(1, 4096 / max(target.frame.width * scale, target.frame.height * scale))
    configuration.width = max(1, Int((target.frame.width * scale * downscale).rounded(.up)))
    configuration.height = max(1, Int((target.frame.height * scale * downscale).rounded(.up)))
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.showsCursor = false
    configuration.capturesAudio = false
    configuration.queueDepth = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    if #available(macOS 14.0, *) {
        return try await withCheckedThrowingContinuation { continuation in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                if let image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: error ?? CaptureFailure(code: "CAPTURE_FAILED", message: "Window screenshot failed")) }
            }
        }
    }
    return try await withCheckedThrowingContinuation { continuation in
        let receiver = OneFrameCollector { result in continuation.resume(with: result) }
        let stream = SCStream(filter: filter, configuration: configuration, delegate: receiver)
        receiver.stream = stream
        do {
            try stream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "io.dsh.context-snapshot.frame"))
            stream.startCapture { error in if let error { receiver.finish(.failure(error)) } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                receiver.finish(.failure(CaptureFailure(code: "CAPTURE_TIMEOUT", message: "No window frame arrived within five seconds")))
            }
        } catch { receiver.finish(.failure(error)) }
    }
}

/// Mutable capture/listener state is confined to the main run loop. The only
/// background access is the independently locked protocol writer.
private final class SnapshotHelper: @unchecked Sendable {
    private let writer = JSONWriter()
    private var commandState = DoubleCommandState()
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var capturing = false

    func start() {
        installTap()
        writer.send(["type": "ready", "protocol": 1, "platform": "darwin"])
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine() {
                guard line.utf8.count <= 65_536 else {
                    self?.writer.send(["type": "error", "error": ["code": "INVALID_REQUEST", "message": "Expected one JSON request per line"]])
                    continue
                }
                DispatchQueue.main.async { self?.handleLine(line) }
            }
            DispatchQueue.main.async { self?.shutdown() }
        }
    }

    private func installTap() {
        guard tap == nil else { return }
        let userData = Unmanaged.passUnretained(self).toOpaque()
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: CGEventMask(1 << CGEventType.flagsChanged.rawValue), callback: { _, type, event, userData in
                guard let userData else { return Unmanaged.passUnretained(event) }
                let helper = Unmanaged<SnapshotHelper>.fromOpaque(userData).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    helper.commandState = DoubleCommandState()
                    if let tap = helper.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                } else if type == .flagsChanged {
                    let key = event.getIntegerValueField(.keyboardEventKeycode)
                    if key == 54 || key == 55 {
                        let flags = event.flags.rawValue
                        if helper.commandState.update(left: flags & 0x08 != 0, right: flags & 0x10 != 0) {
                            helper.capture(id: UUID().uuidString)
                        }
                    }
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: userData)
        guard let tap else {
            diagnose("Global modifier listener unavailable; grant Input Monitoring or Accessibility in System Settings, then requestPermissions or restart the helper")
            return
        }
        tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let tapSource { CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handleLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            writer.send(["type": "error", "error": ["code": "INVALID_REQUEST", "message": "Expected one JSON request per line"]])
            return
        }
        let id = request["id"] as? String ?? UUID().uuidString
        guard id.count <= 128, let method = request["method"] as? String else {
            writer.send(["type": "error", "captureId": id, "error": ["code": "INVALID_REQUEST", "message": "Request needs a short id and method"]])
            return
        }
        switch method {
        case "capture": capture(id: id)
        case "permissions", "status":
            writer.send(["type": "result", "id": id, "ok": true, "permissions": permissionState()])
        case "requestPermissions":
            // Only this explicit request is permitted to present macOS privacy prompts.
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
            if !AXIsProcessTrusted() {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
            }
            if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
            installTap()
            writer.send(["type": "result", "id": id, "ok": true, "permissions": permissionState()])
        case "shutdown":
            writer.send(["type": "result", "id": id, "ok": true])
            shutdown()
        default:
            writer.send(["type": "error", "captureId": id, "error": ["code": "INVALID_METHOD", "message": "Unknown helper method"]])
        }
    }

    private func capture(id: String) {
        guard !capturing else {
            writer.send(["type": "error", "captureId": id, "error": ["code": "BUSY", "message": "A window snapshot is already being captured"]])
            return
        }
        capturing = true
        writer.send(["type": "trigger", "captureId": id])
        // Resolve the foreground target before any asynchronous work or Harness activation.
        do {
            guard CGPreflightScreenCaptureAccess() else {
                throw CaptureFailure(code: "SCREEN_RECORDING_PERMISSION", message: "Grant Screen Recording to ContextSnapshot.app before capturing")
            }
            let target = try foregroundTarget()
            let text = collectWindowText(target.accessibilityWindow)
            Task { @MainActor in
                defer { self.capturing = false }
                do {
                    let image = try await screenshot(target)
                    let data = try pngData(image)
                    let capture: [String: Any] = ["pngBase64": data.base64EncodedString(), "title": String(target.title.prefix(1024)),
                        "appName": String((target.app.localizedName ?? "").prefix(256)),
                        "bundleId": String((target.app.bundleIdentifier ?? "").prefix(256)),
                        "pid": target.app.processIdentifier, "width": image.width, "height": image.height,
                        "text": text, "capturedAt": ISO8601DateFormatter().string(from: Date())]
                    self.writer.send(["type": "capture", "captureId": id, "capture": capture])
                } catch { self.sendError(id: id, error: error) }
            }
        } catch {
            capturing = false
            sendError(id: id, error: error)
        }
    }

    private func sendError(id: String, error: Error) {
        let failure = error as? CaptureFailure
        writer.send(["type": "error", "captureId": id,
                     "error": ["code": failure?.code ?? "CAPTURE_FAILED", "message": failure?.message ?? error.localizedDescription]])
    }

    private func shutdown() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        exit(0)
    }
}

private func runSelfTest() throws {
    var chord = DoubleCommandState()
    let events: [(Bool, Bool, Bool)] = [
        (false, false, false), (true, false, false), (true, true, true),
        (true, true, false), (true, false, false), (true, true, true),
        (false, true, false), (false, false, false), (false, true, false), (true, true, true)
    ]
    for event in events {
        guard chord.update(left: event.0, right: event.1) == event.2 else {
            throw CaptureFailure(code: "SELF_TEST_FAILED", message: "Double Command chord state failed")
        }
    }
    guard boundedText([String(repeating: "界", count: 20_000)]).count == maximumTextCharacters else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "Text limit failed")
    }
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 8, bitsPerPixel: 32),
        let image = bitmap.cgImage else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "PNG fixture allocation failed")
    }
    let png = try pngData(image)
    guard png.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]), png.count <= maximumPNGBytes else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "PNG encoding failed")
    }
    JSONWriter().send(["type": "self-test", "ok": true, "checks": ["dual-command-chord", "hold-no-repeat", "release-rearm", "unicode-text-limit", "png-encoding"]])
}

if CommandLine.arguments.contains("--self-test") {
    do { try runSelfTest(); exit(0) }
    catch { diagnose(error.localizedDescription); exit(1) }
}

private let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
private let helper = SnapshotHelper()
helper.start()
application.run()
