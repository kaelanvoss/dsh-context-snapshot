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

/// Physical key codes are independent of the active keyboard layout. Locked
/// modifiers and media keys are intentionally absent: they are not held chords.
private let physicalCodes: [CGKeyCode: String] = [
    0: "KeyA", 1: "KeyS", 2: "KeyD", 3: "KeyF", 4: "KeyH", 5: "KeyG",
    6: "KeyZ", 7: "KeyX", 8: "KeyC", 9: "KeyV", 10: "IntlBackslash", 11: "KeyB",
    12: "KeyQ", 13: "KeyW", 14: "KeyE", 15: "KeyR", 16: "KeyY", 17: "KeyT",
    18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 22: "Digit6", 23: "Digit5",
    24: "Equal", 25: "Digit9", 26: "Digit7", 27: "Minus", 28: "Digit8", 29: "Digit0",
    30: "BracketRight", 31: "KeyO", 32: "KeyU", 33: "BracketLeft", 34: "KeyI", 35: "KeyP",
    36: "Enter", 37: "KeyL", 38: "KeyJ", 39: "Quote", 40: "KeyK", 41: "Semicolon",
    42: "Backslash", 43: "Comma", 44: "Slash", 45: "KeyN", 46: "KeyM", 47: "Period",
    48: "Tab", 49: "Space", 50: "Backquote", 51: "Backspace", 53: "Escape",
    54: "MetaRight", 55: "MetaLeft", 56: "ShiftLeft", 58: "AltLeft", 59: "ControlLeft",
    60: "ShiftRight", 61: "AltRight", 62: "ControlRight", 64: "F17", 65: "NumpadDecimal",
    67: "NumpadMultiply", 69: "NumpadAdd", 75: "NumpadDivide", 76: "NumpadEnter",
    78: "NumpadSubtract", 79: "F18", 80: "F19", 81: "NumpadEqual", 82: "Numpad0",
    83: "Numpad1", 84: "Numpad2", 85: "Numpad3", 86: "Numpad4", 87: "Numpad5",
    88: "Numpad6", 89: "Numpad7", 90: "F20", 91: "Numpad8", 92: "Numpad9",
    93: "IntlYen", 94: "IntlRo", 95: "NumpadComma", 96: "F5", 97: "F6", 98: "F7",
    99: "F3", 100: "F8", 101: "F9", 103: "F11", 105: "F13", 106: "F16", 107: "F14",
    109: "F10", 111: "F12", 113: "F15", 114: "Insert", 115: "Home", 116: "PageUp",
    117: "Delete", 118: "F4", 119: "End", 120: "F2", 121: "PageDown", 122: "F1",
    123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp"
]

private let modifierMasks: [String: UInt64] = [
    "ControlLeft": 0x01, "ControlRight": 0x2000,
    "ShiftLeft": 0x02, "ShiftRight": 0x04,
    "MetaLeft": 0x08, "MetaRight": 0x10,
    "AltLeft": 0x20, "AltRight": 0x40
]
private let modifierCodes = Set(modifierMasks.keys)
private let supportedCodes = Set(physicalCodes.values)

private struct ShortcutConfiguration {
    let codes: [String]
    static let defaultShortcut = ShortcutConfiguration(codes: ["MetaLeft", "MetaRight"])
    var object: [String: Any] { ["version": 1, "codes": codes] }

    static func parse(_ value: Any?) -> ShortcutConfiguration? {
        guard let object = value as? [String: Any],
              let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let codes = object["codes"] as? [String], codes.count == 2,
              Set(codes).count == codes.count, codes.allSatisfy({ supportedCodes.contains($0) }) else { return nil }
        return ShortcutConfiguration(codes: codes)
    }
}

/// Confined to the main run loop. Exact physical chords fire once on a fresh
/// bound-key press; releasing an unrelated extra key never causes a capture.
private struct ShortcutState {
    private(set) var shortcut = ShortcutConfiguration.defaultShortcut
    private(set) var pressed = Set<String>()
    private(set) var latched = false
    private(set) var recording = false
    private var blockedUntilRelease = Set<String>()

    mutating func reset(blocking held: Set<String> = []) {
        pressed.removeAll()
        latched = false
        blockedUntilRelease = held
    }

    mutating func configure(_ value: ShortcutConfiguration, blocking held: Set<String> = []) {
        shortcut = value
        reset(blocking: held)
    }

    mutating func setRecording(_ value: Bool, blocking held: Set<String> = []) {
        recording = value
        reset(blocking: held)
    }

    mutating func update(code: String?, down: Bool, modifiers: Set<String>, repeated: Bool = false,
                         physicallyHeld: Set<String>? = nil) -> Bool {
        guard !recording else { return false }
        let previous = pressed
        if let physicallyHeld {
            // Command shortcuts may omit an ordinary keyUp. On modifier events,
            // remove stale ordinary keys using the current physical key state.
            pressed = pressed.filter { modifierCodes.contains($0) || physicallyHeld.contains($0) }
            blockedUntilRelease = blockedUntilRelease.filter {
                modifierCodes.contains($0) || physicallyHeld.contains($0)
            }
        }
        pressed.subtract(modifierCodes)
        pressed.formUnion(modifiers)
        blockedUntilRelease = blockedUntilRelease.filter {
            !modifierCodes.contains($0) || modifiers.contains($0)
        }
        if let code, !modifierCodes.contains(code) {
            if down { pressed.insert(code) }
            else { pressed.remove(code); blockedUntilRelease.remove(code) }
        }
        let required = Set(shortcut.codes)
        if !previous.subtracting(pressed).isDisjoint(with: required) { latched = false }
        guard blockedUntilRelease.isEmpty, !repeated, !latched, pressed == required,
              !pressed.subtracting(previous).isDisjoint(with: required) else { return false }
        latched = true
        return true
    }
}

private struct CaptureFailure: Error {
    let code: String
    let message: String
}

/// One bounded, explicit recorder lease. Only the current combination and its
/// maximum simultaneous set exist; no character, sequence or durable history.
private struct PhysicalShortcutRecorder {
    private(set) var token: String?
    private(set) var state = "ended"
    private var current = Set<String>()
    private var peak = Set<String>()
    private var deadline = 0.0
    private var released = false
    var active: Bool { token != nil && ["waiting", "holding"].contains(state) }
    var tracked: Set<String> { current }
    var object: [String: Any] {
        ["token": token ?? "", "state": state, "current": current.sorted(), "peak": peak.sorted()]
    }
    mutating func begin(token value: String, now: Double, focused: Bool, held: Set<String>) throws {
        guard value.count >= 16, value.count <= 128, value != token else {
            throw CaptureFailure(code: "INVALID_RECORDING_TOKEN", message: "Recording requires a fresh short token")
        }
        guard focused else { throw CaptureFailure(code: "RECORDING_NOT_FOCUSED", message: "Keep DeepSeek Harness in the foreground while recording") }
        guard held.isEmpty else { throw CaptureFailure(code: "KEYS_ALREADY_HELD", message: "Release every key before starting a new recording") }
        token = value; state = "waiting"; current.removeAll(); peak.removeAll()
        deadline = now + 15; released = false
    }
    mutating func check(now: Double, focused: Bool) {
        guard active else { return }
        if now >= deadline { state = "expired"; current.removeAll(); peak.removeAll() }
        else if !focused { state = "interrupted"; current.removeAll(); peak.removeAll() }
    }
    mutating func update(code: String, down: Bool, now: Double, focused: Bool) {
        check(now: now, focused: focused)
        guard state == "waiting" || state == "holding" else { return }
        guard supportedCodes.contains(code) else {
            state = "interrupted"; current.removeAll(); peak.removeAll(); return
        }
        if down {
            guard !released else { return }
            if !current.contains(code) && current.count == 2 {
                state = "too_many"; current.removeAll(); peak.removeAll(); return
            }
            current.insert(code)
            if current.count > peak.count { peak = current }
            state = "holding"
        } else if current.remove(code) != nil {
            // A release closes simultaneous growth. A later key cannot be
            // merged into a candidate that was never held all at once.
            released = true
            if current.isEmpty { state = "complete" }
        }
    }
    mutating func end(clearToken: Bool = false) {
        state = "ended"; current.removeAll(); peak.removeAll(); released = false
        if clearToken { token = nil }
    }
    func require(_ value: String?) throws {
        guard let value, !value.isEmpty, value == token else {
            throw CaptureFailure(code: "INVALID_RECORDING_TOKEN", message: "This recording lease is no longer current")
        }
    }
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

/// A verified parent route may expose its next child even when child enumeration
/// fails. Call only after the parent's privacy and budget checks; the scheduled
/// child still receives those same checks on its regular visit.
private func additionalRootedFocusChild(_ focusChild: AXUIElement?,
                                       enumeratedChildren: [AXUIElement]?) -> AXUIElement? {
    guard let focusChild,
          enumeratedChildren?.contains(where: { CFEqual($0, focusChild) }) != true else { return nil }
    return focusChild
}

private func captureTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

private struct AccessibleCapture {
    var text = ""
    var reasons = Set<String>()
    var source: [String: String] = [:]
    var nodeCount = 0
    let startedAt = captureTimestamp()
    var finishedAt = ""
    var quality: [String: Any] {
        ["status": text.isEmpty ? "image_only" : reasons.isEmpty ? "available" : "partial",
         "reasons": reasons.sorted(), "textSource": "ax", "nodeCount": nodeCount,
         "scope": "ax_visible_children_when_available"]
    }
}

private func nodePriority(role: String?, subrole: String?, focusedPath: Bool, selected: Bool = false) -> Int {
    if focusedPath { return 0 }
    if selected { return 1 }
    if role == "AXSheet" || subrole == "AXDialog" || subrole == "AXSystemDialog" { return 2 }
    if role == "AXWebArea" || role == "AXDocument" { return 3 }
    return 4
}

private func verifiedSourceURL(_ value: CFTypeRef?) -> String? {
    let raw: String?
    if let string = value as? String { raw = string }
    else if let value, CFGetTypeID(value) == CFURLGetTypeID() { raw = CFURLGetString((value as! CFURL)) as String }
    else { raw = nil }
    guard let raw, raw.utf16.count <= 2048, let url = URL(string: raw),
          ["https", "http", "file"].contains(url.scheme?.lowercased() ?? "") else { return nil }
    return raw
}

/// A bounded capture-time AX tree, not OCR or a live inspector. Password and
/// reported-hidden subtrees are excluded before asking for any text values.
private func collectWindowText(_ window: AXUIElement?, pid: pid_t) -> AccessibleCapture {
    var result = AccessibleCapture()
    guard AXIsProcessTrusted() else {
        result.reasons.insert("accessibility_permission_denied")
        result.finishedAt = captureTimestamp()
        return result
    }
    guard let window else {
        result.reasons.insert("accessibility_unavailable")
        result.finishedAt = captureTimestamp()
        return result
    }
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
    // Follow only parent identities before reading content. A focus route is
    // admitted only when it reaches this captured window; normal privacy checks
    // still run on every ancestor before its descendants can be visited.
    var focusPath = Set<AXElementIdentity>()
    var focusChildren: [AXElementIdentity: AXUIElement] = [:]
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.025)
    if let focused = axValue(application, kAXFocusedUIElementAttribute as CFString),
       CFGetTypeID(focused) == AXUIElementGetTypeID() {
        var current = focused as! AXUIElement
        var route = Set<AXElementIdentity>()
        var children: [AXElementIdentity: AXUIElement] = [:]
        for _ in 0..<40 {
            guard ProcessInfo.processInfo.systemUptime < deadline,
                  route.insert(AXElementIdentity(element: current)).inserted else { break }
            AXUIElementSetMessagingTimeout(current, 0.025)
            if CFEqual(current, window) { focusPath = route; focusChildren = children; break }
            guard let parent = axValue(current, kAXParentAttribute as CFString),
                  CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            let parentElement = parent as! AXUIElement
            children[AXElementIdentity(element: parentElement)] = current
            current = parentElement
        }
    }
    while let (element, depth) = stack.popLast() {
        if nodeCount >= 300 { result.reasons.insert("node_budget_reached"); break }
        if textUnits >= maximumTextCharacters { result.reasons.insert("text_budget_reached"); break }
        if ProcessInfo.processInfo.systemUptime >= deadline { result.reasons.insert("time_budget_reached"); break }
        guard seen.insert(AXElementIdentity(element: element)).inserted else { continue }
        nodeCount += 1
        AXUIElementSetMessagingTimeout(element, 0.025)
        guard let security = axBatch(element, securityAttributes) else {
            result.reasons.insert("provider_read_failed"); continue
        }
        let role = security[kAXRoleAttribute as String] as? String
        let subrole = security[kAXSubroleAttribute as String] as? String
        // An unsupported/no-value optional attribute is different from a failed
        // safety read. Skip the subtree when its safety facts cannot be read.
        guard optionalAXSafetyValue(security[kAXSubroleAttribute as String], boolean: false),
            optionalAXSafetyValue(security[kAXHiddenAttribute as String], boolean: true),
            readableAXNode(role: role, subrole: subrole,
            hidden: axBoolean(security[kAXHiddenAttribute as String])), let role else {
            if role != "AXSecureTextField", subrole != "AXSecureTextField",
               axBoolean(security[kAXHiddenAttribute as String]) != true {
                result.reasons.insert("provider_read_failed")
            }
            continue
        }
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            result.reasons.insert("time_budget_reached"); break
        }
        let values: [String: CFTypeRef]
        if let read = axBatch(element, valueAttributes) { values = read }
        else { values = [:]; result.reasons.insert("provider_read_failed") }
        if values.values.contains(where: {
            guard let error = axAttributeError($0) else { return false }
            return error != .attributeUnsupported && error != .noValue
        }) { result.reasons.insert("provider_read_failed") }
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
            if let raw = values[attribute as String] as? String, raw.count > maximum {
                result.reasons.insert("field_truncated")
            }
            if let value = axScalar(values[attribute as String], maximum: maximum,
                preserveEmpty: attribute == kAXValueAttribute) { fields.append((name, value)) }
        }
        if axBoolean(values[kAXFocusedAttribute as String]) == true {
            result.source["focusedRole"] = role
            if let name = values[kAXTitleAttribute as String] as? String
                ?? values[kAXDescriptionAttribute as String] as? String, !name.isEmpty {
                result.source["focusedName"] = boundedUTF16Text(name, maximum: 256)
                if result.source["focusedName"] != name { result.reasons.insert("field_truncated") }
            }
        }
        if let selected = values[kAXSelectedTextAttribute as String] as? String, !selected.isEmpty,
           result.source["selectedText"] == nil || axBoolean(values[kAXFocusedAttribute as String]) == true {
            result.source["selectedText"] = boundedUTF16Text(selected, maximum: 1024)
            if result.source["selectedText"] != selected { result.reasons.insert("field_truncated") }
        }
        if ["AXWebArea", "AXDocument", "AXWindow"].contains(role),
           let url = verifiedSourceURL(values[kAXURLAttribute as String]), result.source["url"] == nil {
            result.source["url"] = url
        }
        if let range = axSelectedRange(values[kAXSelectedTextRangeAttribute as String]) {
            fields.append(("Selected range", range))
        }
        let line = accessibilityTreeLine(role: role, subrole: subrole, depth: depth, states: states, fields: fields)
        let remaining = maximumTextCharacters - textUnits
        let bounded = boundedUTF16Text(line, maximum: remaining - (fragments.isEmpty ? 0 : 1))
        if bounded != line { result.reasons.insert("text_budget_reached") }
        if !bounded.isEmpty { fragments.append(bounded); textUnits += bounded.utf16.count + (fragments.count > 1 ? 1 : 0) }
        guard nodeCount < 300, textUnits < maximumTextCharacters,
              ProcessInfo.processInfo.systemUptime < deadline else { continue }
        // Ask for only the remaining node budget, and use the provider's visible
        // children when it supports them. Do not expand giant full child arrays.
        var childValues: CFArray?
        var childAttribute = kAXVisibleChildrenAttribute as CFString
        var childResult = AXUIElementCopyAttributeValues(element, kAXVisibleChildrenAttribute as CFString,
            0, 300 - nodeCount, &childValues)
        if childResult == .attributeUnsupported {
            guard ProcessInfo.processInfo.systemUptime < deadline else { break }
            childAttribute = kAXChildrenAttribute as CFString
            childResult = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString,
                0, 300 - nodeCount, &childValues)
        }
        let children = childResult == .success ? childValues as? [AXUIElement] : nil
        let focusChild = focusChildren[AXElementIdentity(element: element)]
        let additionalFocusChild = additionalRootedFocusChild(focusChild, enumeratedChildren: children)
        if let children {
            var ranked: [(AXUIElement, Int, Int)] = []
            // A known rooted focus child remains first even when the provider's
            // bounded child slice ended before it. Its safety is still checked
            // by the regular visit, including secure/hidden ancestor exclusion.
            if let additionalFocusChild {
                ranked.append((additionalFocusChild, 0, -1))
            }
            let rankingDeadline = focusChild == nil
                ? min(deadline, ProcessInfo.processInfo.systemUptime + 0.075)
                : ProcessInfo.processInfo.systemUptime
            for (index, child) in children.enumerated() {
                if ProcessInfo.processInfo.systemUptime >= deadline {
                    result.reasons.insert("time_budget_reached")
                    ranked.append(contentsOf: children[index...].enumerated().map { ($0.element, 4, index + $0.offset) })
                    break
                }
                if focusPath.contains(AXElementIdentity(element: child)) {
                    ranked.append((child, 0, index)); continue
                }
                // Ranking has a small independent time allowance so unrelated
                // siblings cannot spend the focus route's entire read budget.
                if index >= 24 || ProcessInfo.processInfo.systemUptime >= rankingDeadline {
                    ranked.append((child, 4, index)); continue
                }
                // Ranking reads only roles, never labels or text of unchecked
                // descendants. Content and child enumeration remain fail closed.
                AXUIElementSetMessagingTimeout(child, 0.025)
                let labels = axBatch(child, [kAXRoleAttribute as String, kAXSubroleAttribute as String, kAXSelectedAttribute as String])
                ranked.append((child, nodePriority(role: labels?[kAXRoleAttribute as String] as? String,
                    subrole: labels?[kAXSubroleAttribute as String] as? String, focusedPath: false,
                    selected: axBoolean(labels?[kAXSelectedAttribute as String]) == true), index))
            }
            let ordered = ranked.sorted { $0.1 == $1.1 ? $0.2 < $1.2 : $0.1 < $1.1 }
            stack.append(contentsOf: ordered.reversed().map { ($0.0, depth + 1) })
            var childCount: CFIndex = 0
            if AXUIElementGetAttributeValueCount(element, childAttribute, &childCount) == .success,
               childCount > children.count { result.reasons.insert("node_budget_reached") }
        } else {
            if childResult != .attributeUnsupported && childResult != .noValue {
                result.reasons.insert("provider_read_failed")
            }
            // Failure to enumerate siblings must not discard a separately
            // verified focus route. This does not make the capture complete or
            // bypass secure/hidden checks on the next visit.
            if let additionalFocusChild { stack.append((additionalFocusChild, depth + 1)) }
        }
    }
    result.text = boundedText(fragments)
    result.nodeCount = nodeCount
    if nodeCount >= 300 { result.reasons.insert("node_budget_reached") }
    if textUnits >= maximumTextCharacters { result.reasons.insert("text_budget_reached") }
    if ProcessInfo.processInfo.systemUptime >= deadline { result.reasons.insert("time_budget_reached") }
    if result.text.isEmpty { result.reasons.insert("no_accessible_content") }
    result.finishedAt = captureTimestamp()
    return result
}

private struct WindowTarget {
    let app: NSRunningApplication
    let id: CGWindowID
    let title: String
    let frame: CGRect
    let accessibilityWindow: AXUIElement?
}

private struct RecordingWindowIdentity: Equatable {
    let pid: pid_t
    let id: CGWindowID
}

/// WindowServer returns on-screen rows from front to back. Recording needs
/// only the public owner/number/bounds fields, not a title or an AX grant.
private func frontRecordingWindow(pid: pid_t, rows: [[String: Any]]) -> RecordingWindowIdentity? {
    for row in rows {
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
              let id = row[kCGWindowNumber as String] as? NSNumber, id.uint32Value != 0,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds), frame.width > 1, frame.height > 1 else { continue }
        return RecordingWindowIdentity(pid: pid, id: CGWindowID(id.uint32Value))
    }
    return nil
}

private func validateCaptureTarget(_ target: WindowTarget) throws {
    let current = try foregroundTarget()
    guard current.app.processIdentifier == target.app.processIdentifier, current.id == target.id,
          target.title.isEmpty || current.title.isEmpty || current.title == target.title else {
        throw CaptureFailure(code: "WINDOW_CONTEXT_CHANGED", message: "The selected window changed during capture; capture it again")
    }
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
    guard let window = content.windows.first(where: {
        $0.windowID == target.id && $0.owningApplication?.processID == target.app.processIdentifier
    }) else {
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
    private var shortcutState = ShortcutState()
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var capturing = false
    private var recorder = PhysicalShortcutRecorder()
    private var recorderTimer: Timer?
    private var focusObserver: NSObjectProtocol?
    private var recordingWindow: RecordingWindowIdentity?

    private func harnessRecordingWindow() throws -> RecordingWindowIdentity {
        guard let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier,
              bundle == "com.deepseek.dsh" || bundle.hasPrefix("com.deepseek.dsh.") else {
            throw CaptureFailure(code: "RECORDING_NOT_FOCUSED", message: "Keep the DeepSeek Harness recording window in the foreground")
        }
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]], let identity = frontRecordingWindow(pid: app.processIdentifier, rows: rows) else {
            throw CaptureFailure(code: "RECORDING_WINDOW_UNAVAILABLE", message: "Cannot verify the foreground recording window; reopen the panel and retry")
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == identity.pid else {
            throw CaptureFailure(code: "RECORDING_NOT_FOCUSED", message: "The foreground application changed before recording began")
        }
        return identity
    }
    private func recordingWindowFocused() -> Bool {
        guard let recordingWindow else { return false }
        return (try? harnessRecordingWindow()) == recordingWindow
    }
    private func checkRecorder() {
        guard recorder.active else { return }
        recorder.check(now: ProcessInfo.processInfo.systemUptime, focused: recordingWindowFocused())
        // Command shortcuts can omit an ordinary keyUp. Only a direct physical
        // state query for already recorded keys can close that release; no
        // unobserved key or guessed modifier side enters the combination.
        let held = currentlyHeldCodes()
        for code in recorder.tracked where !held.contains(code) {
            recorder.update(code: code, down: false, now: ProcessInfo.processInfo.systemUptime, focused: recordingWindowFocused())
        }
    }

    func start() {
        // The host restores preferences and recorder leases before it explicitly
        // resumes capture. Restarting during key recording cannot capture here.
        shortcutState.setRecording(true, blocking: currentlyHeldCodes().intersection(supportedCodes))
        installTap()
        recorderTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.checkRecorder() }
        focusObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main) { [weak self] _ in self?.checkRecorder() }
        writer.send(["type": "ready", "protocol": 1, "platform": "darwin", "ready": tap != nil,
                     "shortcut": shortcutState.shortcut.object, "supportedCodes": supportedCodes.sorted(), "recording": true,
                     "supportsShortcutRecording": true])
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
        let interest = CGEventMask((1 << CGEventType.flagsChanged.rawValue)
            | (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue))
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: interest, callback: { _, type, event, userData in
                guard let userData else { return Unmanaged.passUnretained(event) }
                let helper = Unmanaged<SnapshotHelper>.fromOpaque(userData).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    helper.shortcutState.reset(blocking: helper.currentlyHeldCodes().intersection(supportedCodes))
                    // A listener gap cannot yield a trustworthy current/peak
                    // combination. Completed candidates are already frozen.
                    helper.recorder.check(now: ProcessInfo.processInfo.systemUptime, focused: false)
                    if let tap = helper.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                } else if type == .flagsChanged || type == .keyDown || type == .keyUp {
                    let flags = event.flags.rawValue
                    let modifiers = Set(modifierMasks.compactMap { code, mask in flags & mask != 0 ? code : nil })
                    let key = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
                    // An unmapped ordinary key still prevents an exact chord
                    // while held, but can never be stored as a shortcut.
                    let code = type == .flagsChanged ? nil : physicalCodes[key] ?? "unmapped-\(key)"
                    let held = type == .flagsChanged ? helper.currentlyHeldCodes() : nil
                    if helper.recorder.active {
                        let physical = physicalCodes[key] ?? "unmapped-\(key)"
                        let down = type == .flagsChanged ? held?.contains(physical) == true : type == .keyDown
                        helper.recorder.update(code: physical, down: down, now: ProcessInfo.processInfo.systemUptime,
                            focused: helper.recordingWindowFocused())
                        if type == .flagsChanged { helper.checkRecorder() }
                    }
                    if helper.shortcutState.update(code: code, down: type == .keyDown, modifiers: modifiers,
                        repeated: event.getIntegerValueField(.keyboardEventAutorepeat) != 0, physicallyHeld: held) {
                        helper.capture(id: UUID().uuidString)
                    }
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: userData)
        guard let tap else {
            diagnose("Global shortcut listener unavailable; grant Input Monitoring or Accessibility in System Settings, then requestPermissions or restart the helper")
            return
        }
        tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let tapSource { CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func currentlyHeldCodes() -> Set<String> {
        Set((0...127).compactMap { value -> String? in
            let key = CGKeyCode(value)
            return CGEventSource.keyState(.combinedSessionState, key: key)
                ? physicalCodes[key] ?? "unmapped-\(key)" : nil
        })
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
            writer.send(["type": "result", "id": id, "ok": true, "permissions": permissionState(),
                         "ready": tap != nil, "shortcut": shortcutState.shortcut.object,
                         "supportedCodes": supportedCodes.sorted(), "recording": shortcutState.recording])
        case "setShortcut":
            guard let shortcut = ShortcutConfiguration.parse(request["shortcut"]) else {
                writer.send(["type": "result", "id": id, "ok": false,
                    "error": ["code": "INVALID_SHORTCUT", "message": "Shortcut needs version 1 and exactly two distinct supported physical keys"]])
                return
            }
            shortcutState.configure(shortcut, blocking: currentlyHeldCodes().intersection(supportedCodes))
            writer.send(["type": "result", "id": id, "ok": true, "shortcut": shortcut.object])
        case "setRecording":
            guard let value = request["active"] as? NSNumber,
                  CFGetTypeID(value) == CFBooleanGetTypeID() else {
                writer.send(["type": "result", "id": id, "ok": false,
                    "error": ["code": "INVALID_REQUEST", "message": "Recording active must be a boolean"]])
                return
            }
            shortcutState.setRecording(value.boolValue, blocking: currentlyHeldCodes().intersection(supportedCodes))
            if !value.boolValue { recorder.end(clearToken: true); recordingWindow = nil }
            writer.send(["type": "result", "id": id, "ok": true, "recording": shortcutState.recording])
        case "beginShortcutRecording", "shortcutRecordingState", "endShortcutRecording":
            do {
                guard shortcutState.recording, tap != nil else {
                    throw CaptureFailure(code: "RECORDING_NOT_READY", message: "Pause capture and confirm the listener before recording")
                }
                if method == "beginShortcutRecording" {
                    guard let token = request["token"] as? String else {
                        throw CaptureFailure(code: "INVALID_RECORDING_TOKEN", message: "Recording requires a fresh short token")
                    }
                    let window = try harnessRecordingWindow()
                    try recorder.begin(token: token, now: ProcessInfo.processInfo.systemUptime,
                        focused: true, held: currentlyHeldCodes())
                    recordingWindow = window
                } else {
                    try recorder.require(request["token"] as? String)
                    if method == "endShortcutRecording" { recorder.end(); recordingWindow = nil }
                    else { checkRecorder() }
                }
                writer.send(["type": "result", "id": id, "ok": true, "recordingState": recorder.object])
            } catch {
                let failure = error as? CaptureFailure
                writer.send(["type": "result", "id": id, "ok": false,
                    "error": ["code": failure?.code ?? "RECORDING_FAILED", "message": failure?.message ?? error.localizedDescription]])
            }
        case "requestPermissions":
            // Only this explicit request is permitted to present macOS privacy prompts.
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
            if !AXIsProcessTrusted() {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
            }
            if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
            installTap()
            writer.send(["type": "result", "id": id, "ok": true, "permissions": permissionState(),
                         "ready": tap != nil, "shortcut": shortcutState.shortcut.object,
                         "supportedCodes": supportedCodes.sorted(), "recording": shortcutState.recording])
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
            let accessible = collectWindowText(target.accessibilityWindow, pid: target.app.processIdentifier)
            try validateCaptureTarget(target)
            Task { @MainActor in
                defer { self.capturing = false }
                do {
                    let appIcon = appIconPNGBase64(target.app.icon)
                    let image = try await screenshot(target)
                    let imageCapturedAt = captureTimestamp()
                    try validateCaptureTarget(target)
                    let data = try pngData(image)
                    var capture: [String: Any] = ["pngBase64": data.base64EncodedString(), "title": String(target.title.prefix(1024)),
                        "appName": String((target.app.localizedName ?? "").prefix(256)),
                        "bundleId": String((target.app.bundleIdentifier ?? "").prefix(256)),
                        "pid": target.app.processIdentifier, "width": image.width, "height": image.height,
                        "text": accessible.text, "capturedAt": imageCapturedAt,
                        "captureQuality": accessible.quality, "source": accessible.source,
                        "timing": ["imageCapturedAt": imageCapturedAt,
                            "textStartedAt": accessible.startedAt, "textFinishedAt": accessible.finishedAt]]
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
        recorder.end(clearToken: true)
        recordingWindow = nil
        recorderTimer?.invalidate()
        if let focusObserver { NSWorkspace.shared.notificationCenter.removeObserver(focusObserver) }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        exit(0)
    }
}

@MainActor
private func runSelfTest() throws {
    func verify(_ condition: Bool, _ message: String) throws {
        if !condition { throw CaptureFailure(code: "SELF_TEST_FAILED", message: message) }
    }
    var chord = ShortcutState()
    let events: [(Set<String>, Bool)] = [
        ([], false), (["MetaLeft"], false), (["MetaLeft", "MetaRight"], true),
        (["MetaLeft", "MetaRight"], false), (["MetaLeft"], false), (["MetaLeft", "MetaRight"], true),
        (["MetaRight"], false), ([], false), (["MetaRight"], false), (["MetaLeft", "MetaRight"], true)
    ]
    for (modifiers, expected) in events {
        try verify(chord.update(code: nil, down: false, modifiers: modifiers) == expected,
                   "Default Double Command chord failed")
    }
    try verify(ShortcutConfiguration.parse(["version": 1, "codes": ["MetaLeft", "KeyS"]]) != nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["F8", "F9"]]) != nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["F8", "F9", "F10"]]) == nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["F8", "F9", "F10", "F11"]]) == nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI"]]) == nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["KeyA"]]) == nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["KeyA", "KeyA"]]) == nil
        && ShortcutConfiguration.parse(["version": 2, "codes": ["MetaLeft", "KeyS"]]) == nil
        && ShortcutConfiguration.parse(["version": true, "codes": ["MetaLeft", "KeyS"]]) == nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["CapsLock", "KeyS"]]) == nil
        && ShortcutConfiguration.parse(["version": 1, "codes": ["Unknown", "KeyS"]]) == nil
        && ShortcutConfiguration.parse(["version": 1, "codes": [1, 2]]) == nil
        && supportedCodes.count == physicalCodes.count && modifierCodes.isSubset(of: supportedCodes),
        "Shortcut validation or physical code mapping failed")

    chord.configure(ShortcutConfiguration(codes: ["MetaLeft", "KeyS"]))
    try verify(!chord.update(code: "KeyS", down: true, modifiers: []), "Early key fired")
    try verify(chord.update(code: nil, down: false, modifiers: ["MetaLeft"]),
               "Mixed chord or reverse press order failed")
    try verify(!chord.update(code: "KeyS", down: true, modifiers: ["MetaLeft"], repeated: true),
               "Auto repeat fired")
    try verify(!chord.update(code: "KeyA", down: true, modifiers: ["MetaLeft"]),
               "Extra ordinary key fired")
    try verify(!chord.update(code: "KeyA", down: false, modifiers: ["MetaLeft"]),
               "Unrelated key release rearmed the chord")
    try verify(!chord.update(code: "KeyS", down: false, modifiers: ["MetaLeft"]),
               "Bound key release fired")
    try verify(chord.update(code: "KeyS", down: true, modifiers: ["MetaLeft"]),
               "Bound key release did not rearm")

    chord.configure(ShortcutConfiguration(codes: ["F8", "F9"]))
    try verify(!chord.update(code: "F8", down: true, modifiers: ["ShiftLeft"]), "Incomplete pair fired")
    try verify(!chord.update(code: "F9", down: true, modifiers: ["ShiftLeft"]), "Extra modifier was accepted")
    try verify(!chord.update(code: nil, down: false, modifiers: []), "Extra modifier release fired")
    try verify(!chord.update(code: "F8", down: false, modifiers: []), "Key release fired")
    try verify(chord.update(code: "F8", down: true, modifiers: []), "Ordinary pair did not fire")
    chord.setRecording(true)
    try verify(!chord.update(code: "F8", down: true, modifiers: []), "Recording did not pause")
    chord.setRecording(false, blocking: ["F8", "F9"])
    try verify(!chord.update(code: "F8", down: true, modifiers: [], repeated: true), "Recording resume repeated")
    try verify(!chord.update(code: "F9", down: true, modifiers: []), "Held recording key fired")
    try verify(!chord.update(code: "F8", down: false, modifiers: []), "Blocked release fired")
    try verify(!chord.update(code: "F9", down: false, modifiers: []), "Blocked pair release fired")
    try verify(!chord.update(code: "F9", down: true, modifiers: []), "Ordinary pair fired early")
    try verify(chord.update(code: "F8", down: true, modifiers: []), "Recording resume failed to rearm")
    chord.configure(ShortcutConfiguration(codes: ["MetaLeft", "KeyS"]))
    try verify(!chord.update(code: nil, down: false, modifiers: ["MetaLeft"]), "Modifier fired early")
    try verify(chord.update(code: "KeyS", down: true, modifiers: ["MetaLeft"]), "Command-letter chord failed")
    try verify(!chord.update(code: nil, down: false, modifiers: [], physicallyHeld: []), "Missing keyUp cleanup fired")
    try verify(chord.pressed.isEmpty && !chord.latched, "Missing Command keyUp was retained")
    try verify(!chord.update(code: nil, down: false, modifiers: ["MetaLeft"]), "Cleaned chord fired early")
    try verify(chord.update(code: "KeyS", down: true, modifiers: ["MetaLeft"]), "Missing keyUp cleanup did not rearm")
    chord.configure(ShortcutConfiguration(codes: ["MetaLeft", "MetaRight"]))
    try verify(!chord.update(code: "unmapped-63", down: true, modifiers: ["MetaLeft"]), "Unmapped key fired")
    try verify(!chord.update(code: nil, down: false, modifiers: ["MetaLeft", "MetaRight"],
                            physicallyHeld: ["unmapped-63"]), "Unmapped held key was ignored")
    try verify(!chord.update(code: "unmapped-63", down: false, modifiers: ["MetaLeft", "MetaRight"]),
               "Unmapped extra key release fired")
    try verify(!chord.update(code: nil, down: false, modifiers: ["MetaLeft"]), "Unmapped cleanup release fired")
    try verify(chord.update(code: nil, down: false, modifiers: ["MetaLeft", "MetaRight"]), "Unmapped cleanup failed")
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
    var qualityFixture = AccessibleCapture()
    qualityFixture.text = "AXButton: Save"
    try verify(qualityFixture.quality["status"] as? String == "available", "Successful AX capture was misclassified")
    qualityFixture.reasons = ["text_budget_reached", "field_truncated"]
    try verify(qualityFixture.quality["status"] as? String == "partial"
        && qualityFixture.quality["reasons"] as? [String] == ["field_truncated", "text_budget_reached"],
        "Partial quality reasons must remain factual and stable")
    qualityFixture.text = ""
    try verify(qualityFixture.quality["status"] as? String == "image_only", "Empty AX capture was not image-only")
    try verify(nodePriority(role: "AXToolbar", subrole: nil, focusedPath: true) == 0
        && nodePriority(role: "AXRow", subrole: nil, focusedPath: false, selected: true) == 1
        && nodePriority(role: "AXGroup", subrole: "AXDialog", focusedPath: false) == 2
        && nodePriority(role: "AXWebArea", subrole: nil, focusedPath: false) == 3
        && nodePriority(role: "AXToolbar", subrole: nil, focusedPath: false) == 4,
        "Focus, selection, dialog and document priority failed")
    // Identity-only AX references exercise scheduling without reading any app.
    let rootedFocusFixture = AXUIElementCreateApplication(123_451)
    let siblingFixture = AXUIElementCreateApplication(123_452)
    try verify(additionalRootedFocusChild(rootedFocusFixture, enumeratedChildren: nil)
        .map { CFEqual($0, rootedFocusFixture) } == true
        && additionalRootedFocusChild(rootedFocusFixture, enumeratedChildren: [])
        .map { CFEqual($0, rootedFocusFixture) } == true
        && additionalRootedFocusChild(rootedFocusFixture, enumeratedChildren: [siblingFixture])
        .map { CFEqual($0, rootedFocusFixture) } == true,
        "A verified focus route must survive failed, empty or bounded child enumeration")
    try verify(additionalRootedFocusChild(rootedFocusFixture,
        enumeratedChildren: [siblingFixture, rootedFocusFixture]) == nil
        && additionalRootedFocusChild(nil, enumeratedChildren: nil) == nil,
        "Focus scheduling must neither duplicate an enumerated child nor invent an unverified route")
    try verify(verifiedSourceURL("https://example.com/path?selected=1" as CFString) == "https://example.com/path?selected=1"
        && verifiedSourceURL("example.com/from-title" as CFString) == nil
        && verifiedSourceURL("javascript:alert(1)" as CFString) == nil,
        "Source URLs must be explicit absolute document URLs")
    let captureClock = ISO8601DateFormatter()
    captureClock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    try verify(captureClock.date(from: captureTimestamp()) != nil, "Capture timestamps must carry milliseconds and timezone")
    func recordingWindowRow(pid: Int, id: Int, layer: Int = 0, alpha: Double = 1) -> [String: Any] {
        [kCGWindowOwnerPID as String: NSNumber(value: pid), kCGWindowNumber as String: NSNumber(value: id),
         kCGWindowLayer as String: NSNumber(value: layer), kCGWindowAlpha as String: NSNumber(value: alpha),
         kCGWindowBounds as String: CGRect(x: 10, y: 10, width: 600, height: 400).dictionaryRepresentation,
         kCGWindowName as String: "An irrelevant mutable title"]
    }
    let recordingIdentity = RecordingWindowIdentity(pid: 321, id: 20)
    try verify(frontRecordingWindow(pid: 321, rows: [recordingWindowRow(pid: 111, id: 10),
        recordingWindowRow(pid: 321, id: 11, layer: 1), recordingWindowRow(pid: 321, id: 12, alpha: 0),
        recordingWindowRow(pid: 321, id: 20), recordingWindowRow(pid: 321, id: 21)]) == recordingIdentity,
        "Recorder window binding must use the front visible standard window of its exact owner")
    try verify(frontRecordingWindow(pid: 321, rows: []) == nil
        && recordingIdentity != RecordingWindowIdentity(pid: 321, id: 21)
        && recordingIdentity != RecordingWindowIdentity(pid: 322, id: 20),
        "Unknown windows, other windows of Harness, and recycled IDs with another owner must not match")
    var recorder = PhysicalShortcutRecorder()
    try verify(!recorder.active, "Capture pause must not implicitly start a key recorder")
    try recorder.begin(token: "recording-test-token-1", now: 1, focused: true, held: [])
    let recordedKeys = ["ControlLeft", "ShiftRight"]
    for code in recordedKeys { recorder.update(code: code, down: true, now: 2, focused: true) }
    try verify(recorder.object["current"] as? [String] == recordedKeys.sorted()
        && recorder.object["peak"] as? [String] == recordedKeys.sorted(), "Two physical recorder keys or sides were lost")
    recorder.update(code: "ShiftRight", down: true, now: 2, focused: true)
    recorder.update(code: "ControlLeft", down: false, now: 3, focused: true)
    try verify(recorder.state == "holding", "A first release must not complete before all releases")
    recorder.update(code: "KeyC", down: true, now: 3, focused: true)
    try verify(recorder.object["peak"] as? [String] == recordedKeys.sorted()
        && !recorder.tracked.contains("KeyC"), "A post-release key forged a never-simultaneous chord")
    for code in recordedKeys { recorder.update(code: code, down: false, now: 4, focused: true) }
    recorder.check(now: 50, focused: true)
    try verify(recorder.state == "complete" && recorder.tracked.isEmpty
        && recorder.object["peak"] as? [String] == recordedKeys.sorted(), "Completed candidates must remain reviewable after the acquisition deadline")
    recorder.check(now: 51, focused: false)
    recorder.update(code: "KeyC", down: true, now: 52, focused: true)
    try verify(!recorder.active && recorder.state == "complete"
        && recorder.object["peak"] as? [String] == recordedKeys.sorted(), "A completed candidate must survive later focus changes and ignore new key events")
    recorder.end()
    try verify(!recorder.active && recorder.object["peak"] as? [String] == [], "Ended recorder retained physical keys")
    func rejectsRecording(_ code: String, _ action: () throws -> Void) throws {
        do { try action(); throw CaptureFailure(code: "SELF_TEST_FAILED", message: "Invalid recorder operation was accepted") }
        catch let failure as CaptureFailure { try verify(failure.code == code, "Recorder error classification failed") }
    }
    try rejectsRecording("INVALID_RECORDING_TOKEN") { try recorder.require("other-recording-token") }
    try rejectsRecording("KEYS_ALREADY_HELD") { try recorder.begin(token: "recording-test-token-2", now: 60, focused: true, held: ["KeyA"]) }
    try rejectsRecording("RECORDING_NOT_FOCUSED") { try recorder.begin(token: "recording-test-token-2", now: 60, focused: false, held: []) }
    try recorder.begin(token: "recording-test-token-2", now: 60, focused: true, held: [])
    try rejectsRecording("INVALID_RECORDING_TOKEN") { try recorder.begin(token: "recording-test-token-2", now: 60, focused: true, held: []) }
    recorder.update(code: "KeyA", down: true, now: 61, focused: true)
    recorder.check(now: 75, focused: true)
    try verify(recorder.state == "expired" && recorder.tracked.isEmpty
        && recorder.object["peak"] as? [String] == [], "Unfinished recorder did not expire at 15 seconds")
    try recorder.begin(token: "recording-test-token-3", now: 80, focused: true, held: [])
    recorder.update(code: "KeyA", down: true, now: 81, focused: true)
    recorder.check(now: 82, focused: false); recorder.check(now: 83, focused: true)
    try verify(recorder.state == "interrupted" && recorder.tracked.isEmpty
        && recorder.object["peak"] as? [String] == [], "Focus loss failed to clear and terminate the lease")
    try recorder.begin(token: "recording-test-token-4", now: 90, focused: true, held: [])
    recorder.update(code: "KeyA", down: true, now: 91, focused: true)
    recorder.update(code: "KeyA", down: false, now: 92, focused: true)
    try verify(recorder.state == "complete" && recorder.object["peak"] as? [String] == ["KeyA"], "Single-key completion must be explicit for UI rejection")
    recorder.update(code: "KeyB", down: true, now: 93, focused: true)
    try verify(recorder.object["peak"] as? [String] == ["KeyA"], "Two non-overlapping single-key gestures must not become a pair")
    recorder.end(clearToken: true)
    try rejectsRecording("INVALID_RECORDING_TOKEN") { try recorder.require("recording-test-token-4") }
    try recorder.begin(token: "recording-test-token-5", now: 100, focused: true, held: [])
    let manyKeys = ["KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI"]
    for code in manyKeys.prefix(3) { recorder.update(code: code, down: true, now: 101, focused: true) }
    try verify(recorder.state == "too_many" && recorder.tracked.isEmpty && recorder.object["peak"] as? [String] == [],
        "The third simultaneous key must reject immediately, without silently clipping")
    for code in manyKeys.dropFirst(3) { recorder.update(code: code, down: true, now: 101, focused: true) }
    for code in manyKeys { recorder.update(code: code, down: false, now: 102, focused: true) }
    try verify(recorder.state == "too_many" && !recorder.active && recorder.tracked.isEmpty
        && recorder.object["peak"] as? [String] == [], "A third simultaneous key must terminate recording without retaining the first pair")
    try recorder.require("recording-test-token-5")
    recorder.check(now: 200, focused: false)
    try verify(recorder.state == "too_many", "A rejected three-key recording must stay terminal until explicit cleanup")
    recorder.end(); recorder.end()
    try verify(recorder.state == "ended" && recorder.object["peak"] as? [String] == [], "Rejected chord cleanup must be idempotent")
    try recorder.begin(token: "recording-test-token-6", now: 110, focused: true, held: [])
    recorder.update(code: "unmapped-255", down: true, now: 111, focused: true)
    try verify(recorder.state == "interrupted" && recorder.object["peak"] as? [String] == [], "Unsupported physical events must not manufacture an accepted chord")
    try recorder.begin(token: "recording-test-token-7", now: 120, focused: true, held: [])
    recorder.update(code: "KeyA", down: true, now: 121, focused: true)
    recorder.check(now: 122, focused: recordingIdentity == RecordingWindowIdentity(pid: 321, id: 21))
    try verify(recorder.state == "interrupted" && recorder.object["peak"] as? [String] == [], "Switching Harness windows must terminate unfinished recording")
    try recorder.begin(token: "recording-test-token-8", now: 130, focused: true, held: [])
    for code in ["KeyA", "KeyB"] { recorder.update(code: code, down: true, now: 131, focused: true) }
    for code in ["KeyA", "KeyB"] { recorder.update(code: code, down: false, now: 132, focused: true) }
    try verify(recorder.state == "complete" && recorder.object["peak"] as? [String] == ["KeyA", "KeyB"], "A pair of different ordinary physical keys must complete")
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
    JSONWriter().send(["type": "self-test", "ok": true, "checks": ["dual-command-chord", "hold-no-repeat", "release-rearm", "shortcut-validation-and-physical-codes", "mixed-chord-reverse-press-order", "exact-ordinary-and-modifier-chords", "recording-pause-and-held-key-blocking", "exactly-two-key-configuration-and-oversize-rejection", "command-missing-keyup-cleanup", "unmapped-extra-key-blocking", "unicode-text-limit", "utf16-emoji-limit", "utf16-grapheme-and-newline-boundaries", "ax-tree-hierarchy-and-repeated-controls", "ax-provider-states", "ax-selection-range", "ax-safe-scalars-and-string-bounds", "ax-password-hidden-and-failed-safety-exclusion", "capture-quality-classification-and-reasons", "focus-dialog-document-priority", "rooted-focus-route-child-enumeration-fallback", "verified-document-source-url", "capture-clock-format", "two-key-recording-and-third-key-rejection", "recording-token-focus-expiry-and-cleanup", "recorder-window-identity-and-focus", "png-encoding", "app-icon-png-bounds", "app-icon-transparent-padding", "app-icon-optional-fallback"]])
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
