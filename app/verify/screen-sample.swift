// Prints the frontmost application and the windows on screen as JSON. Compiled and run by screen-watch.mjs. macOS only.
import AppKit
import CoreGraphics

let front = NSWorkspace.shared.frontmostApplication
var wins: [[String: Any]] = []
if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
  for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    wins.append([
      "owner": w[kCGWindowOwnerName as String] as? String ?? "",
      "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
      "name": w[kCGWindowName as String] as? String ?? "",
      "w": b["Width"] as? Int ?? 0, "h": b["Height"] as? Int ?? 0,
    ])
  }
}
let out: [String: Any] = ["front": front?.localizedName ?? "", "frontPid": Int(front?.processIdentifier ?? 0), "windows": wins]
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
