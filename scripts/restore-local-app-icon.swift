// Local installation maintenance only; run after signing the updated app.
// Usage: swift scripts/restore-local-app-icon.swift <icon.png> <App.app>
import AppKit
import Foundation
let args = CommandLine.arguments
guard args.count == 3, let image = NSImage(contentsOfFile: args[1]),
      FileManager.default.fileExists(atPath: args[2]) else {
    fputs("Usage: restore-local-app-icon.swift <icon.png> <App.app>\n", stderr)
    exit(1)
}
guard NSWorkspace.shared.setIcon(image, forFile: args[2], options: []) else {
    fputs("Could not restore the local application icon.\n", stderr)
    exit(1)
}
print("Restored local application icon: \(args[2])")
