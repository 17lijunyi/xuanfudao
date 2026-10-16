import CoreGraphics
import Foundation

// Inspect only the test window; do not read any window titles or user content.
guard CommandLine.arguments.count == 2, let windowID = UInt32(CommandLine.arguments[1]),
      let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
      let window = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID }),
      let layer = window[kCGWindowLayer as String] as? NSNumber else { exit(1) }
print(layer.intValue)
