import Foundation
import CoreAudio
import AudioToolbox
import CoreGraphics
import AppKit
import ApplicationServices
import IOKit
import IOKit.graphics
import IOKit.ps
import Darwin

private let protocolVersion = 1
private let errorDomain = NSOSStatusErrorDomain

private func propertyAddress(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

private func audioScalar(_ object: AudioObjectID, _ address: inout AudioObjectPropertyAddress) -> Float32? {
    guard AudioObjectHasProperty(object, &address) else { return nil }
    var value = Float32.zero
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

private func audioUInt32(_ object: AudioObjectID, _ address: inout AudioObjectPropertyAddress) -> UInt32? {
    guard AudioObjectHasProperty(object, &address) else { return nil }
    var value = UInt32.zero
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

private func audioString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = propertyAddress(selector)
    guard AudioObjectHasProperty(object, &address) else { return nil }
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value?.takeUnretainedValue() as String?
}

private func fourCharacterCode(_ value: UInt32) -> String {
    let bytes: [UInt8] = [
        UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
        UInt8((value >> 8) & 0xff), UInt8(value & 0xff),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? String(value)
}

private typealias DisplayServicesGetBrightnessFunction = @convention(c) (
    CGDirectDisplayID, UnsafeMutablePointer<Float>
) -> Int32
private typealias DisplayServicesSetBrightnessFunction = @convention(c) (
    CGDirectDisplayID, Float
) -> Int32

private final class BrightnessAccess {
    private let handle: UnsafeMutableRawPointer?
    private let getFunction: DisplayServicesGetBrightnessFunction?
    private let setFunction: DisplayServicesSetBrightnessFunction?

    init() {
        let framework = "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices"
        handle = dlopen(framework, RTLD_NOW | RTLD_LOCAL)
        if let handle, let symbol = dlsym(handle, "DisplayServicesGetBrightness") {
            getFunction = unsafeBitCast(symbol, to: DisplayServicesGetBrightnessFunction.self)
        } else {
            getFunction = nil
        }
        if let handle, let symbol = dlsym(handle, "DisplayServicesSetBrightness") {
            setFunction = unsafeBitCast(symbol, to: DisplayServicesSetBrightnessFunction.self)
        } else {
            setFunction = nil
        }
    }

    deinit {
        if let handle { dlclose(handle) }
    }

    private func builtInDisplayID() -> CGDirectDisplayID? {
        var count = UInt32.zero
        guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
        var displays = Array(repeating: CGDirectDisplayID.zero, count: Int(count))
        guard CGGetOnlineDisplayList(count, &displays, &count) == .success else { return nil }
        return displays.prefix(Int(count)).first(where: { CGDisplayIsBuiltin($0) != 0 })
    }

    func read() -> [String: Any] {
        guard let (displayID, value) = readLevel() else { return ["ok": false, "error": "brightness_unavailable"] }
        return ["ok": true, "brightness": Int((value * 100).rounded()), "displayId": Int(displayID)]
    }

    func readLevel() -> (CGDirectDisplayID, Float)? {
        guard let displayID = builtInDisplayID(), let getFunction else { return nil }
        var value = Float.zero
        guard getFunction(displayID, &value) == 0, value.isFinite, value >= 0, value <= 1 else {
            return nil
        }
        return (displayID, value)
    }

    func set(percent: Int) -> Bool {
        guard let displayID = builtInDisplayID(), let setFunction else { return false }
        return setFunction(displayID, Float(percent) / 100) == 0
    }

    func adjust(_ key: HudMediaKey) -> Bool {
        guard let (displayID, current) = readLevel(), let setFunction else { return false }
        return setFunction(displayID, key.adjusted(current)) == 0
    }
}

private let audioListener: AudioObjectPropertyListenerProc = {
    _, _, _, context in
    guard let context else { return noErr }
    Unmanaged<SystemStatusHelper>.fromOpaque(context).takeUnretainedValue().scheduleRefresh()
    return noErr
}

private let powerSourceListener: IOPowerSourceCallbackType = { context in
    guard let context else { return }
    Unmanaged<SystemStatusHelper>.fromOpaque(context).takeUnretainedValue().scheduleRefresh()
}

private final class SystemStatusHelper {
    private let stateQueue = DispatchQueue(label: "com.dynamicpanel.system-status.state")
    private let outputQueue = DispatchQueue(label: "com.dynamicpanel.system-status.output")
    private let brightness = BrightnessAccess()
    private var brightnessTimer: DispatchSourceTimer?
    private var reconciliationTimer: DispatchSourceTimer?
    private var batteryRunLoopSource: CFRunLoopSource?
    private var monitoredOutputDevice = AudioDeviceID(kAudioObjectUnknown)
    private var lastSnapshot: [String: Any]?
    private var stopping = false
    private var hudReplacementEnabled = false
    private var hudTap: CFMachPort?
    private var hudTapSource: CFRunLoopSource?
    private var hudError: String?
    private var hudNeedsExplicitRetry = false
    private var hudOwnership = HudKeyOwnership()

    private var context: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }

    func start() {
        registerDefaultOutputListener()
        rebindOutputDeviceListener()
        registerBatteryListener()
        let initial = snapshot()
        stateQueue.sync { lastSnapshot = initial }
        write([
            "type": "ready",
            "protocolVersion": protocolVersion,
            "snapshot": initial,
        ])
        startTimers()
        startInputReader()
    }

    private func startTimers() {
        // DisplayServices does not expose a stable public change callback. Sampling in
        // this already-running helper detects brightness-key changes without spawning
        // a process for every read. Unsupported systems return a capability error.
        let brightnessTimer = DispatchSource.makeTimerSource(queue: stateQueue)
        brightnessTimer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250), leeway: .milliseconds(60))
        brightnessTimer.setEventHandler { [weak self] in self?.refreshIfChanged() }
        brightnessTimer.resume()
        self.brightnessTimer = brightnessTimer

        // Reconcile infrequent/missed driver notifications and newly attached devices.
        let reconciliationTimer = DispatchSource.makeTimerSource(queue: stateQueue)
        reconciliationTimer.schedule(deadline: .now() + .seconds(2), repeating: .seconds(2), leeway: .milliseconds(250))
        reconciliationTimer.setEventHandler { [weak self] in
            self?.reconcileHudReplacement()
            self?.rebindOutputDeviceListener()
            self?.refreshIfChanged()
        }
        reconciliationTimer.resume()
        self.reconciliationTimer = reconciliationTimer
    }

    private func startInputReader() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine(strippingNewline: true) {
                guard let self else { return }
                self.handle(line: line)
                if self.stopping { return }
            }
            self?.shutdown(exitCode: 0)
        }
    }

    func scheduleRefresh() {
        stateQueue.async { [weak self] in
            self?.rebindOutputDeviceListener()
            self?.refreshIfChanged()
        }
    }

    private func refreshIfChanged() {
        guard !stopping else { return }
        let next = snapshot()
        guard let previous = lastSnapshot else {
            lastSnapshot = next
            return
        }
        let changedKeys = ["volume", "brightness", "battery", "output", "hudReplacement"].filter {
            !equalJSON(previous[$0], next[$0])
        }
        lastSnapshot = next
        if !changedKeys.isEmpty {
            write(["type": "change", "changedKeys": changedKeys, "snapshot": next])
        }
    }

    private func equalJSON(_ lhs: Any?, _ rhs: Any?) -> Bool {
        guard let lhs, let rhs else { return lhs == nil && rhs == nil }
        return (lhs as AnyObject).isEqual(rhs)
    }

    private func handle(line: String) {
        guard let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = request["id"] as? String,
              let command = request["command"] as? String else {
            write(["type": "protocolError", "error": "invalid_request"])
            return
        }
        stateQueue.async { [weak self] in
            self?.handle(request: request, id: id, command: command)
        }
    }

    private func handle(request: [String: Any], id: String, command: String) {
        switch command {
        case "setHudReplacement":
            guard let number = request["value"] as? NSNumber,
                  CFGetTypeID(number) == CFBooleanGetTypeID() else {
                write(["type": "response", "id": id, "ok": false, "error": "invalid_hud_replacement"])
                return
            }
            hudReplacementEnabled = number.boolValue
            hudNeedsExplicitRetry = false
            hudError = nil
            reconcileHudReplacement()
            let current = snapshot()
            lastSnapshot = current
            write(["type": "response", "id": id, "ok": true, "snapshot": current,
                   "hudReplacement": current["hudReplacement"]!])
        case "getSnapshot":
            reconcileHudReplacement()
            let current = snapshot()
            lastSnapshot = current
            write(["type": "response", "id": id, "ok": true, "snapshot": current])
        case "setVolume":
            guard let value = validatedPercent(request["value"]) else {
                write(["type": "response", "id": id, "ok": false, "error": "invalid_volume"])
                return
            }
            guard setVolume(value) else {
                write(["type": "response", "id": id, "ok": false, "error": "volume_change_failed"])
                return
            }
            respondAfterWrite(id: id, key: "volume")
        case "setBrightness":
            guard let value = validatedPercent(request["value"]) else {
                write(["type": "response", "id": id, "ok": false, "error": "invalid_brightness"])
                return
            }
            guard brightness.set(percent: value) else {
                write(["type": "response", "id": id, "ok": false, "error": "brightness_change_failed"])
                return
            }
            respondAfterWrite(id: id, key: "brightness")
        case "shutdown":
            write(["type": "response", "id": id, "ok": true])
            shutdown(exitCode: 0)
        default:
            write(["type": "response", "id": id, "ok": false, "error": "invalid_command"])
        }
    }

    private func respondAfterWrite(id: String, key: String) {
        // CoreAudio and DisplayServices can apply asynchronously. A short delay lets
        // the response report the state the system accepted rather than the request.
        stateQueue.asyncAfter(deadline: .now() + .milliseconds(45)) { [weak self] in
            guard let self, !self.stopping else { return }
            let current = self.snapshot()
            let previous = self.lastSnapshot
            self.lastSnapshot = current
            var response: [String: Any] = ["type": "response", "id": id, "ok": true, "snapshot": current]
            response[key] = current[key]
            self.write(response)
            if let previous {
                let changed = ["volume", "brightness", "battery", "output"].filter {
                    !self.equalJSON(previous[$0], current[$0])
                }
                if !changed.isEmpty {
                    self.write(["type": "change", "changedKeys": changed, "snapshot": current])
                }
            }
        }
    }

    private func validatedPercent(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value.rounded() == value, value >= 0, value <= 100 else { return nil }
        return Int(value)
    }

    private func snapshot() -> [String: Any] {
        let output = readOutput()
        return [
            "volume": readVolume(),
            "brightness": brightness.read(),
            "battery": readBattery(),
            "output": output,
            "hudReplacement": hudReplacementSnapshot(),
        ]
    }

    private func hudReplacementSnapshot() -> [String: Any] {
        let trusted = AXIsProcessTrusted()
        var value: [String: Any] = ["enabled": hudReplacementEnabled,
                                  "active": trusted && hudTap.map { CGEvent.tapIsEnabled(tap: $0) } == true,
                                  "permission": trusted ? "granted" : "required"]
        if let hudError { value["error"] = hudError }
        return value
    }

    private func releaseHudTap() {
        if let source = hudTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            CFRunLoopSourceInvalidate(source)
        }
        if let tap = hudTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        hudTapSource = nil
        hudTap = nil
        hudOwnership.reset()
    }

    private func reconcileHudReplacement() {
        guard hudReplacementEnabled, !stopping else { releaseHudTap(); return }
        guard AXIsProcessTrusted() else {
            releaseHudTap()
            hudError = "accessibility_required"
            return
        }
        guard hudTap == nil, !hudNeedsExplicitRetry else { return }
        let callback: CGEventTapCallBack = { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let owner = Unmanaged<SystemStatusHelper>.fromOpaque(context).takeUnretainedValue()
            let consumed = owner.stateQueue.sync { owner.handleMediaKey(type: type, event: event) }
            return consumed ? nil : Unmanaged.passUnretained(event)
        }
        // An active tap requires the existing Accessibility grant. Do not prompt,
        // elevate privileges, or subscribe to ordinary keyDown/keyUp events.
        let mask = CGEventMask(1 << 14)
        let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap,
                                    options: .defaultTap, eventsOfInterest: mask,
                                    callback: callback, userInfo: context)
            ?? CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                 options: .defaultTap, eventsOfInterest: mask,
                                 callback: callback, userInfo: context)
        guard let tap else {
            hudError = "event_tap_unavailable"
            hudNeedsExplicitRetry = true
            return
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            hudError = "event_tap_unavailable"
            hudNeedsExplicitRetry = true
            return
        }
        hudTap = tap
        hudTapSource = source
        hudError = nil
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handleMediaKey(type: CGEventType, event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            releaseHudTap()
            hudError = type == .tapDisabledByTimeout ? "event_tap_timeout" : "event_tap_disabled"
            hudNeedsExplicitRetry = true
            refreshIfChanged()
            return false
        }
        guard !stopping, hudReplacementEnabled, AXIsProcessTrusted() else {
            releaseHudTap()
            return false
        }
        guard type.rawValue == 14, let value = NSEvent(cgEvent: event) else { return false }
        let flags = value.modifierFlags
        guard let key = HudMediaKey.decode(type: type.rawValue, subtype: Int(value.subtype.rawValue), data1: value.data1,
            option: flags.contains(.option), shift: flags.contains(.shift),
            control: flags.contains(.control), command: flags.contains(.command)) else { return false }
        // The ownership decision is made from a synchronous, acknowledged native
        // write. A failed/unsupported key is returned to macOS unchanged.
        var ownership = hudOwnership
        let consumed = ownership.handle(key) { self.applyMediaKey(key) }
        hudOwnership = ownership
        if consumed && key.pressed {
            stateQueue.asyncAfter(deadline: .now() + .milliseconds(45)) { [weak self] in
                guard let self, !self.stopping, self.hudReplacementEnabled else { return }
                let current = self.snapshot()
                self.lastSnapshot = current
                self.write(["type": "feedback", "kind": key.kind, "snapshot": current])
            }
        }
        return consumed
    }

    private func applyMediaKey(_ key: HudMediaKey) -> Bool {
        if key.kind == "brightness" { return brightness.adjust(key) }
        guard let device = defaultOutputDevice() else { return false }
        if key.code == 7 {
            guard let current = readVolumeScalar(device), current.isFinite, current >= 0, current <= 1 else { return false }
            var address = propertyAddress(kAudioDevicePropertyMute, scope: kAudioDevicePropertyScopeOutput)
            guard let currentMute = audioUInt32(device, &address) else { return false }
            var settable = DarwinBoolean(false)
            guard AudioObjectIsPropertySettable(device, &address, &settable) == noErr, settable.boolValue else { return false }
            var value: UInt32 = currentMute == 0 ? 1 : 0
            return AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value) == noErr
        }
        return adjustMainVolume(key, device: device)
    }

    private func adjustMainVolume(_ key: HudMediaKey, device: AudioDeviceID) -> Bool {
        // Validate a single readable/writable master control before changing
        // anything. The UI slider's older per-channel fallback remains separate.
        let selectors = [kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
                         kAudioDevicePropertyVolumeScalar]
        var selected: (AudioObjectPropertyAddress, Float32)?
        for selector in selectors {
            var address = propertyAddress(selector, scope: kAudioDevicePropertyScopeOutput)
            var settable = DarwinBoolean(false)
            guard AudioObjectHasProperty(device, &address),
                  AudioObjectIsPropertySettable(device, &address, &settable) == noErr, settable.boolValue,
                  let value = audioScalar(device, &address), value.isFinite, value >= 0, value <= 1 else { continue }
            selected = (address, value)
            break
        }
        guard let (selectedAddress, current) = selected else { return false }
        var mainAddress = selectedAddress
        var target = key.adjusted(current)
        var muteAddress = propertyAddress(kAudioDevicePropertyMute, scope: kAudioDevicePropertyScopeOutput)
        var previousMute = UInt32.zero
        if AudioObjectHasProperty(device, &muteAddress) {
            guard let value = audioUInt32(device, &muteAddress), value <= 1 else { return false }
            previousMute = value
        }
        let needsUnmute = previousMute != 0 && target > 0
        if needsUnmute {
            var settable = DarwinBoolean(false)
            guard AudioObjectIsPropertySettable(device, &muteAddress, &settable) == noErr, settable.boolValue else { return false }
        }
        return performHudMainVolumeChange(needsUnmute: needsUnmute, unmute: {
            var value = UInt32.zero
            return AudioObjectSetPropertyData(device, &muteAddress, 0, nil,
                UInt32(MemoryLayout<UInt32>.size), &value) == noErr
        }, writeMainVolume: {
            // A failed write is returned directly. Never try another selector
            // or individual channels after the device has seen this operation.
            return AudioObjectSetPropertyData(device, &mainAddress, 0, nil,
                UInt32(MemoryLayout<Float32>.size), &target) == noErr
        }, restoreMute: {
            // Best effort only; regardless of its result, a failed main write
            // never produces a success feedback or consumes the original key.
            _ = AudioObjectSetPropertyData(device, &muteAddress, 0, nil,
                UInt32(MemoryLayout<UInt32>.size), &previousMute)
        })
    }

    private func defaultOutputDevice() -> AudioDeviceID? {
        var address = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let result = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device
        )
        return result == noErr && device != kAudioObjectUnknown ? device : nil
    }

    private func readVolume() -> [String: Any] {
        guard let device = defaultOutputDevice(), let scalar = readVolumeScalar(device) else {
            return ["ok": false, "error": "volume_unavailable"]
        }
        var muteAddress = propertyAddress(kAudioDevicePropertyMute, scope: kAudioDevicePropertyScopeOutput)
        let muteValue = audioUInt32(device, &muteAddress)
        return [
            "ok": true,
            "volume": max(0, min(100, Int((scalar * 100).rounded()))),
            "muted": muteValue.map { $0 != 0 } ?? (scalar <= 0.0001),
        ]
    }

    private func readVolumeScalar(_ device: AudioDeviceID) -> Float32? {
        var main = propertyAddress(
            kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            scope: kAudioDevicePropertyScopeOutput
        )
        if let value = audioScalar(device, &main) { return value }
        // Match the alternate single master control used by media keys, so a
        // successful adjustment can always be reported by the next snapshot.
        var scalarMain = propertyAddress(kAudioDevicePropertyVolumeScalar, scope: kAudioDevicePropertyScopeOutput)
        if let value = audioScalar(device, &scalarMain) { return value }
        var values: [Float32] = []
        for channel in 1...32 {
            var address = propertyAddress(
                kAudioDevicePropertyVolumeScalar,
                scope: kAudioDevicePropertyScopeOutput,
                element: AudioObjectPropertyElement(channel)
            )
            if let value = audioScalar(device, &address) { values.append(value) }
        }
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Float32(values.count)
    }

    private func setVolume(_ percent: Int) -> Bool {
        guard let device = defaultOutputDevice() else { return false }
        return setVolumeScalar(Float32(percent) / 100, device: device)
    }

    private func setVolumeScalar(_ scalar: Float32, device: AudioDeviceID) -> Bool {
        var wrote = false
        var main = propertyAddress(
            kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            scope: kAudioDevicePropertyScopeOutput
        )
        var settable = DarwinBoolean(false)
        if AudioObjectHasProperty(device, &main),
           AudioObjectIsPropertySettable(device, &main, &settable) == noErr, settable.boolValue {
            var value = scalar
            wrote = AudioObjectSetPropertyData(
                device, &main, 0, nil, UInt32(MemoryLayout<Float32>.size), &value
            ) == noErr
        }
        if !wrote {
            var successfulChannels = 0
            for channel in 1...32 {
                var address = propertyAddress(
                    kAudioDevicePropertyVolumeScalar,
                    scope: kAudioDevicePropertyScopeOutput,
                    element: AudioObjectPropertyElement(channel)
                )
                var channelSettable = DarwinBoolean(false)
                guard AudioObjectHasProperty(device, &address),
                      AudioObjectIsPropertySettable(device, &address, &channelSettable) == noErr,
                      channelSettable.boolValue else { continue }
                var value = scalar
                if AudioObjectSetPropertyData(
                    device, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &value
                ) == noErr { successfulChannels += 1 }
            }
            wrote = successfulChannels > 0
        }
        if wrote && scalar > 0 {
            var mute = UInt32.zero
            var muteAddress = propertyAddress(kAudioDevicePropertyMute, scope: kAudioDevicePropertyScopeOutput)
            var settable = DarwinBoolean(false)
            if AudioObjectHasProperty(device, &muteAddress),
               AudioObjectIsPropertySettable(device, &muteAddress, &settable) == noErr, settable.boolValue {
                _ = AudioObjectSetPropertyData(
                    device, &muteAddress, 0, nil, UInt32(MemoryLayout<UInt32>.size), &mute
                )
            }
        }
        return wrote
    }

    private func readOutput() -> [String: Any] {
        guard let device = defaultOutputDevice() else {
            return ["ok": false, "error": "output_unavailable"]
        }
        let name = audioString(device, kAudioObjectPropertyName) ?? ""
        let uid = audioString(device, kAudioDevicePropertyDeviceUID) ?? String(device)
        var transportAddress = propertyAddress(kAudioDevicePropertyTransportType)
        let transport = audioUInt32(device, &transportAddress) ?? 0
        return [
            "ok": true,
            "id": uid,
            "name": name,
            "kind": outputKind(name: name, transport: transport),
        ]
    }

    private func outputKind(name: String, transport: UInt32) -> String {
        let lowered = name.lowercased()
        if ["airpods", "headphone", "headset", "earphone", "耳机", "耳麦", "beats"].contains(where: lowered.contains) {
            return "headphones"
        }
        switch transport {
        case kAudioDeviceTransportTypeBuiltIn: return "speaker"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
        case kAudioDeviceTransportTypeAirPlay: return "airplay"
        case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return "display"
        case kAudioDeviceTransportTypeUSB: return "usb"
        case kAudioDeviceTransportTypeVirtual: return "virtual"
        default: return transport == 0 ? "unknown" : fourCharacterCode(transport)
        }
    }

    private func readBattery() -> [String: Any] {
        let info = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        let sources = IOPSCopyPowerSourcesList(info).takeRetainedValue() as Array
        let onAC = (IOPSGetProvidingPowerSourceType(info).takeUnretainedValue() as String) == kIOPMACPowerKey
        for source in sources {
            guard let description = IOPSGetPowerSourceDescription(info, source).takeUnretainedValue() as? [String: Any],
                  description[kIOPSTypeKey] as? String == kIOPSInternalBatteryType else { continue }
            let current = (description[kIOPSCurrentCapacityKey] as? NSNumber)?.doubleValue ?? -1
            let maximum = (description[kIOPSMaxCapacityKey] as? NSNumber)?.doubleValue ?? -1
            guard current >= 0, maximum > 0 else { continue }
            return [
                "ok": true,
                "percent": max(0, min(100, Int((current / maximum * 100).rounded()))),
                "charging": (description[kIOPSIsChargingKey] as? NSNumber)?.boolValue ?? false,
                "onAC": onAC,
            ]
        }
        return ["ok": false, "error": "battery_unavailable"]
    }

    private func registerDefaultOutputListener() {
        var address = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
        _ = AudioObjectAddPropertyListener(
            AudioObjectID(kAudioObjectSystemObject), &address, audioListener, context
        )
    }

    private func rebindOutputDeviceListener() {
        let current = defaultOutputDevice() ?? AudioDeviceID(kAudioObjectUnknown)
        guard current != monitoredOutputDevice else { return }
        if monitoredOutputDevice != kAudioObjectUnknown { removeOutputDeviceListeners(monitoredOutputDevice) }
        monitoredOutputDevice = current
        if current != kAudioObjectUnknown { addOutputDeviceListeners(current) }
    }

    private func outputDeviceAddresses() -> [AudioObjectPropertyAddress] {
        var addresses = [
            propertyAddress(kAudioHardwareServiceDeviceProperty_VirtualMainVolume, scope: kAudioDevicePropertyScopeOutput),
            propertyAddress(kAudioDevicePropertyMute, scope: kAudioDevicePropertyScopeOutput),
            propertyAddress(kAudioObjectPropertyName),
            propertyAddress(kAudioDevicePropertyDeviceUID),
            propertyAddress(kAudioDevicePropertyTransportType),
        ]
        for channel in 1...32 {
            addresses.append(propertyAddress(
                kAudioDevicePropertyVolumeScalar,
                scope: kAudioDevicePropertyScopeOutput,
                element: AudioObjectPropertyElement(channel)
            ))
        }
        return addresses
    }

    private func addOutputDeviceListeners(_ device: AudioDeviceID) {
        for var address in outputDeviceAddresses() where AudioObjectHasProperty(device, &address) {
            _ = AudioObjectAddPropertyListener(device, &address, audioListener, context)
        }
    }

    private func removeOutputDeviceListeners(_ device: AudioDeviceID) {
        for var address in outputDeviceAddresses() {
            _ = AudioObjectRemovePropertyListener(device, &address, audioListener, context)
        }
    }

    private func registerBatteryListener() {
        guard let retainedSource = IOPSNotificationCreateRunLoopSource(powerSourceListener, context) else { return }
        let source = retainedSource.takeRetainedValue()
        batteryRunLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
    }

    private func unregisterListeners() {
        var defaultAddress = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
        _ = AudioObjectRemovePropertyListener(
            AudioObjectID(kAudioObjectSystemObject), &defaultAddress, audioListener, context
        )
        if monitoredOutputDevice != kAudioObjectUnknown {
            removeOutputDeviceListeners(monitoredOutputDevice)
            monitoredOutputDevice = AudioDeviceID(kAudioObjectUnknown)
        }
        if let batteryRunLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), batteryRunLoopSource, .defaultMode)
            self.batteryRunLoopSource = nil
        }
    }

    private func write(_ object: [String: Any]) {
        outputQueue.async {
            guard JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        }
    }

    private func shutdown(exitCode: Int32) {
        stateQueue.async { [weak self] in
            guard let self, !self.stopping else { return }
            self.stopping = true
            self.releaseHudTap()
            self.brightnessTimer?.cancel()
            self.brightnessTimer = nil
            self.reconciliationTimer?.cancel()
            self.reconciliationTimer = nil
            DispatchQueue.main.async {
                self.unregisterListeners()
                self.outputQueue.sync {}
                exit(exitCode)
            }
        }
    }
}

@main
private enum HelperMain {
    static func main() {
        if CommandLine.arguments.contains("--hud-permission-status") {
            let status: [String: Any] = ["enabled": false, "active": false,
                                       "permission": AXIsProcessTrusted() ? "granted" : "required"]
            if let data = try? JSONSerialization.data(withJSONObject: status, options: [.sortedKeys]) {
                FileHandle.standardOutput.write(data)
                FileHandle.standardOutput.write(Data([0x0a]))
            }
            return
        }
        let helper = SystemStatusHelper()
        helper.start()
        withExtendedLifetime(helper) { RunLoop.main.run() }
    }
}
