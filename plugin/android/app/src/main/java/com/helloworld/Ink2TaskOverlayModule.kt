package com.helloworld

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.UiThreadUtil

/**
 * Floating sync-progress bubble for the on-page SYNC button.
 *
 * WHY THIS EXISTS: an on-page sync takes ~18s and shows nothing while it runs,
 * so the device looks frozen. The JS SDK can't help -- showPluginView() takes no
 * arguments and only ever opens FULLSCREEN, which is more disruptive than the
 * wait it would cover (tried and reverted). The only way to paint something
 * small while the plugin view is closed is a system overlay window, which needs
 * native code.
 *
 * ⚠️ THE BUBBLE IS DELIBERATELY NON-INTERACTIVE.
 * FLAG_NOT_TOUCHABLE + FLAG_NOT_FOCUSABLE mean it can never receive or swallow
 * a touch: pen and finger input pass straight through to the note underneath.
 * This is a progress indicator, not a control, so it gives up nothing -- and it
 * removes an entire class of risk on a device whose whole purpose is writing.
 * v1.0.5 already cost us the on-page button's taps once; an overlay that could
 * eat input would be far worse. Do NOT add FLAG_WATCH_OUTSIDE_TOUCH or make
 * this tappable without a very good reason.
 *
 * Permission: SYSTEM_ALERT_WINDOW belongs to the process we run in --
 * com.ratta.supernote.pluginhost -- NOT to this APK, which is never installed
 * as an app. Declaring it in our own manifest governs nothing (and appears to
 * have caused the v1.0.5 regression), so show() checks canDrawOverlays() at
 * call time and fails soft when it isn't held.
 *
 * Every entry point is best-effort: a progress indicator must never be able to
 * fail a sync.
 */
class Ink2TaskOverlayModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "Ink2TaskOverlay"

    /** The live bubble, or null when nothing is on screen. UI thread only. */
    private var bubble: TextView? = null

    private val windowManager: WindowManager?
        get() =
            reactContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager

    // ---------------------------------------------------------------- probe --

    /**
     * Everything Phase 1 needs in ONE round-trip, since getting a build onto
     * this device is a manual upload plus a reinstall.
     */
    @ReactMethod
    fun diagnostics(promise: Promise) {
        try {
            val map: WritableMap = Arguments.createMap()
            // Whose permission are we actually reading? Expected to be
            // com.ratta.supernote.pluginhost, NOT com.helloworld.
            map.putString("packageName", reactContext.packageName)
            map.putInt("sdkInt", Build.VERSION.SDK_INT)
            map.putString("deviceModel", Build.MODEL ?: "")
            map.putBoolean("canDrawOverlays", Settings.canDrawOverlays(reactContext))
            // NOTE: this only proves the system HAS an overlay-settings screen
            // -- it resolves to Settings regardless of package -- so it is weak
            // evidence that the permission is actually grantable to the host.
            // canDrawOverlays above is the authoritative answer.
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + reactContext.packageName),
            )
            map.putBoolean(
                "canRequestPermission",
                intent.resolveActivity(reactContext.packageManager) != null,
            )
            promise.resolve(map)
        } catch (e: Throwable) {
            promise.reject("DIAGNOSTICS_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun requestPermission(promise: Promise) {
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + reactContext.packageName),
            )
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val ctx: Context = reactContext.currentActivity ?: reactContext
            ctx.startActivity(intent)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("REQUEST_FAILED", e.message, e)
        }
    }

    // --------------------------------------------------------------- bubble --

    /**
     * Shows the bubble, or updates its text if already showing.
     * Resolves false (never rejects) when the overlay permission isn't held, so
     * callers can treat "no bubble" as normal rather than an error.
     */
    @ReactMethod
    fun show(text: String, promise: Promise) {
        if (!Settings.canDrawOverlays(reactContext)) {
            promise.resolve(false)
            return
        }
        UiThreadUtil.runOnUiThread {
            try {
                val existing = bubble
                if (existing != null) {
                    existing.text = text
                } else {
                    val view = buildBubble(text)
                    windowManager?.addView(view, buildLayoutParams())
                    bubble = view
                }
                promise.resolve(true)
            } catch (e: Throwable) {
                // Most likely the host lost the permission between the check
                // and the add. Never fail the sync over a progress indicator.
                bubble = null
                promise.resolve(false)
            }
        }
    }

    /** Updates the text without recreating the window. No-op if not showing. */
    @ReactMethod
    fun updateText(text: String, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                bubble?.text = text
                promise.resolve(bubble != null)
            } catch (e: Throwable) {
                promise.resolve(false)
            }
        }
    }

    /** Removes the bubble. Safe to call when nothing is showing. */
    @ReactMethod
    fun hide(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                bubble?.let { windowManager?.removeView(it) }
            } catch (e: Throwable) {
                // already gone, or the window was torn down under us
            } finally {
                bubble = null
                promise.resolve(true)
            }
        }
    }

    /**
     * Last-resort cleanup. If the plugin is torn down mid-sync the bubble would
     * otherwise stay painted on screen with nothing left to remove it -- a
     * stuck artifact the user can only clear by rebooting.
     */
    override fun invalidate() {
        UiThreadUtil.runOnUiThread {
            try {
                bubble?.let { windowManager?.removeView(it) }
            } catch (e: Throwable) {
                // nothing we can do at teardown
            } finally {
                bubble = null
            }
        }
        super.invalidate()
    }

    // ---------------------------------------------------------------- views --

    /** High-contrast box: e-ink has no color and poor contrast at low weights. */
    private fun buildBubble(text: String): TextView {
        val density = reactContext.resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        return TextView(reactContext).apply {
            this.text = text
            setTextColor(Color.BLACK)
            textSize = 16f
            setPadding(dp(14), dp(10), dp(14), dp(10))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                setStroke(dp(2), Color.BLACK)
                cornerRadius = dp(8).toFloat()
            }
        }
    }

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        val density = reactContext.resources.displayMetrics.density
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // NOT_TOUCHABLE: input passes through to the note underneath.
            // NOT_FOCUSABLE: never takes focus or steals the keyboard.
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            // Bottom-centre, clear of the SYNC button (top-left) and of the
            // checklist rows, so it never covers what the user is reading.
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = (48 * density).toInt()
        }
    }
}
