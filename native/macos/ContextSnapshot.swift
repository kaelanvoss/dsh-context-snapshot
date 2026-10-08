import AppKit
@preconcurrency import ApplicationServices
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

private let maximumPNGBytes = 12 * 1024 * 1024
private let appIconPixels = 32
private let maximumAppIconPNGBytes = 8 * 1024
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

/// Match JavaScript text.length's UTF-16 budget while cutting only at complete
/// Character boundaries, including emoji sequences and combining marks.
private func boundedUTF16Text(_ text: String, maximum: Int) -> String {
    guard maximum > 0 else { return "" }
    var end = text.startIndex
    var units = 0
    while end < text.endIndex {
        let next = text.index(after: end)
        let cost = text[end..<next].utf16.count
        guard cost <= maximum - units else { break }
        units += cost
        end = next
    }
    return String(text[..<end])
}

private func boundedText(_ fragments: [String], maximum: Int = maximumTextCharacters) -> String {
    boundedUTF16Text(fragments.joined(separator: "\n"), maximum: maximum)
}

/// Attribute errors stay distinguishable from a reported false/empty value.
private func axAttributeError(_ value: CFTypeRef?) -> AXError? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID(),
          AXValueGetType(value as! AXValue) == .axError else { return nil }
    var error = AXError.success
    return AXValueGetValue(value as! AXValue, .axError, &error) ? error : .failure
}

private func axBatch(_ element: AXUIElement, _ attributes: [String]) -> [String: CFTypeRef]? {
    var result: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, [], &result) == .success,
          let values = result as? [CFTypeRef], values.count == attributes.count else { return nil }
    return Dictionary(uniqueKeysWithValues: zip(attributes, values))
}

private func axBoolean(_ value: CFTypeRef?) -> Bool? {
    guard let value, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return (value as! NSNumber).boolValue
}

/// Strings are quoted on one line. Never stringify arrays, image data, elements,
/// or arbitrary provider objects; only known scalar AX values enter the tree.
private func quotedAXText(_ text: String, maximum: Int = 1024, preserveEmpty: Bool = false) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard preserveEmpty || !trimmed.isEmpty else { return nil }
    let value = String(trimmed.prefix(maximum)) + (trimmed.count > maximum ? "…" : "")
    guard let data = try? JSONSerialization.data(withJSONObject: [value]),
          let encoded = String(data: data, encoding: .utf8) else { return nil }
    return String(encoded.dropFirst().dropLast())
}

private func axScalar(_ value: CFTypeRef?, maximum: Int = 1024, preserveEmpty: Bool = false) -> String? {
    guard let value else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID(), let text = value as? String {
        return quotedAXText(text, maximum: maximum, preserveEmpty: preserveEmpty)
    }
    if let flag = axBoolean(value) { return flag ? "true" : "false" }
    if CFGetTypeID(value) == CFNumberGetTypeID(), let number = value as? NSNumber,
       number.doubleValue.isFinite { return number.stringValue }
    if CFGetTypeID(value) == CFURLGetTypeID() {
        return quotedAXText(CFURLGetString((value as! CFURL)) as String, maximum: maximum)
    }
    return nil
}

private func axSelectedRange(_ value: CFTypeRef?) -> String? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID(),
          AXValueGetType(value as! AXValue) == .cfRange else { return nil }
    var range = CFRange(location: 0, length: 0)
    guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.location >= 0,
          range.length >= 0, range.location <= Int.max - range.length else { return nil }
    return "location=\(range.location), length=\(range.length)"
}

private func axCheckedState(role: String, value: CFTypeRef?) -> String? {
    guard role == "AXCheckBox" || role == "AXRadioButton", let value else { return nil }
    if let flag = axBoolean(value) { return flag ? "true" : "false" }
    guard CFGetTypeID(value) == CFNumberGetTypeID(), let number = value as? NSNumber else { return nil }
    switch number.doubleValue {
    case 0: return "false"
    case 1: return "true"
    case 2 where role == "AXCheckBox": return "mixed"
    default: return nil
    }
}

private func readableAXNode(role: String?, subrole: String?, hidden: Bool?) -> Bool {
    guard let role, !role.isEmpty else { return false }
    return role != "AXSecureTextField" && subrole != "AXSecureTextField" && hidden != true
}

private func optionalAXSafetyValue(_ value: CFTypeRef?, boolean: Bool) -> Bool {
    if let error = axAttributeError(value) { return error == .attributeUnsupported || error == .noValue }
    guard let value else { return false }
    // CopyMultipleAttributeValues documents CFNull for an unavailable optional
    // attribute. It is not a failed transport read or a fabricated false state.
    if CFGetTypeID(value) == CFNullGetTypeID() { return true }
    return boolean ? axBoolean(value) != nil : CFGetTypeID(value) == CFStringGetTypeID()
}

private func accessibilityTreeLine(role: String, subrole: String?, depth: Int,
                                   states: [(String, String)], fields: [(String, String)]) -> String {
    // Pathological provider depth cannot consume the entire budget as indentation.
    let indent = String(repeating: " ", count: min(max(depth, 0), 24) * 2)
    let cleanRole = String(role.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(256))
    let sub = subrole.flatMap { quotedAXText($0, maximum: 256) }.map { " [subrole=\($0)]" } ?? ""
    let level = depth > 24 ? " [depth=\(depth)]" : ""
    let state = states.isEmpty ? "" : " (" + states.map { "\($0.0)=\($0.1)" }.joined(separator: ", ") + ")"
    let values = fields.isEmpty ? "" : ": " + fields.map { "\($0.0): \($0.1)" }.joined(separator: "; ")
    return indent + cleanRole + sub + level + state + values
}

private struct AXElementIdentity: Hashable {
    let element: AXUIElement
    static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.element, rhs.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

/// A bounded capture-time AX tree, not OCR or a live inspector. Password and
/// reported-hidden subtrees are excluded before asking for any text values.
private func collectWindowText(_ window: AXUIElement?) -> String {
    guard let window, AXIsProcessTrusted() else { return "" }
    AXUIElementSetMessagingTimeout(window, 0.025)
    let deadline = ProcessInfo.processInfo.systemUptime + 1.0
    var stack: [(AXUIElement, Int)] = [(window, 0)]
    var fragments: [String] = []
    var seen = Set<AXElementIdentity>()
    var textUnits = 0
    var nodeCount = 0
    let securityAttributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXHiddenAttribute].map { $0 as String }
    let valueAttributes = [kAXTitleAttribute, kAXDescriptionAttribute, kAXRoleDescriptionAttribute,
        kAXHelpAttribute, kAXValueAttribute, kAXValueDescriptionAttribute, kAXSelectedTextAttribute,
        kAXSelectedTextRangeAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute,
        kAXExpandedAttribute, kAXURLAttribute].map { $0 as String }
    while let (element, depth) = stack.popLast() {
        guard nodeCount < 300, textUnits < maximumTextCharacters,
              ProcessInfo.processInfo.systemUptime < deadline else { break }
        guard seen.insert(AXElementIdentity(element: element)).inserted else { continue }
        nodeCount += 1
        AXUIElementSetMessagingTimeout(element, 0.025)
        guard let security = axBatch(element, securityAttributes) else { continue }
        let role = security[kAXRoleAttribute as String] as? String
        let subrole = security[kAXSubroleAttribute as String] as? String
        // An unsupported/no-value optional attribute is different from a failed
        // safety read. Skip the subtree when its safety facts cannot be read.
        guard optionalAXSafetyValue(security[kAXSubroleAttribute as String], boolean: false),
            optionalAXSafetyValue(security[kAXHiddenAttribute as String], boolean: true),
            readableAXNode(role: role, subrole: subrole,
            hidden: axBoolean(security[kAXHiddenAttribute as String])), let role else { continue }
        guard ProcessInfo.processInfo.systemUptime < deadline else { break }
        let values = axBatch(element, valueAttributes) ?? [:]
        var states: [(String, String)] = []
        for (name, attribute) in [("enabled", kAXEnabledAttribute), ("focused", kAXFocusedAttribute),
            ("selected", kAXSelectedAttribute), ("expanded", kAXExpandedAttribute)] {
            if let flag = axBoolean(values[attribute as String]) { states.append((name, flag ? "true" : "false")) }
        }
        if let checked = axCheckedState(role: role, value: values[kAXValueAttribute as String]) {
            states.append(("checked", checked))
        }
        var fields: [(String, String)] = []
        for (name, attribute) in [("Title", kAXTitleAttribute), ("Description", kAXDescriptionAttribute),
            ("Role description", kAXRoleDescriptionAttribute), ("Help", kAXHelpAttribute),
            ("Value", kAXValueAttribute), ("Value description", kAXValueDescriptionAttribute),
            ("Selected text", kAXSelectedTextAttribute), ("URL", kAXURLAttribute)] {
            let maximum = attribute == kAXTitleAttribute ? 256 : 1024
            if let value = axScalar(values[attribute as String], maximum: maximum,
                preserveEmpty: attribute == kAXValueAttribute) { fields.append((name, value)) }
        }
        if let range = axSelectedRange(values[kAXSelectedTextRangeAttribute as String]) {
            fields.append(("Selected range", range))
        }
        let line = accessibilityTreeLine(role: role, subrole: subrole, depth: depth, states: states, fields: fields)
        let remaining = maximumTextCharacters - textUnits
        let bounded = boundedUTF16Text(line, maximum: remaining - (fragments.isEmpty ? 0 : 1))
        if !bounded.isEmpty { fragments.append(bounded); textUnits += bounded.utf16.count + (fragments.count > 1 ? 1 : 0) }
        guard nodeCount < 300, textUnits < maximumTextCharacters,
              ProcessInfo.processInfo.systemUptime < deadline else { continue }
        // Ask for only the remaining node budget, and use the provider's visible
        // children when it supports them. Do not expand giant full child arrays.
        var childValues: CFArray?
        var childResult = AXUIElementCopyAttributeValues(element, kAXVisibleChildrenAttribute as CFString,
            0, 300 - nodeCount, &childValues)
        if childResult == .attributeUnsupported {
            guard ProcessInfo.processInfo.systemUptime < deadline else { break }
            childResult = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString,
                0, 300 - nodeCount, &childValues)
        }
        if childResult == .success, let children = childValues as? [AXUIElement] {
            stack.append(contentsOf: children.reversed().map { ($0, depth + 1) })
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

/// Render the local application icon at a fixed size, retaining transparent padding.
/// A missing or unencodable icon must not prevent the window snapshot.
@MainActor
private func appIconPNGBase64(_ image: NSImage?) -> String? {
    guard let image, image.size.width.isFinite, image.size.height.isFinite,
          image.size.width > 0, image.size.height > 0,
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
            pixelsWide: appIconPixels, pixelsHigh: appIconPixels, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: appIconPixels * 4, bitsPerPixel: 32),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    let side = CGFloat(appIconPixels)
    let scale = min(side / image.size.width, side / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let rect = CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2,
                      width: size.width, height: size.height)
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    context.cgContext.clear(CGRect(x: 0, y: 0, width: side, height: side))
    context.imageInterpolation = .high
    image.draw(in: rect, from: .zero, operation: .copy, fraction: 1)
    guard let data = bitmap.representation(using: .png, properties: [:]),
          data.count <= maximumAppIconPNGBytes else { return nil }
    return data.base64EncodedString()
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
                DispatchQueue.main.async { [weak self] in self?.handleLine(line) }
            }
            DispatchQueue.main.async { [weak self] in self?.shutdown() }
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
                    let appIcon = appIconPNGBase64(target.app.icon)
                    let image = try await screenshot(target)
                    let data = try pngData(image)
                    var capture: [String: Any] = ["pngBase64": data.base64EncodedString(), "title": String(target.title.prefix(1024)),
                        "appName": String((target.app.localizedName ?? "").prefix(256)),
                        "bundleId": String((target.app.bundleIdentifier ?? "").prefix(256)),
                        "pid": target.app.processIdentifier, "width": image.width, "height": image.height,
                        "text": text, "capturedAt": ISO8601DateFormatter().string(from: Date())]
                    if let appIcon { capture["appIconPngBase64"] = appIcon }
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

@MainActor
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
    let emojis = boundedText([String(repeating: "😀", count: 20_000)])
    let combining = boundedText([String(repeating: "e\u{301}", count: 20_000)])
    let joinedEmoji = "👩🏽‍💻"
    guard emojis.utf16.count == maximumTextCharacters, emojis.count == maximumTextCharacters / 2,
          combining.utf16.count == maximumTextCharacters, combining.count == maximumTextCharacters / 2,
          boundedText(["A😀B"], maximum: 2) == "A",
          boundedText(["A😀B"], maximum: 3) == "A😀",
          boundedText(["e\u{301}e\u{301}"], maximum: 3) == "e\u{301}",
          boundedText(["A" + joinedEmoji + "B"], maximum: joinedEmoji.utf16.count) == "A",
          boundedText(["A" + joinedEmoji + "B"], maximum: joinedEmoji.utf16.count + 1) == "A" + joinedEmoji,
          boundedText(["a", "😀", "b"], maximum: 4) == "a\n😀",
          boundedText(["😀"], maximum: 1).isEmpty,
          boundedText(["text"], maximum: 0).isEmpty else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "UTF-16 limit, newline budget or grapheme boundary failed")
    }
    let label = quotedAXText("共享按钮", maximum: 256)!
    let firstNode = accessibilityTreeLine(role: "AXButton", subrole: nil, depth: 1,
        states: [("enabled", "true"), ("focused", "false")], fields: [("Title", label)])
    let secondNode = accessibilityTreeLine(role: "AXButton", subrole: nil, depth: 2,
        states: [("enabled", "false"), ("focused", "true")], fields: [("Title", label)])
    let tree = boundedText(["AXWindow", firstNode, secondNode])
    guard firstNode.hasPrefix("  AXButton (enabled=true, focused=false)"),
          secondNode.hasPrefix("    AXButton (enabled=false, focused=true)"),
          tree.components(separatedBy: label).count == 3,
          accessibilityTreeLine(role: "AXGroup", subrole: nil, depth: 30, states: [], fields: [])
            .contains("[depth=30]"),
          boundedText([String(repeating: tree, count: 500)]).count == maximumTextCharacters else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "AX tree hierarchy, state, repeated controls or budget failed")
    }
    let quoted = quotedAXText("第一行\n\"第二行\"\t末尾")!
    guard !quoted.contains("\n"), quoted.contains("\\n"), quoted.contains("\\\""),
          quotedAXText(String(repeating: "界", count: 1100))?.count == 1027,
          axScalar(["not", "text"] as CFArray) == nil,
          axScalar(Data([1, 2, 3]) as CFData) == nil,
          axScalar(NSNumber(value: Double.nan)) == nil,
          axScalar(kCFBooleanFalse) == "false",
          axScalar("" as CFString, preserveEmpty: true) == "\"\"",
          axScalar(NSNumber(value: 42)) == "42",
          axCheckedState(role: "AXCheckBox", value: NSNumber(value: 2)) == "mixed",
          axCheckedState(role: "AXRadioButton", value: NSNumber(value: 2)) == nil,
          axCheckedState(role: "AXSlider", value: NSNumber(value: 1)) == nil else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "AX safe scalar, quoting, bounds or checked-state failed")
    }
    var selectedRange = CFRange(location: 3, length: 2)
    var missingAttribute = AXError.attributeUnsupported
    var failedAttribute = AXError.cannotComplete
    guard let selectedValue = AXValueCreate(.cfRange, &selectedRange),
          let missingValue = AXValueCreate(.axError, &missingAttribute),
          let failedValue = AXValueCreate(.axError, &failedAttribute),
          axSelectedRange(selectedValue) == "location=3, length=2",
          optionalAXSafetyValue(missingValue, boolean: true),
          optionalAXSafetyValue(kCFNull, boolean: true),
          !optionalAXSafetyValue(failedValue, boolean: true),
          !optionalAXSafetyValue(NSNumber(value: 123), boolean: true),
          !readableAXNode(role: "AXSecureTextField", subrole: nil, hidden: false),
          !readableAXNode(role: "AXTextField", subrole: "AXSecureTextField", hidden: false),
          !readableAXNode(role: "AXTextField", subrole: nil, hidden: true),
          !readableAXNode(role: nil, subrole: nil, hidden: false),
          readableAXNode(role: "AXTextField", subrole: nil, hidden: false) else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "AX selection or fail-closed privacy policy failed")
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
    guard let iconBitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 128, pixelsHigh: 64,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 128 * 4, bitsPerPixel: 32),
        let iconContext = NSGraphicsContext(bitmapImageRep: iconBitmap) else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "App icon fixture allocation failed")
    }
    iconContext.cgContext.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    iconContext.cgContext.fill(CGRect(x: 0, y: 0, width: 128, height: 64))
    let iconImage = NSImage(size: NSSize(width: 128, height: 64))
    iconImage.addRepresentation(iconBitmap)
    guard let iconBase64 = appIconPNGBase64(iconImage), let iconPNG = Data(base64Encoded: iconBase64),
          iconPNG.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
          iconPNG.count <= maximumAppIconPNGBytes, let decodedIcon = NSBitmapImageRep(data: iconPNG),
          decodedIcon.pixelsWide == appIconPixels, decodedIcon.pixelsHigh == appIconPixels,
          let center = decodedIcon.colorAt(x: appIconPixels / 2, y: appIconPixels / 2),
          let corner = decodedIcon.colorAt(x: 0, y: 0), center.alphaComponent > 0.99,
          corner.alphaComponent < 0.01, appIconPNGBase64(nil) == nil,
          appIconPNGBase64(NSImage(size: .zero)) == nil else {
        throw CaptureFailure(code: "SELF_TEST_FAILED", message: "App icon encoding, bounds or fallback failed")
    }
    JSONWriter().send(["type": "self-test", "ok": true, "checks": ["dual-command-chord", "hold-no-repeat", "release-rearm", "unicode-text-limit", "utf16-emoji-limit", "utf16-grapheme-and-newline-boundaries", "ax-tree-hierarchy-and-repeated-controls", "ax-provider-states", "ax-selection-range", "ax-safe-scalars-and-string-bounds", "ax-password-hidden-and-failed-safety-exclusion", "png-encoding", "app-icon-png-bounds", "app-icon-transparent-padding", "app-icon-optional-fallback"]])
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
