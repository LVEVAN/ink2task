import Foundation

/// Best-effort LAN IPv4 address lookup, purely to print a helpful startup
/// message ("put this address into Ink2Task's settings"). Not used for
/// anything functional -- the server itself binds to all interfaces.
enum LocalNetwork {
    static func likelyLANAddress() -> String? {
        var address: String?
        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrPtr) == 0, let firstAddr = ifaddrPtr else { return nil }
        defer { freeifaddrs(ifaddrPtr) }

        var pointer: UnsafeMutablePointer<ifaddrs>? = firstAddr
        while let ifa = pointer {
            defer { pointer = ifa.pointee.ifa_next }
            let flags = Int32(ifa.pointee.ifa_flags)
            guard (flags & IFF_UP) == IFF_UP, (flags & IFF_LOOPBACK) == 0 else { continue }
            guard let addr = ifa.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }

            let name = String(cString: ifa.pointee.ifa_name)
            // en0 is Wi-Fi on almost every Mac; prefer it, but fall back to
            // whatever else is up in case someone's on Ethernet.
            var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(addr, socklen_t(addr.pointee.sa_len), &hostBuffer, socklen_t(hostBuffer.count), nil, 0, NI_NUMERICHOST)
            let host = String(cString: hostBuffer)

            if name == "en0" {
                return host
            }
            if address == nil {
                address = host
            }
        }
        return address
    }
}
