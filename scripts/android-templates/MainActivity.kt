package __PACKAGE__

import android.app.PictureInPictureParams
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Rational
import android.webkit.WebView
import android.view.OrientationEventListener
import android.view.Surface
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.annotation.RequiresApi
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {
  companion object {
    /** True while the webview has a live remote session (set over JNI by the
     *  Rust `set_pip_enabled` command via [setPipWanted]) — leaving the app
     *  then shrinks it into a floating 16:9 mini window (YouTube/AnyDesk
     *  style) instead of plain backgrounding. */
    @JvmField var pipWanted = false
    private var pipWidth = 16
    private var pipHeight = 9
    private var pipAspectRevision = 0L
    @JvmField var rotationHoldMs = 1200L
    @JvmField var remoteRotationActive = false
    private var lastRotationRequest = 0L
    private var current: WeakReference<MainActivity>? = null

    /** JNI entry point: flips the gate AND refreshes the live activity's PiP
     *  params, so Android 12+'s auto-enter (the SEAMLESS system-animated
     *  transition on the home gesture) engages/disengages immediately. */
    @JvmStatic
    fun setPipWanted(enabled: Boolean) {
      pipWanted = enabled
      val act = current?.get() ?: return
      act.runOnUiThread { act.updatePipParams() }
    }
    @JvmStatic @Synchronized
    fun setPipAspect(width: Int, height: Int, revision: Long) {
      if (revision <= pipAspectRevision || width < 1 || height < 1) return
      pipAspectRevision = revision
      pipWidth = width.coerceAtMost(65536)
      pipHeight = height.coerceAtMost(65536)
      val act = current?.get() ?: return
      act.runOnUiThread { act.updatePipParams() }
    }
    @JvmStatic
    fun setRotationHoldMs(value: Long) {
      rotationHoldMs = RemoteRotationPolicy.validDelay(value)
      val act = current?.get() ?: return
      act.runOnUiThread { act.applyRemoteRotation() }
    }
    /** One ordered transaction for scope + preference. JNI work can complete in
     * a different order from React effects, so retired updates are ignored. */
    @JvmStatic @Synchronized
    fun setRemoteRotation(active: Boolean, value: Long, revision: Long) {
      if (revision <= lastRotationRequest) return
      lastRotationRequest = revision
      remoteRotationActive = active
      rotationHoldMs = RemoteRotationPolicy.validDelay(value)
      val act = current?.get() ?: return
      act.runOnUiThread {
        if (revision == lastRotationRequest) act.applyRemoteRotation()
      }
    }
  }

  private var appWebView: WebView? = null
  private var imeVisible = false
  private var lastImeBottom = -1
  private val rotationPolicy = RemoteRotationPolicy()
  private lateinit var orientationListener: OrientationEventListener

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    current = WeakReference(this)
    // MediaCodec → Surface under the WebView (Moonlight/Chiaki-style
    // low-latency decode). JavascriptInterface + SurfaceView live in
    // WcDecoderBridge; frames arrive from cloud.ts via __GT_DECODER__.
    WcDecoderBridge.attach(this)
    // Only Remote owns the sensor policy. Saved state restores both the locked
    // physical orientation and the preceding non-Remote requested policy.
    if (savedInstanceState?.containsKey("remote.rotation.active") == true) {
      rotationPolicy.restore(
        savedInstanceState.getBoolean("remote.rotation.active"),
        savedInstanceState.getLong("remote.rotation.delay", 1200L),
        savedInstanceState.getInt("remote.rotation.previous", ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED),
        savedInstanceState.getInt("remote.rotation.locked", ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
      )
      requestedOrientation = rotationPolicy.recreatedOrientation(savedInstanceState.getInt("remote.rotation.requested", ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED))
      // On process recreation desired static state has not been rehydrated yet.
      if (lastRotationRequest == 0L) {
        remoteRotationActive = rotationPolicy.active()
        rotationHoldMs = rotationPolicy.holdMs()
      }
    }
    applyRemoteRotation()
    orientationListener = object : OrientationEventListener(this) {
      override fun onOrientationChanged(angle: Int) {
        if (angle == ORIENTATION_UNKNOWN) { rotationPolicy.clearCandidate(); return }
        // A narrow 25-degree cardinal window rejects shaky transition angles.
        val next = when {
          angle >= 335 || angle <= 25 -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
          angle in 65..115 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
          angle in 155..205 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
          angle in 245..295 -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
          else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
        val requested = rotationPolicy.sensor(next, SystemClock.elapsedRealtime(), isInPictureInPictureMode)
        if (requested != RemoteRotationPolicy.KEEP && requestedOrientation != requested) requestedOrientation = requested
      }
    }
    if (orientationListener.canDetectOrientation()) orientationListener.enable()
    hideSystemBars()
    updatePipParams()
    // Keyboard must SHRINK the webview, never pan the window. With
    // enableEdgeToEdge + hidden system bars the IME default degrades to
    // adjustPan (fullscreen windows are exempt from adjustResize), which
    // slides the whole surface up — the top of the remote viewport leaves
    // the screen and JS cannot even see it (visualViewport doesn't change
    // when the WINDOW moves). Requesting ADJUST_RESIZE plus applying the
    // ime inset as bottom padding makes the content view physically
    // shrink, so the page lays out inside the visible band like any
    // normal resize.
    @Suppress("DEPRECATION")
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      if (ime.bottom != lastImeBottom) {
        lastImeBottom = ime.bottom
        v.setPadding(0, 0, 0, ime.bottom)
      }
      insets
    }
  }

  @Suppress("DEPRECATION")
  private fun physicalOrientation(): Int {
    val rotation = windowManager.defaultDisplay.rotation
    val swapped = rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270
    val naturalLandscape = (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) != swapped
    return if (naturalLandscape) when (rotation) {
      Surface.ROTATION_90 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
      Surface.ROTATION_180 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
      Surface.ROTATION_270 -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      else -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    } else when (rotation) {
      Surface.ROTATION_90 -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
      Surface.ROTATION_180 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
      Surface.ROTATION_270 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
      else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }
  }

  private fun applyRemoteRotation() {
    val requested = rotationPolicy.configure(remoteRotationActive, rotationHoldMs, requestedOrientation, physicalOrientation())
    if (requested != RemoteRotationPolicy.KEEP && requestedOrientation != requested) requestedOrientation = requested
  }

  override fun onSaveInstanceState(outState: Bundle) {
    outState.putBoolean("remote.rotation.active", rotationPolicy.active())
    outState.putLong("remote.rotation.delay", rotationPolicy.holdMs())
    outState.putInt("remote.rotation.previous", rotationPolicy.previousPolicy())
    outState.putInt("remote.rotation.locked", rotationPolicy.lockedOrientation())
    outState.putInt("remote.rotation.requested", requestedOrientation)
    super.onSaveInstanceState(outState)
  }

  /** Tauri fires this when the WebView is constructed, BEFORE it loads the
   *  app URL — the only correct moment to inject a JavascriptInterface.
   *  Android exposes injected objects to JS only on the NEXT page load, so
   *  binding __GT_DECODER__ any later (it used to happen in the bridge's
   *  init(), when a DIRECT session starts) leaves it undefined for the whole
   *  session: MediaCodec is never fed and the screen stays blank while the
   *  phone re-requests keyframes forever. */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    WcDecoderBridge.installJsInterface(webView)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Re-hide after the bars are transiently shown (keyboard, app resume).
    if (hasFocus && !imeVisible) hideSystemBars()
  }

  /** Does this device actually have PiP? (Go/TV/OEM builds may not.) NOTE: no
   *  SDK_INT check in here — lint can't see version guards through a helper,
   *  so every caller does its own inline check and minSdk 24 stays buildable. */
  private fun hasPipFeature(): Boolean =
    packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  /** Shared 16:9 params. `sourceRectHint` tells the OS which on-screen rect
   *  morphs into the mini window — without it the system falls back to a
   *  content overlay and the shrink looks like a cross-fade rather than the
   *  seamless YouTube move. */
  @RequiresApi(Build.VERSION_CODES.O)
  private fun pipParams(autoEnter: Boolean): PictureInPictureParams {
    // Android's ordinary PiP range is 1/2.39 .. 2.39. Tall/wide displays
    // letterbox within that range; the content itself keeps its true aspect.
    val ratio = pipWidth.toDouble() / pipHeight
    val aspect = when {ratio < 1.0 / 2.39 -> Rational(100,239);ratio > 2.39 -> Rational(239,100);else -> Rational(pipWidth,pipHeight)}
    val b = PictureInPictureParams.Builder().setAspectRatio(aspect)
    try {
      val rect = Rect()
      window.decorView.getGlobalVisibleRect(rect)
      if (!rect.isEmpty) b.setSourceRectHint(rect)
    } catch (_: Exception) {
      // No layout yet — the OS just uses its default animation.
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      b.setAutoEnterEnabled(autoEnter)
      b.setSeamlessResizeEnabled(false)
    }
    return b.build()
  }

  /** Android 12+: arm auto-enter so the OS runs the shrink itself on the home
   *  gesture. Params must be FRESH when the user leaves (the OS reads the last
   *  snapshot), so this is re-applied when the gate flips and on resume. */
  fun updatePipParams() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (!hasPipFeature()) return
    try {
      setPictureInPictureParams(pipParams(pipWanted))
    } catch (_: Exception) {
      // PiP unavailable (device/settings) — the leave-hint path below still tries.
    }
  }

  override fun onResume() {
    super.onResume()
    applyRemoteRotation()
    // Re-arm on every resume: auto-enter reads the most recent params, and a
    // stale snapshot (set once at onCreate, before the session went live) is a
    // documented way for auto-enter to quietly do nothing.
    updatePipParams()
  }

  // WryActivity.onPause() calls WebView.onPause(), which stops the page
  // painting and marks it hidden. In picture-in-picture the activity is
  // paused but ON SCREEN, so the mini window froze on the last full-screen
  // frame: the top bar stayed up, the video layer kept its full-screen
  // rect (a sliver of picture over black) and nothing updated. Keep the
  // WebView live while pinned; a real background (onStop) still pauses it.
  override fun onPause() {
    super.onPause()
    if (isInPictureInPictureMode) appWebView?.onResume()
  }

  override fun onStop() {
    super.onStop()
    appWebView?.onPause()
  }

  // Home / recents while connected → floating 16:9 mini window.
  //
  // This runs on ALL API >= O, including 12+ where setAutoEnterEnabled is
  // supposed to make it unnecessary. That is deliberate: auto-enter silently
  // no-ops on a number of OEM builds (b/245392106 "Inconsistent
  // setAutoEnterEnabled behavior"), and gating this to pre-S left those devices
  // with NO picture-in-picture at all and no fallback. Google's wording is that
  // with auto-enter you "don't need to" call this — not that you must not.
  // The isInPictureInPictureMode guard makes the redundant call a no-op when
  // auto-enter did fire first.
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    // Inline SDK check (not folded into hasPipFeature) so lint's NewApi can
    // see it — minSdk is 24 and the PiP APIs below are 26.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (!pipWanted || !hasPipFeature()) return
    if (isInPictureInPictureMode) return
    try {
      enterPictureInPictureMode(pipParams(pipWanted))
    } catch (_: Exception) {
      // PiP unavailable (device/settings) — plain backgrounding is fine.
    }
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    // Entering PiP can land after onPause — keep the page painting here too.
    if (isInPictureInPictureMode) appWebView?.onResume()
    val active = if (isInPictureInPictureMode) "true" else "false"
    appWebView?.evaluateJavascript("window.__GT_PIP_ACTIVE__=" + active + ";window.dispatchEvent(new CustomEvent('gt:pip',{detail:{active:" + active + "}}));", null)
    if (!isInPictureInPictureMode) hideSystemBars()
  }

  override fun onDestroy() {
    if (::orientationListener.isInitialized) orientationListener.disable()
    appWebView = null
    super.onDestroy()
  }

  private fun hideSystemBars() {
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.hide(WindowInsetsCompat.Type.systemBars())
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
  }
}
