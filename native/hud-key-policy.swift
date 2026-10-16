import Foundation

// Pure decoding and ownership policy. No normal keyboard events are subscribed
// to, and no event payloads are written to disk or sent to Electron.
struct HudMediaKey {
    let code: Int
    let pressed: Bool
    let repeated: Bool
    let fine: Bool

    static func decode(type: UInt32, subtype: Int, data1: Int,
                       option: Bool, shift: Bool, control: Bool, command: Bool) -> HudMediaKey? {
        guard type == 14, subtype == 8 else { return nil }
        let bits = UInt32(truncatingIfNeeded: data1)
        let code = Int((bits >> 16) & 0xffff)
        let state = (bits >> 8) & 0xff
        guard [0, 1, 2, 3, 7].contains(code), state == 0x0a || state == 0x0b else { return nil }
        // A modifier may change between down and up. Still release a key that
        // we owned; an unowned key-up is passed through by HudKeyOwnership.
        if state == 0x0a && (control || command || (option && !shift)) { return nil }
        return HudMediaKey(code: code, pressed: state == 0x0a, repeated: bits & 1 != 0, fine: option && shift)
    }

    var kind: String { code == 2 || code == 3 ? "brightness" : "volume" }
    func adjusted(_ value: Float) -> Float {
        let direction: Float = code == 0 || code == 2 ? 1 : -1
        return max(0, min(1, value + direction * (fine ? 1 / 64 : 1 / 16)))
    }
}

struct HudKeyOwnership {
    private var consumed = Set<Int>()

    mutating func handle(_ key: HudMediaKey, apply: () -> Bool) -> Bool {
        if !key.pressed { return consumed.remove(key.code) != nil }
        if key.repeated {
            guard consumed.contains(key.code) else { return false }
            // Holding mute must not repeatedly toggle the output.
            if key.code == 7 { return true }
        }
        guard apply() else {
            consumed.remove(key.code)
            return false
        }
        consumed.insert(key.code)
        return true
    }

    mutating func reset() { consumed.removeAll() }
}

// A media key must never fall back to a series of independent channel writes.
// Clear mute first, so a failed unmute cannot masquerade as a successful volume
// press. If the one main-volume write fails, restore the prior mute state and
// let macOS process the unchanged volume key.
func performHudMainVolumeChange(needsUnmute: Bool, unmute: () -> Bool,
                                writeMainVolume: () -> Bool, restoreMute: () -> Void) -> Bool {
    if needsUnmute && !unmute() { return false }
    guard writeMainVolume() else {
        if needsUnmute { restoreMute() }
        return false
    }
    return true
}
