// The local server's private, one-request helper. No socket, shell, clipboard or dependencies.
// Built into Annie.app/Contents/MacOS; the app stays the responsible process for macOS TCC.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

private var cancelled: Int32 = 0
private struct Failure: Error { let message: String }

private func checkCancellation() throws {
    if cancelled != 0 { throw Failure(message: "Operazione Computer Use annullata") }
}

private func integer(_ args: [String: Any], _ name: String, _ range: ClosedRange<Int>) throws -> Int {
    guard let n = args[name] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
          n.doubleValue.isFinite, n.doubleValue == Double(n.intValue), range.contains(n.intValue)
    else { throw Failure(message: "Parametro Computer Use non valido: \(name)") }
    return n.intValue
}

private func dimensions() -> (Int, Int) {
    // Quartz events use display points, not Retina backing pixels. This same coordinate
    // space is returned as screenshot_original_* for desktop-tools.ts's image mapping.
    let bounds = CGDisplayBounds(CGMainDisplayID())
    return (Int(bounds.width), Int(bounds.height))
}

private func point(_ args: [String: Any], _ x: String = "x", _ y: String = "y") throws -> CGPoint {
    let (width, height) = dimensions()
    guard width > 0, height > 0 else { throw Failure(message: "Nessuno schermo principale disponibile") }
    return CGPoint(x: try integer(args, x, 0...(width - 1)), y: try integer(args, y, 0...(height - 1)))
}

private func source() throws -> CGEventSource {
    guard let source = CGEventSource(stateID: .hidSystemState) else { throw Failure(message: "Impossibile usare gli eventi di macOS") }
    return source
}

private func mouse(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton = .left, count: Int = 1) throws {
    guard let event = CGEvent(mouseEventSource: try source(), mouseType: type, mouseCursorPosition: at, mouseButton: button)
    else { throw Failure(message: "Impossibile creare un evento del mouse") }
    event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    event.post(tap: .cghidEventTap)
}

private func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, unicode: [UniChar]? = nil) throws {
    guard let event = CGEvent(keyboardEventSource: try source(), virtualKey: code, keyDown: down)
    else { throw Failure(message: "Impossibile creare un evento della tastiera") }
    event.flags = flags
    if let units = unicode { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units) }
    event.post(tap: .cghidEventTap)
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
    "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
    "backspace": 51, "escape": 53, "f17": 64, "f18": 79, "f19": 80,
    "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103,
    "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
    "home": 115, "page_up": 116, "delete": 117, "f4": 118, "end": 119, "f2": 120,
    "page_down": 121, "f1": 122, "left": 123, "right": 124, "down": 125, "up": 126,
]

private func combo(_ keys: [String]) throws -> (CGKeyCode, CGEventFlags) {
    guard !keys.isEmpty, keys.count <= 5, let last = keys.last, let code = keyCodes[last.lowercased()]
    else { throw Failure(message: "Tasto non supportato su macOS") }
    var flags: CGEventFlags = []
    for modifier in keys.dropLast() {
        switch modifier.lowercased() {
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        case "super", "cmd", "command", "meta": flags.insert(.maskCommand)
        default: throw Failure(message: "Modificatore della tastiera non valido")
        }
    }
    if last.count == 1 && last != last.lowercased() { flags.insert(.maskShift) }
    return (code, flags)
}

@main struct ComputerUse {
    @MainActor static func permissions() -> [String: Any] {
        var result: [String: Any] = ["kind": "local", "supported": false, "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
        if #available(macOS 14.0, *) { result["supported"] = true }
        else { result["problem"] = "Computer Use richiede macOS 14 o successivo" }
        return result
    }

    @MainActor static func run(_ tool: String, _ args: [String: Any]) async throws -> [String: Any] {
        try checkCancellation()
        if tool == "permissions" { return ["permissions": permissions()] }
        if tool == "request_permission" {
            guard let kind = args["kind"] as? String, ["screenRecording", "accessibility"].contains(kind)
            else { throw Failure(message: "Permesso Computer Use non valido") }
            guard #available(macOS 14.0, *) else { return ["permissions": permissions()] }
            let pane: String
            if kind == "screenRecording" {
                // Only this explicit user action asks TCC to register/show the app.
                _ = CGRequestScreenCaptureAccess()
                pane = "Privacy_ScreenCapture"
            } else {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                pane = "Privacy_Accessibility"
            }
            guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"), NSWorkspace.shared.open(url)
            else { throw Failure(message: "Apri Impostazioni di Sistema, Privacy e sicurezza, per concedere il permesso") }
            return ["permissions": permissions()]
        }
        guard #available(macOS 14.0, *) else { throw Failure(message: "Computer Use richiede macOS 14 o successivo") }
        let (width, height) = dimensions()
        if tool == "get_screen_size" { return ["structured": ["width": width, "height": height, "scale_factor": 1, "display": "main"]] }
        guard CGPreflightScreenCaptureAccess() else { throw Failure(message: "Consenti Registrazione schermo nelle impostazioni Computer Use; poi premi Controlla di nuovo") }
        if tool == "get_desktop_state" {
            let requested = args["max_image_dimension"] == nil ? 1280 : try integer(args, "max_image_dimension", 1...1280)
            let scale = min(1, Double(requested) / Double(max(width, height)))
            let imageWidth = max(1, Int((Double(width) * scale).rounded()))
            let imageHeight = max(1, Int((Double(height) * scale).rounded()))
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            try checkCancellation()
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
            else { throw Failure(message: "Lo schermo principale non è disponibile per la registrazione") }
            let config = SCStreamConfiguration()
            config.width = imageWidth
            config.height = imageHeight
            config.showsCursor = true
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            try checkCancellation()
            let bitmap = NSBitmapImageRep(cgImage: image)
            guard let data = bitmap.representation(using: .png, properties: [:]), data.count <= 5 * 1024 * 1024
            else { throw Failure(message: "Impossibile produrre un'immagine PNG entro i limiti consentiti") }
            let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
            return ["png": data.base64EncodedString(), "text": "Mac condiviso, schermo principale. App in primo piano: \(app)", "structured": ["screenshot_original_width": width, "screenshot_original_height": height, "display": "main"]]
        }
        guard AXIsProcessTrusted() else { throw Failure(message: "Consenti Accessibilità nelle impostazioni Computer Use; poi premi Controlla di nuovo") }
        switch tool {
        case "click":
            let at = try point(args)
            let button = args["button"] as? String ?? "left"
            guard ["left", "right", "middle"].contains(button) else { throw Failure(message: "Pulsante del mouse non valido") }
            let count = args["count"] == nil ? 1 : try integer(args, "count", 1...2)
            let cgButton: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
            let down: CGEventType = button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
            let up: CGEventType = button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
            for n in 1...count {
                try checkCancellation()
                try mouse(down, at, cgButton, count: n)
                try mouse(up, at, cgButton, count: n)
                if n < count { usleep(80_000) }
            }
        case "drag":
            let from = try point(args, "from_x", "from_y"), to = try point(args, "to_x", "to_y")
            try mouse(.leftMouseDown, from)
            var last = from
            defer { try? mouse(.leftMouseUp, last) }
            for i in 1...20 {
                try checkCancellation()
                last = CGPoint(x: from.x + (to.x - from.x) * Double(i) / 20, y: from.y + (to.y - from.y) * Double(i) / 20)
                try mouse(.leftMouseDragged, last)
                usleep(12_000)
            }
        case "scroll":
            guard let direction = args["direction"] as? String, ["up", "down", "left", "right"].contains(direction)
            else { throw Failure(message: "Direzione dello scorrimento non valida") }
            let amount = try integer(args, "amount", 1...50)
            if args["x"] != nil || args["y"] != nil { try mouse(.mouseMoved, point(args)) }
            let vertical = direction == "up" ? amount : direction == "down" ? -amount : 0
            let horizontal = direction == "left" ? amount : direction == "right" ? -amount : 0
            guard let event = CGEvent(scrollWheelEvent2Source: try source(), units: .line, wheelCount: 2, wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0)
            else { throw Failure(message: "Impossibile creare un evento di scorrimento") }
            event.post(tap: .cghidEventTap)
        case "type_text":
            guard let text = args["text"] as? String, !text.isEmpty, text.utf16.count <= 2000
            else { throw Failure(message: "Il testo deve contenere da 1 a 2000 caratteri") }
            // Unicode events preserve the clipboard and work with Italian and emoji text.
            var units: [UniChar] = []
            func send() throws {
                try checkCancellation()
                try keyEvent(0, down: true, flags: [], unicode: units)
                try keyEvent(0, down: false, flags: [], unicode: units)
                units.removeAll(keepingCapacity: true)
            }
            for scalar in text.unicodeScalars {
                let next = Array(scalar.utf16)
                if units.count + next.count > 16 { try send() }
                units.append(contentsOf: next)
            }
            if !units.isEmpty { try send() }
        case "press_key", "hotkey":
            let keys = tool == "hotkey" ? (args["keys"] as? [String] ?? []) : [args["key"] as? String ?? ""]
            let (code, flags) = try combo(keys)
            try keyEvent(code, down: true, flags: flags)
            // No delay or cancellation boundary between key-down and key-up.
            try keyEvent(code, down: false, flags: flags)
        case "launch_app":
            if let urls = args["urls"] as? [String] {
                guard urls.count == 1, let raw = urls.first, raw.utf8.count <= 2000,
                      let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                      url.host != nil, url.user == nil, url.password == nil, NSWorkspace.shared.open(url)
                else { throw Failure(message: "Indirizzo web non valido o impossibile da aprire") }
            } else {
                guard let name = args["name"] as? String, name.range(of: #"^[\w .+-]{1,60}$"#, options: .regularExpression) != nil
                else { throw Failure(message: "Nome dell'applicazione non valido") }
                // Resolve names as application bundles, never commands or arbitrary files.
                guard let path = NSWorkspace.shared.fullPath(forApplication: name), path.hasSuffix(".app")
                else { throw Failure(message: "Applicazione non trovata sul Mac: \(name)") }
                let configuration = NSWorkspace.OpenConfiguration()
                _ = try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration)
            }
        default: throw Failure(message: "Operazione Computer Use non disponibile")
        }
        return ["text": "Operazione completata sul Mac condiviso"]
    }

    @MainActor static func main() async {
        signal(SIGTERM) { _ in cancelled = 1 }
        signal(SIGINT) { _ in cancelled = 1 }
        var response: [String: Any]
        do {
            if CommandLine.arguments.dropFirst() == ["--self-test"] {
                // Pure validation only. This deliberately never captures or sends an event.
                guard try integer(["n": 12], "n", 1...50) == 12,
                      try combo(["super", "a"]).1.contains(.maskCommand),
                      try combo(["ctrl", "Return"]).0 == 36 else { throw Failure(message: "self-test failed") }
                do { _ = try integer(["n": true], "n", 0...1); throw Failure(message: "boolean accepted") }
                catch let e as Failure where e.message == "boolean accepted" { throw e }
                catch {}
                do { _ = try combo(["invalid", "a"]); throw Failure(message: "modifier accepted") }
                catch let e as Failure where e.message == "modifier accepted" { throw e }
                catch {}
                response = ["ok": true, "selfTest": true]
            } else {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 32768,
                      let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tool = request["tool"] as? String, let args = request["args"] as? [String: Any]
                else { throw Failure(message: "Richiesta Computer Use non valida") }
                response = try await run(tool, args)
                response["ok"] = true
            }
        } catch let failure as Failure { response = ["ok": false, "error": failure.message] }
        catch { response = ["ok": false, "error": "Il componente Computer Use non ha completato l'operazione: \(error.localizedDescription.prefix(250))"] }
        if let output = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) { FileHandle.standardOutput.write(output) }
    }
}
