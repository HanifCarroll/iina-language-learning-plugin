import Foundation
import Darwin

private let maxRequestBytes = 128 * 1024
private let maxEventBytes = 64 * 1024
private let maxAnswerBytes = 64 * 1024

private let outputLock = NSLock()
private var cleanupDirectory: String?
private func emit(_ line: String) {
  outputLock.lock()
  let bytes = Array((line + "\n").utf8)
  bytes.withUnsafeBytes { raw in
    guard let base = raw.baseAddress else { return }
    var offset = 0
    while offset < raw.count {
      let count = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), raw.count - offset)
      if count > 0 { offset += count }
      else if errno != EINTR { break }
    }
  }
  outputLock.unlock()
}

private func fail(_ reason: String) -> Never {
  emit("ERROR \(reason)")
  if let directory = cleanupDirectory {
    unlink(directory + "/request")
    unlink(directory + "/control")
    rmdir(directory)
  }
  exit(1)
}

private final class ControlState: @unchecked Sendable {
  private let lock = NSLock()
  private var stream: Stream?
  private var pendingStop: String?

  func stop(_ reason: String) {
    lock.lock()
    if let stream { stream.cancel(reason) }
    else { pendingStop = reason }
    lock.unlock()
  }

  func attach(_ stream: Stream) -> String? {
    lock.lock()
    self.stream = stream
    let stopped = pendingStop
    lock.unlock()
    return stopped
  }
}

private func endpointIsAllowed(_ url: URL) -> Bool {
  guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
        let scheme = parts.scheme?.lowercased(),
        let host = parts.host?.lowercased(), !host.isEmpty,
        parts.user == nil, parts.password == nil, parts.fragment == nil,
        !parts.path.isEmpty else { return false }
  if scheme == "https" { return true }
  return scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)
}

private func sameOrigin(_ a: URL, _ b: URL) -> Bool {
  guard let x = URLComponents(url: a, resolvingAgainstBaseURL: false),
        let y = URLComponents(url: b, resolvingAgainstBaseURL: false) else { return false }
  return x.scheme?.lowercased() == y.scheme?.lowercased()
    && x.host?.lowercased() == y.host?.lowercased()
    && (x.port ?? (x.scheme == "https" ? 443 : 80)) == (y.port ?? (y.scheme == "https" ? 443 : 80))
}

private func timeout(_ value: Any?, defaultMs: Int) -> TimeInterval {
  guard let number = value as? Int, number >= 100, number <= defaultMs else {
    return Double(defaultMs) / 1000
  }
  return Double(number) / 1000
}

private final class Stream: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  let endpoint: URL
  let firstByteTimeout: TimeInterval
  let idleTimeout: TimeInterval
  let totalTimeout: TimeInterval
  let finished = DispatchSemaphore(value: 0)
  let lock = NSLock()
  var task: URLSessionDataTask?
  var session: URLSession?
  var started = Date()
  var lastByte: Date?
  var sawDone = false
  var stopped = false
  var reason: String?
  var pending = Data()
  var eventLines: [String] = []
  var answerBytes = 0

  init(endpoint: URL, timeouts: [String: Any]) {
    self.endpoint = endpoint
    firstByteTimeout = timeout(timeouts["firstByteMs"], defaultMs: 20_000)
    idleTimeout = timeout(timeouts["idleMs"], defaultMs: 30_000)
    totalTimeout = timeout(timeouts["totalMs"], defaultMs: 120_000)
  }

  func cancel(_ why: String) {
    lock.lock()
    if reason == nil { reason = why }
    let active = task
    lock.unlock()
    active?.cancel()
  }

  func start(_ request: URLRequest) {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    started = Date()
    let created = session!.dataTask(with: request)
    lock.lock(); task = created; let alreadyStopped = reason != nil; lock.unlock()
    if alreadyStopped { created.cancel() }
    else { created.resume() }
  }

  func checkTimeouts() {
    lock.lock()
    let begun = started
    let latest = lastByte
    let ended = stopped
    lock.unlock()
    if ended { return }
    let now = Date()
    if now.timeIntervalSince(begun) >= totalTimeout { cancel("total_timeout") }
    else if let latest, now.timeIntervalSince(latest) >= idleTimeout { cancel("idle_timeout") }
    else if latest == nil && now.timeIntervalSince(begun) >= firstByteTimeout { cancel("first_byte_timeout") }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    guard let next = request.url, endpointIsAllowed(next), sameOrigin(endpoint, next) else {
      lock.lock(); reason = "redirect_blocked"; lock.unlock()
      completionHandler(nil)
      task.cancel()
      return
    }
    completionHandler(request)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      lock.lock(); reason = "http_\(status)"; lock.unlock()
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock(); lastByte = Date(); lock.unlock()
    pending.append(data)
    if pending.count > maxEventBytes { cancel("event_too_large"); return }
    while let newline = pending.firstIndex(of: 10) {
      var line = pending.prefix(upTo: newline)
      pending.removeSubrange(...newline)
      if line.last == 13 { line = line.dropLast() }
      guard let text = String(data: line, encoding: .utf8) else {
        cancel("invalid_utf8"); return
      }
      if text.isEmpty {
        processEvent()
      } else if text.hasPrefix("data:") {
        eventLines.append(String(text.dropFirst(5)).trimmingCharacters(in: .whitespaces))
      }
      if eventLines.joined(separator: "\n").utf8.count > maxEventBytes {
        cancel("event_too_large"); return
      }
    }
  }

  private func processEvent() {
    defer { eventLines.removeAll(keepingCapacity: true) }
    guard !eventLines.isEmpty else { return }
    let payload = eventLines.joined(separator: "\n")
    if payload == "[DONE]" {
      sawDone = true
      task?.cancel()
      return
    }
    guard let data = payload.data(using: .utf8),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let choices = root["choices"] as? [[String: Any]],
          let first = choices.first,
          let delta = first["delta"] as? [String: Any] else {
      cancel("invalid_sse"); return
    }
    guard let content = delta["content"] as? String else { return }
    let bytes = Data(content.utf8)
    answerBytes += bytes.count
    if answerBytes > maxAnswerBytes { cancel("answer_too_large"); return }
    if !bytes.isEmpty { emit("DELTA \(bytes.base64EncodedString())") }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock(); stopped = true; let why = reason; lock.unlock()
    if let why {
      if why == "stop" || why == "control_closed" || why == "parent_exit" {
        emit("CANCELLED \(why)")
      } else {
        emit("ERROR \(why)")
      }
    } else if sawDone {
      emit("DONE")
    } else {
      emit("ERROR interrupted")
    }
    finished.signal()
  }
}

private func run() {
  signal(SIGPIPE, SIG_IGN)
  guard CommandLine.arguments.count == 2 else { fail("arguments") }
  let directory = CommandLine.arguments[1]
  do {
    try FileManager.default.createDirectory(atPath: directory,
      withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  } catch { fail("directory") }
  cleanupDirectory = directory
  let requestPath = directory + "/request"
  let controlPath = directory + "/control"
  defer {
    unlink(requestPath)
    unlink(controlPath)
    rmdir(directory)
  }
  guard mkfifo(requestPath, 0o600) == 0, mkfifo(controlPath, 0o600) == 0 else {
    fail("pipe")
  }

  let parent = getppid()
  let control = ControlState()
  DispatchQueue.global().async {
    let fd = open(controlPath, O_RDONLY)
    guard fd >= 0 else { return }
    defer { close(fd) }
    var bytes = [UInt8](repeating: 0, count: 64)
    let count = read(fd, &bytes, bytes.count)
    control.stop(count > 0 ? "stop" : "control_closed")
  }
  emit("READY")
  let fd = open(requestPath, O_RDONLY)
  guard fd >= 0 else { fail("request_open") }
  var requestData = Data()
  var buffer = [UInt8](repeating: 0, count: 8192)
  while true {
    let count = read(fd, &buffer, buffer.count)
    if count <= 0 { break }
    requestData.append(contentsOf: buffer.prefix(count))
    if requestData.count > maxRequestBytes { close(fd); fail("request_too_large") }
  }
  close(fd)
  guard let root = (try? JSONSerialization.jsonObject(with: requestData)) as? [String: Any],
        let urlText = root["url"] as? String,
        let url = URL(string: urlText), endpointIsAllowed(url),
        let body = root["body"] as? [String: Any],
        JSONSerialization.isValidJSONObject(body),
        body["stream"] as? Bool == true else { fail("request_invalid") }
  let key = root["key"] as? String
  guard key == nil || (!key!.contains("\r") && !key!.contains("\n")) else { fail("key_invalid") }
  guard let bodyData = try? JSONSerialization.data(withJSONObject: body),
        bodyData.count <= maxRequestBytes else { fail("request_invalid") }

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.httpBody = bodyData
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  if let key, !key.isEmpty { request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
  let active = Stream(endpoint: url, timeouts: root["timeouts"] as? [String: Any] ?? [:])
  if let priorStop = control.attach(active) { emit("CANCELLED \(priorStop)"); return }
  active.start(request)

  while active.finished.wait(timeout: .now() + .milliseconds(100)) == .timedOut {
    active.checkTimeouts()
    if getppid() != parent { active.cancel("parent_exit") }
  }
  active.session?.invalidateAndCancel()
}

run()
