import Foundation

@main
enum HudKeyPolicyChecks {
    static func main() {
        func event(_ code: Int, down: Bool = true, repeatKey: Bool = false,
                   option: Bool = false, shift: Bool = false, control: Bool = false,
                   command: Bool = false, type: UInt32 = 14, subtype: Int = 8) -> HudMediaKey? {
            HudMediaKey.decode(type: type, subtype: subtype,
                data1: (code << 16) | ((down ? 0x0a : 0x0b) << 8) | (repeatKey ? 1 : 0),
                option: option, shift: shift, control: control, command: command)
        }
        func check(_ value: @autoclosure () -> Bool, _ message: String) {
            guard value() else { fatalError(message) }
        }
        for code in [0, 1, 2, 3, 7] { check(event(code) != nil, "Allowed media key must decode") }
        for code in [4, 6, 16, 17, 18, 21, 22, 23, 255] { check(event(code) == nil, "Other keys must pass through") }
        check(event(0, type: 10) == nil, "Ordinary keyboard events must never be processed")
        check(event(0, subtype: 1) == nil, "Other system-defined subtypes must pass through")
        check(event(0, option: true) == nil, "Option opens system settings normally")
        check(event(0, command: true) == nil && event(0, control: true) == nil, "Other system shortcuts pass through")
        check(event(0)!.adjusted(0.5) == 0.5625, "Normal step is exactly 1/16")
        check(event(3, option: true, shift: true)!.adjusted(0.5) == 0.484375, "Fine step is exactly 1/64")
        check(event(0)!.adjusted(1) == 1 && event(1)!.adjusted(0) == 0, "Endpoints remain controllable")

        var owner = HudKeyOwnership()
        var writes = 0
        check(!owner.handle(event(0, down: false)!) { writes += 1; return true }, "Unowned key-up must pass")
        check(!owner.handle(event(0, repeatKey: true)!) { writes += 1; return true }, "Unowned repeat must pass")
        check(writes == 0, "Unowned release/repeat must not change any value")
        check(!owner.handle(event(0)!) { writes += 1; return false }, "Failed initial write must pass")
        check(!owner.handle(event(0, down: false)!) { true }, "Failed initial write must not capture release")
        check(owner.handle(event(0)!) { writes += 1; return true }, "Successful initial write owns key")
        check(owner.handle(event(0, repeatKey: true)!) { writes += 1; return true }, "Long press must adjust repeatedly")
        check(owner.handle(event(0, down: false, option: true)!) { writes += 100; return true }, "Release stays paired after modifiers change")
        check(writes == 3, "Releases must not adjust")
        check(!owner.handle(event(0, down: false)!) { true }, "Duplicate release must pass")

        check(owner.handle(event(7)!) { writes += 1; return true }, "Mute first press toggles")
        for _ in 0..<8 { check(owner.handle(event(7, repeatKey: true)!) { writes += 1; return true }, "Mute repeat remains owned") }
        check(writes == 4, "Mute repeat must never toggle again")
        check(owner.handle(event(7, down: false)!) { false }, "Mute release is paired")
        check(owner.handle(event(7)!) { writes += 1; return true }, "A new mute press can toggle again")
        owner.reset()
        check(!owner.handle(event(7, down: false)!) { true }, "Disable clears ownership immediately")

        check(owner.handle(event(2)!) { true }, "Brightness initial success")
        check(!owner.handle(event(2, repeatKey: true)!) { false }, "Driver failure during hold restores system handling")
        check(!owner.handle(event(2, down: false)!) { true }, "Release after failure passes through")

        var operations: [String] = []
        let unmuteFailed = performHudMainVolumeChange(needsUnmute: true,
            unmute: { operations.append("unmute"); return false },
            writeMainVolume: { operations.append("volume"); return true },
            restoreMute: { operations.append("restore") })
        check(!unmuteFailed && operations == ["unmute"], "Failed unmute must not write volume or report success")
        operations = []
        let volumeFailed = performHudMainVolumeChange(needsUnmute: true,
            unmute: { operations.append("unmute"); return true },
            writeMainVolume: { operations.append("volume"); return false },
            restoreMute: { operations.append("restore") })
        check(!volumeFailed && operations == ["unmute", "volume", "restore"], "Failed master write restores mute without trying another volume write")
        operations = []
        let unmutedSuccess = performHudMainVolumeChange(needsUnmute: true,
            unmute: { operations.append("unmute"); return true },
            writeMainVolume: { operations.append("volume"); return true },
            restoreMute: { operations.append("restore") })
        check(unmutedSuccess && operations == ["unmute", "volume"], "Both required operations must acknowledge success")
        operations = []
        let volumeSuccess = performHudMainVolumeChange(needsUnmute: false,
            unmute: { operations.append("unmute"); return false },
            writeMainVolume: { operations.append("volume"); return true },
            restoreMute: { operations.append("restore") })
        check(volumeSuccess && operations == ["volume"], "Unmuted output uses exactly one master write")
        print("hud-key-policy: passed")
    }
}
