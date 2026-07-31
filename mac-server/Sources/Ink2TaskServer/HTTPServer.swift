import Foundation
import Network

struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let body: Data
}

struct HTTPResponse {
    let status: Int
    let body: Data
    let contentType: String

    static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return HTTPResponse(status: status, body: data, contentType: "application/json")
    }

    static func text(_ string: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(status: status, body: Data(string.utf8), contentType: "text/plain")
    }
}

/// Deliberately simple: parses one request per connection, writes one
/// response, closes. No keep-alive, no chunked transfer, no HTTPS -- this
/// only ever talks to one plugin over a trusted home LAN, matching the
/// v1 scope (no "away from home network" support yet).
final class HTTPServer {
    private let port: NWEndpoint.Port
    private let handler: (HTTPRequest) async -> HTTPResponse
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ink2task.http")

    init(port: UInt16, handler: @escaping (HTTPRequest) async -> HTTPResponse) {
        self.port = NWEndpoint.Port(rawValue: port) ?? 8942
        self.handler = handler
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params, on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                print("Listener failed: \(error)")
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        readRequest(on: connection, buffer: Data())
    }

    private func readRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            var buffer = buffer
            if let data = data, !data.isEmpty {
                buffer.append(data)
            }

            if let request = self.parse(buffer) {
                Task {
                    let response = await self.handler(request)
                    self.write(response, to: connection)
                }
                return
            }

            if isComplete || error != nil {
                connection.cancel()
                return
            }

            self.readRequest(on: connection, buffer: buffer)
        }
    }

    /// Returns nil until the full head + (if any) body has arrived.
    private func parse(_ buffer: Data) -> HTTPRequest? {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }

        let headerData = buffer.subdata(in: buffer.startIndex..<headerEnd.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0])
        let fullPath = String(parts[1])

        var contentLength = 0
        for line in lines.dropFirst() {
            if let range = line.range(of: ": ") {
                let key = line[line.startIndex..<range.lowerBound].lowercased()
                let value = line[range.upperBound...]
                if key == "content-length" {
                    contentLength = Int(value) ?? 0
                }
            }
        }

        let bodyStart = headerEnd.upperBound
        let bodyAvailable = buffer.count - bodyStart
        guard bodyAvailable >= contentLength else { return nil } // wait for more data

        let body = buffer.subdata(in: bodyStart..<(bodyStart + contentLength))

        let pathComponents = fullPath.split(separator: "?", maxSplits: 1)
        let path = String(pathComponents[0])
        var query: [String: String] = [:]
        if pathComponents.count > 1 {
            for pair in pathComponents[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                if kv.count == 2 {
                    query[decodeQuery(String(kv[0]))] = decodeQuery(String(kv[1]))
                }
            }
        }

        return HTTPRequest(method: method, path: path, query: query, body: body)
    }

    /// Decodes one query component. Query strings encode a space as either
    /// "%20" or "+", so "+" is turned into a space before percent-decoding --
    /// otherwise a list named "Supernote Inbox" arrives as "Supernote+Inbox".
    private func decodeQuery(_ s: String) -> String {
        let spaced = s.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    private func write(_ response: HTTPResponse, to connection: NWConnection) {
        let statusText = HTTPServer.statusText(response.status)
        var head = "HTTP/1.1 \(response.status) \(statusText)\r\n"
        head += "Content-Type: \(response.contentType); charset=utf-8\r\n"
        head += "Content-Length: \(response.body.count)\r\n"
        head += "Connection: close\r\n\r\n"

        var payload = Data(head.utf8)
        payload.append(response.body)

        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func statusText(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        default: return "Unknown"
        }
    }
}
