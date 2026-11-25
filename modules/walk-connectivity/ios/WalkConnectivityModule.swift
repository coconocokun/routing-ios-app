import ExpoModulesCore
import Foundation
import OSLog
import UIKit
import WatchConnectivity

public final class WalkConnectivityModule: Module {
    public func definition() -> ModuleDefinition {
        Name("WalkConnectivity")

        Function("status") { () -> [String: Bool] in
            let supported = WCSession.isSupported()
            let session = supported ? WCSession.default : nil
            let active = session?.activationState == .activated
            return [
                "supported": supported,
                "activated": active,
                "paired": active && session?.isPaired == true,
                "installed": active && session?.isWatchAppInstalled == true,
                "reachable": active && session?.isReachable == true
            ]
        }

        AsyncFunction("inbox") { () -> [[String: String]] in
            try WatchSession.shared.inbox()
        }

        AsyncFunction("remove") { (key: String) in
            try WatchSession.shared.remove(key)
        }

        AsyncFunction("send") { (json: String, durable: Bool) -> Bool in
            WatchSession.shared.send(json, durable: durable)
        }

        AsyncFunction("probe") { (json: String, promise: Promise) in
            WatchSession.shared.probe(json, promise: promise)
        }
    }
}

public final class WalkConnectivitySubscriber: ExpoAppDelegateSubscriber {
    public func application(_ application: UIApplication,
                            didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        WatchSession.shared.activate()
        return true
    }
}

private final class WatchSession: NSObject, WCSessionDelegate {
    static let shared = WatchSession()

    private let logger = Logger(subsystem: "org.walkingstudy.phone", category: "WatchConnectivity")
    private let inboxQueue = DispatchQueue(label: "org.walkingstudy.phone.watch-inbox")

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    private var activeSession: WCSession? {
        guard WCSession.isSupported() else { return nil }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return nil }
        return session
    }

    func send(_ json: String, durable: Bool) -> Bool {
        guard let session = activeSession else { return false }
        let message = ["envelope": json]
        var queued = false
        #if !targetEnvironment(simulator)
        if durable {
            session.transferUserInfo(message)
            queued = true
        }
        #endif
        guard session.isReachable else { return queued }
        session.sendMessage(message, replyHandler: nil) { [logger] error in
            logger.error("Could not send Watch message: \(error.localizedDescription)")
        }
        return true
    }

    func probe(_ json: String, promise: Promise) {
        guard let session = activeSession, session.isReachable else {
            promise.resolve(0)
            return
        }
        session.sendMessage(["envelope": json]) { reply in
            promise.resolve(reply["watch_time_ms"] as? Double ?? 0)
        } errorHandler: { error in
            promise.reject(error)
        }
    }

    private func inboxDirectory() throws -> URL {
        let files = FileManager.default
        let support = try files.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
        let directory = support.appendingPathComponent("WatchInbox", isDirectory: true)
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    func inbox() throws -> [[String: String]] {
        try inboxQueue.sync {
            let files = try FileManager.default.contentsOfDirectory(at: inboxDirectory(),
                includingPropertiesForKeys: [.creationDateKey], options: .skipsHiddenFiles)
            let entries = try files.filter { $0.pathExtension == "json" }.map { file in
                let date = try file.resourceValues(forKeys: [.creationDateKey]).creationDate ?? .distantPast
                return (file: file, date: date)
            }
            return try entries.sorted { $0.date < $1.date }.map { entry in
                ["key": entry.file.deletingPathExtension().lastPathComponent,
                 "json": try String(contentsOf: entry.file, encoding: .utf8)]
            }
        }
    }

    func remove(_ key: String) throws {
        guard let id = UUID(uuidString: key) else { return }
        try inboxQueue.sync {
            let file = try inboxDirectory().appendingPathComponent("\(id.uuidString).json")
            do {
                try FileManager.default.removeItem(at: file)
            } catch let error as CocoaError where error.code == .fileNoSuchFile {
                // A previously removed entry is already acknowledged.
            }
        }
    }

    private func save(_ message: [String: Any]) {
        guard let json = message["envelope"] as? String, json.utf8.count <= 100_000 else { return }
        do {
            try inboxQueue.sync {
                let file = try inboxDirectory().appendingPathComponent("\(UUID().uuidString).json")
                try Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        } catch {
            logger.error("Could not save Watch message: \(error.localizedDescription)")
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error {
            logger.error("Could not activate Watch session: \(error.localizedDescription)")
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        save(userInfo)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        save(message)
    }
}
