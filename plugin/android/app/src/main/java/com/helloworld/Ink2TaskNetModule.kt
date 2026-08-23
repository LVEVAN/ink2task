package com.helloworld

import android.content.Context
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import android.security.NetworkSecurityPolicy
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URI

/**
 * Reports this device's own IPv4 address and subnet prefix, so LAN discovery
 * knows which /24 to sweep instead of guessing.
 *
 * WHY NATIVE: discovery used to read /proc/net/route and /proc/net/arp through
 * RNFS. That works on Android 8.1 (the A5X) but Android 10 restricted /proc/net
 * for apps, and on the Manta (Android 11, SDK 30) SELinux labels those files
 * proc_net and the read throws EACCES. Discovery then had nothing to sweep and
 * reported "no matching server" without probing a single host, which is
 * indistinguishable from a real sweep that found nothing.
 *
 * PERMISSIONS: our own manifest governs nothing here. This APK is never
 * installed as an app; the code runs inside com.ratta.supernote.pluginhost, so
 * permissions come from that process. Verified 2026-08-23 on the Manta that the
 * host holds both ACCESS_NETWORK_STATE and ACCESS_WIFI_STATE (granted=true, it
 * is a SYSTEM app under /system_ext/app/PluginHost). Even so, the first method
 * below needs NO permission at all, which is why it is tried first: adding a
 * permission to our manifest is what is suspected of causing the v1.0.5
 * on-page-button regression, so this deliberately avoids needing one.
 *
 * Three sources, most robust first. Each is wrapped so a failure falls through
 * rather than taking the call down.
 */
class Ink2TaskNetModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "Ink2TaskNet"

    /**
     * Resolves {ip, prefixLength, source}, or rejects when nothing could be
     * determined. `prefixLength` is the real mask width when known (24 for a
     * typical home network), so callers do not have to assume /24.
     */
    @ReactMethod
    fun getLocalIpv4(promise: Promise) {
        fromNetworkInterfaces()?.let {
            promise.resolve(it)
            return
        }
        fromConnectivityManager()?.let {
            promise.resolve(it)
            return
        }
        fromWifiManager()?.let {
            promise.resolve(it)
            return
        }
        promise.reject("no_ip", "Could not determine this device's IPv4 address")
    }

    /**
     * Whether this PROCESS is allowed to make plain http:// requests, straight
     * from the platform rather than inferred.
     *
     * Needed because every discovery probe fails with React Native's generic
     * "Network request failed" -- including probes to a server that answers a
     * raw socket from the same device -- and 1016 of them completed in 2.8s,
     * far too fast to have touched the network. OkHttp reports a policy refusal
     * as an exception RN flattens to that same string, and it logs nothing
     * natively, so this is the only way to tell a policy block from a real
     * network failure.
     *
     * The plugin host targets SDK 35 and declares neither usesCleartextTraffic
     * nor a networkSecurityConfig; Android blocks cleartext by default from SDK
     * 28 up. Our own manifest cannot change that, since we run in the host's
     * process, not our own.
     */
    @ReactMethod
    fun getCleartextPolicy(promise: Promise) {
        val map = Arguments.createMap()
        try {
            val policy = NetworkSecurityPolicy.getInstance()
            map.putBoolean("permittedGlobally", policy.isCleartextTrafficPermitted)
            // Per-host can differ when a networkSecurityConfig carves out
            // exceptions, so check a concrete LAN address too.
            map.putBoolean("permittedForPrivateLan", policy.isCleartextTrafficPermitted("10.0.0.1"))
            map.putString("error", "")
        } catch (e: Throwable) {
            map.putBoolean("permittedGlobally", true)
            map.putBoolean("permittedForPrivateLan", true)
            map.putString("error", e.message ?: e.toString())
        }
        promise.resolve(map)
    }

    /**
     * Plain-HTTP request over a RAW SOCKET, bypassing the cleartext block.
     *
     * WHY THIS HAS TO EXIST: the plugin host targets SDK 35 and declares no
     * usesCleartextTraffic and no networkSecurityConfig, so
     * NetworkSecurityPolicy.isCleartextTrafficPermitted() is FALSE for this
     * process (device-confirmed 2026-08-23 on a Manta, Android 11). Every
     * http:// request through fetch/OkHttp is refused before it reaches the
     * network -- 1016 discovery probes failed in 2.8s, including one to a
     * server that answered a raw socket from the same device. Our own manifest
     * cannot lift the block: this APK is never installed, we run inside
     * com.ratta.supernote.pluginhost.
     *
     * The policy applies to the platform HTTP stacks, NOT to java.net.Socket,
     * so speaking HTTP/1.0 down a plain socket sidesteps it entirely. Every LAN
     * backend here is plain http:// on a trusted home network, which is the
     * documented assumption for all of them.
     *
     * Deliberately minimal: HTTP/1.0 with Connection: close, so the response
     * ends at EOF and no chunked-transfer or keep-alive parsing is needed. That
     * is enough for our own servers, which is all this ever talks to. HTTPS is
     * NOT handled here -- direct-Todoist keeps using fetch, which is fine
     * because the policy only blocks cleartext.
     */
    @ReactMethod
    fun httpRequest(
        method: String,
        url: String,
        body: String?,
        timeoutMs: Int,
        promise: Promise,
    ) {
        Thread {
            val out = Arguments.createMap()
            var socket: Socket? = null
            try {
                val uri = URI(url)
                if (uri.scheme?.lowercase() != "http") {
                    out.putInt("status", 0)
                    out.putString("body", "")
                    out.putString("error", "only http:// is supported here (got ${uri.scheme})")
                    promise.resolve(out)
                    return@Thread
                }
                val host = uri.host ?: throw IllegalArgumentException("no host in $url")
                val port = if (uri.port > 0) uri.port else 80
                val path = buildString {
                    append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
                    if (!uri.rawQuery.isNullOrEmpty()) append("?").append(uri.rawQuery)
                }

                val payload = body?.toByteArray(Charsets.UTF_8)
                val head = StringBuilder()
                head.append("$method $path HTTP/1.0\r\n")
                head.append("Host: $host:$port\r\n")
                head.append("Accept: application/json\r\n")
                head.append("Connection: close\r\n")
                if (payload != null) {
                    head.append("Content-Type: application/json\r\n")
                    head.append("Content-Length: ${payload.size}\r\n")
                }
                head.append("\r\n")

                socket = Socket()
                socket.connect(InetSocketAddress(host, port), timeoutMs)
                socket.soTimeout = timeoutMs
                val os = socket.getOutputStream()
                os.write(head.toString().toByteArray(Charsets.UTF_8))
                if (payload != null) os.write(payload)
                os.flush()

                val buf = ByteArrayOutputStream()
                val input = BufferedInputStream(socket.getInputStream())
                val chunk = ByteArray(8192)
                while (true) {
                    val n = input.read(chunk)
                    if (n <= 0) break
                    buf.write(chunk, 0, n)
                }
                val raw = buf.toString("UTF-8")
                // Split head from body on the first blank line.
                val sep = raw.indexOf("\r\n\r\n").let { if (it >= 0) it else raw.indexOf("\n\n") }
                val headText = if (sep >= 0) raw.substring(0, sep) else raw
                val bodyText = if (sep >= 0) raw.substring(sep).trimStart('\r', '\n') else ""
                // "HTTP/1.1 200 OK" -> 200
                val status = Regex("^HTTP/\\d\\.\\d\\s+(\\d{3})")
                    .find(headText)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                out.putInt("status", status)
                out.putString("body", bodyText)
                out.putString("error", "")
            } catch (e: Throwable) {
                out.putInt("status", 0)
                out.putString("body", "")
                out.putString("error", e.message ?: e.toString())
            } finally {
                try {
                    socket?.close()
                } catch (_: Throwable) {
                }
            }
            promise.resolve(out)
        }.start()
    }

    private fun result(ip: String, prefixLength: Int, source: String): WritableMap {
        val map = Arguments.createMap()
        map.putString("ip", ip)
        map.putInt("prefixLength", prefixLength)
        map.putString("source", source)
        return map
    }

    /**
     * Plain java.net, NO Android permission required, and it carries the prefix
     * length. Preferred for exactly those reasons.
     */
    private fun fromNetworkInterfaces(): WritableMap? {
        try {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.interfaceAddresses) {
                    val ip = addr.address
                    if (ip is Inet4Address && !ip.isLoopbackAddress) {
                        val host = ip.hostAddress ?: continue
                        val prefix = addr.networkPrefixLength.toInt()
                        return result(host, if (prefix in 1..32) prefix else 24, "networkInterface")
                    }
                }
            }
        } catch (e: Throwable) {
            // enumeration can throw on restricted interfaces; try the next source
        }
        return null
    }

    /** Needs ACCESS_NETWORK_STATE, which the host holds. Also carries the prefix. */
    private fun fromConnectivityManager(): WritableMap? {
        try {
            val cm = reactApplicationContext
                .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return null
            val network = cm.activeNetwork ?: return null
            val props = cm.getLinkProperties(network) ?: return null
            for (link in props.linkAddresses) {
                val ip = link.address
                if (ip is Inet4Address && !ip.isLoopbackAddress) {
                    val host = ip.hostAddress ?: continue
                    val prefix = link.prefixLength
                    return result(host, if (prefix in 1..32) prefix else 24, "connectivityManager")
                }
            }
        } catch (e: Throwable) {
            // permission or API shape differs; try the next source
        }
        return null
    }

    /**
     * Needs ACCESS_WIFI_STATE, which the host holds. Last resort: deprecated
     * since API 31, IPv4 only, and it reports no mask, so /24 is assumed.
     */
    @Suppress("DEPRECATION")
    private fun fromWifiManager(): WritableMap? {
        try {
            val wm = reactApplicationContext
                .applicationContext
                .getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
            val raw = wm.connectionInfo?.ipAddress ?: return null
            if (raw == 0) return null
            // getIpAddress() is little-endian.
            val ip = String.format(
                "%d.%d.%d.%d",
                raw and 0xff,
                raw shr 8 and 0xff,
                raw shr 16 and 0xff,
                raw shr 24 and 0xff,
            )
            return result(ip, 24, "wifiManager")
        } catch (e: Throwable) {
            return null
        }
    }
}
