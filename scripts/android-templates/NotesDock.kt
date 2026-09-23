package __PACKAGE__

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Notes
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.StickyNote2
import androidx.compose.material.icons.automirrored.rounded.ViewSidebar
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.rounded.AddPhotoAlternate
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.DataObject
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.SearchOff
import androidx.compose.material.icons.rounded.Sell
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import java.util.Locale
import kotlinx.coroutines.delay

/**
 * Floating Notes dock — the Compose UI over the shared-clipboard service.
 *
 * ClipboardService (Java) still owns everything that is not pixels: the relay
 * socket, crypto, the content classifier, link-preview fetching, voice capture
 * and the note actions. It implements [NotesDockHost]; this file is only the
 * window and the UI. Split that way so the sync code that has years of
 * do-not-regress rules behind it (AGENTS.md §14) did not have to move.
 *
 * Window model: one full-screen TYPE_APPLICATION_OVERLAY window, attached on
 * open and REMOVED on close (never left attached-but-hidden: an invisible
 * full-screen overlay that still took touches would freeze the phone). The
 * composition itself outlives the window — [ViewCompositionStrategy.
 * DisposeOnLifecycleDestroyed] — so a reopen is an addView plus a recompose,
 * not a rebuild.
 */

/** One note as the dock renders it. Immutable so Compose can skip unchanged rows. */
@Immutable
data class NoteUi(
  val id: String,
  /** "text" or "image". */
  val kind: String,
  val text: String,
  val createdAtMs: Long,
  val pinned: Boolean,
  val tags: List<String>,
  /** link | command | code | json | log | path | text — see ClipboardService.classify. */
  val contentKind: String,
  /** Badge for monospaced kinds ("TypeScript", "Shell", …); null for prose. */
  val contentLabel: String?,
  val mono: Boolean,
  /** Source device ("SENGALPC", "This phone"); empty when unknown. */
  val deviceName: String,
)

@Immutable
data class LinkPreviewUi(
  val title: String,
  val description: String,
  val image: String?,
  val host: String,
  /** True when [image] is real artwork (og:image) rather than a favicon. */
  val hero: Boolean,
)

/** What the dock needs from the service. Every call is main-thread and cheap:
 *  anything slow is a `dockRequest…` that answers later via [NotesDock.invalidate]. */
interface NotesDockHost {
  fun dockNotes(): List<NoteUi>
  fun dockStatusText(): String
  /** 0 = not configured, 1 = synced, 2 = connecting. */
  fun dockStatusTone(): Int
  fun dockThumb(id: String): Bitmap?
  fun dockRequestThumb(id: String)
  fun dockBody(text: String, kind: String): CharSequence
  fun dockLinkFor(text: String): String?
  fun dockLinkPreview(url: String): LinkPreviewUi?
  fun dockRequestLinkPreview(url: String)
  fun dockBitmap(url: String): Bitmap?
  fun dockRequestBitmap(url: String)
  /** 0 idle, 1 listening/recording, 2 transcribing. */
  fun dockMicState(): Int
  fun dockPreviewsOn(): Boolean
  fun dockSetPreviews(on: Boolean)
  fun dockEdgeHandleOn(): Boolean
  fun dockSetEdgeHandle(on: Boolean)
  fun dockPinOnRight(): Boolean
  fun dockFlipSide()
  fun dockDraft(): String
  fun dockSetDraft(text: String)
  fun dockSetTagFilter(tag: String?)
  fun dockAdd(text: String)
  fun dockSaveEdit(id: String, text: String)
  fun dockCopy(id: String)
  fun dockCopyLatest()
  fun dockTogglePin(id: String)
  fun dockShare(id: String)
  fun dockDelete(id: String)
  fun dockToggleTag(id: String, tag: String)
  fun dockPaste()
  fun dockPickImage()
  fun dockReceiveImage(uri: Uri)
  fun dockToggleMic()
  fun dockOpenApp()
  fun dockOpenUrl(url: String)
}

internal class DockUiState {
  /** Bumped (coalesced) whenever the service's data changed. */
  var version by mutableIntStateOf(0)
  var visible by mutableStateOf(false)
  var search by mutableStateOf("")
  var kindFilter by mutableStateOf("")
  var typeFilter by mutableStateOf<String?>(null)
  var tagFilter by mutableStateOf<String?>(null)
  var editingId by mutableStateOf<String?>(null)
  var tagPickerFor by mutableStateOf<String?>(null)
  var pendingDelete by mutableStateOf<String?>(null)
  val expanded = mutableStateMapOf<String, Boolean>()
  var snack by mutableStateOf<DockSnack?>(null)
  var composerHasText by mutableStateOf(false)
  var menuOpen by mutableStateOf(false)
}

internal data class DockSnack(val text: String, val seq: Long)

class NotesDock(service: Context, private val host: NotesDockHost) {
  // Dark Material context: EditText cursor/handles and the floating text
  // toolbar come from the theme, and a Service context has no dark theme.
  private val ctx: Context = ContextThemeWrapper(service, android.R.style.Theme_Material_NoActionBar)
  private val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
  private val main = Handler(Looper.getMainLooper())
  internal val ui = DockUiState()
  private var root: DockRoot? = null
  private var owner: OverlayOwner? = null
  private var attached = false
  private var invalidateQueued = false
  private var composer: EditText? = null
  private var snackSeq = 0L
  private var backCallback: Any? = null

  val isOpen: Boolean
    get() = ui.visible

  /** Any thread. Coalesced to one recompose per ~2 frames, so a relay replay of
   *  300 notices doesn't recompose 300 times. */
  fun invalidate() {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { invalidate() }
      return
    }
    if (invalidateQueued) return
    invalidateQueued = true
    main.postDelayed({
      invalidateQueued = false
      ui.version++
    }, 32)
  }

  /** Build the view tree while the finger is still down on the edge handle. */
  fun prewarm() {
    try {
      ensureView()
    } catch (_: Throwable) {
    }
  }

  fun show(): Boolean {
    val r = try {
      ensureView()
    } catch (_: Throwable) {
      return false
    }
    // visible BEFORE the window attaches: the first composition then starts the
    // enter transition from its hidden state instead of popping in.
    ui.visible = true
    owner?.resume()
    if (!attached) {
      try {
        wm.addView(r, layoutParams())
        attached = true
      } catch (_: Throwable) {
        ui.visible = false
        return false
      }
      registerBack(r)
    }
    ui.version++
    return true
  }

  fun hide() {
    if (!ui.visible) return
    ui.visible = false
    ui.menuOpen = false
    hideIme()
    // The exit transition calls onExitFinished(); this is the net for a
    // composition that never gets the frame to do it.
    main.postDelayed({ if (!ui.visible) detach() }, 650)
  }

  fun toggle() {
    if (ui.visible) hide() else show()
  }

  fun snack(text: String) {
    ui.snack = DockSnack(text, ++snackSeq)
  }

  /** Voice transcript → end of the composer. */
  fun appendToComposer(text: String) {
    val e = composer ?: return
    val cur = e.text.toString()
    e.setText(if (cur.isBlank()) text else "$cur $text")
    e.setSelection(e.text.length)
  }

  fun destroy() {
    detach()
    owner?.destroy()
    owner = null
    root = null
    composer = null
  }

  internal fun onExitFinished() {
    if (!ui.visible) detach()
  }

  internal fun submitComposer() {
    val e = composer ?: return
    val t = e.text.toString().trim()
    if (t.isEmpty()) return
    val editing = ui.editingId
    if (editing != null) {
      host.dockSaveEdit(editing, t)
      ui.editingId = null
      e.setText(host.dockDraft())
      e.setSelection(e.text.length)
      snack("Saved")
    } else {
      host.dockAdd(t)
      e.setText("")
      host.dockSetDraft("")
      snack("Added")
    }
  }

  internal fun startEdit(note: NoteUi) {
    val e = composer ?: return
    ui.editingId = note.id
    ui.tagPickerFor = null
    e.setText(note.text)
    e.setSelection(e.text.length)
    e.requestFocus()
    (ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
      .showSoftInput(e, InputMethodManager.SHOW_IMPLICIT)
  }

  internal fun cancelEdit() {
    ui.editingId = null
    composer?.let {
      it.setText(host.dockDraft())
      it.setSelection(it.text.length)
    }
  }

  internal fun armDeleteTimeout(id: String) {
    main.postDelayed({ if (ui.pendingDelete == id) ui.pendingDelete = null }, 3000)
  }

  internal fun composerView(): EditText {
    composer?.let { existing ->
      (existing.parent as? ViewGroup)?.removeView(existing)
      return existing
    }
    val e = EditText(ctx)
    e.background = null
    e.setPadding(0, 0, 0, 0)
    e.setTextColor(0xFFF1F5F9.toInt())
    e.setHintTextColor(0xFF6B7588.toInt())
    e.hint = "Write a note…"
    e.textSize = 15f
    e.setLineSpacing(0f, 1.12f)
    e.minLines = 1
    e.maxLines = 6
    e.isSingleLine = false
    e.gravity = Gravity.TOP or Gravity.START
    // No auto-capitalisation: half of what lands here is commands, paths and
    // links ("npm run build" must not become "Npm run build" — that also stops
    // the classifier recognising it as a command).
    e.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    e.highlightColor = 0x667C5CFF
    if (Build.VERSION.SDK_INT >= 29) {
      val cursor = GradientDrawable()
      cursor.setColor(0xFF8B74FF.toInt())
      cursor.setSize((2 * ctx.resources.displayMetrics.density).toInt(), 1)
      e.textCursorDrawable = cursor
    }
    // Overlay windows don't inherit an Activity's text setup; keep the field
    // long-clickable so Select / Copy / Paste appear in the floating toolbar.
    e.isLongClickable = true
    val draft = host.dockDraft()
    if (draft.isNotEmpty()) {
      e.setText(draft)
      e.setSelection(e.text.length)
    }
    ui.composerHasText = draft.isNotBlank()
    e.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
      override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
      override fun afterTextChanged(s: Editable?) {
        val text = s?.toString() ?: ""
        ui.composerHasText = text.isNotBlank()
        // Edits are not drafts: the draft slot keeps what you were writing before.
        if (ui.editingId == null) host.dockSetDraft(text)
      }
    })
    // Keyboard image paste (Gboard rich content). Returning null consumes the
    // payload so the EditText doesn't also try to insert it as text.
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        e.setOnReceiveContentListener(arrayOf("image/*")) { _, payload ->
          val clip = payload.clip
          val desc = clip.description
          if (clip.itemCount > 0 && desc != null && desc.hasMimeType("image/*")) {
            val uri = clip.getItemAt(0)?.uri
            if (uri != null) {
              host.dockReceiveImage(uri)
              return@setOnReceiveContentListener null
            }
          }
          payload
        }
      } catch (_: Throwable) {
        // Broken OEM implementation — paste + gallery buttons still work.
      }
    }
    composer = e
    return e
  }

  private fun ensureView(): DockRoot {
    root?.let { return it }
    val o = OverlayOwner()
    o.create()
    owner = o
    val r = DockRoot(ctx) { hide() }
    r.setViewTreeLifecycleOwner(o)
    r.setViewTreeSavedStateRegistryOwner(o)
    val cv = ComposeView(ctx)
    cv.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnLifecycleDestroyed(o))
    cv.setContent { DockContent(this, ui, host) }
    r.addView(cv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    root = r
    return r
  }

  private fun layoutParams(): WindowManager.LayoutParams {
    val type = if (Build.VERSION.SDK_INT >= 26) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val lp = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
      PixelFormat.TRANSLUCENT,
    )
    lp.gravity = Gravity.TOP or Gravity.START
    lp.title = "GameTracker Notes"
    if (Build.VERSION.SDK_INT >= 30) {
      // Take the whole display and let Compose place the sheet inside the
      // system bars / cutout / keyboard (safeDrawing) — the IME then shrinks the
      // sheet smoothly instead of the window being resized under it.
      lp.fitInsetsTypes = 0
      lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    } else {
      @Suppress("DEPRECATION")
      lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
    }
    return lp
  }

  private fun detach() {
    val r = root ?: return
    if (!attached) return
    unregisterBack(r)
    hideIme()
    try {
      wm.removeViewImmediate(r)
    } catch (_: Throwable) {
    }
    attached = false
    owner?.pause()
    ui.tagPickerFor = null
    ui.pendingDelete = null
    ui.menuOpen = false
    if (ui.editingId != null) cancelEdit()
  }

  private fun hideIme() {
    val r = root ?: return
    try {
      (ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
        .hideSoftInputFromWindow(r.windowToken, 0)
    } catch (_: Throwable) {
    }
  }

  /** targetSdk 36 routes Back through OnBackInvokedDispatcher (predictive back),
   *  not KEYCODE_BACK — register there too or Back does nothing on Android 16+. */
  private fun registerBack(r: View) {
    if (Build.VERSION.SDK_INT < 33) return
    try {
      val dispatcher = r.findOnBackInvokedDispatcher() ?: return
      val cb = android.window.OnBackInvokedCallback { hide() }
      dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
      backCallback = cb
    } catch (_: Throwable) {
    }
  }

  private fun unregisterBack(r: View) {
    if (Build.VERSION.SDK_INT < 33) return
    val cb = backCallback as? android.window.OnBackInvokedCallback ?: return
    try {
      r.findOnBackInvokedDispatcher()?.unregisterOnBackInvokedCallback(cb)
    } catch (_: Throwable) {
    }
    backCallback = null
  }
}

/** Window root: swallows Back (pre-predictive-back devices) to close the dock. */
private class DockRoot(ctx: Context, private val onBack: () -> Unit) : FrameLayout(ctx) {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
      if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) onBack()
      return true
    }
    return super.dispatchKeyEvent(event)
  }
}

/** Lifecycle + saved-state for a ComposeView that lives in a Service window. */
private class OverlayOwner : LifecycleOwner, SavedStateRegistryOwner {
  private val registry = LifecycleRegistry(this)
  private val savedState = SavedStateRegistryController.create(this)
  override val lifecycle: Lifecycle
    get() = registry
  override val savedStateRegistry: SavedStateRegistry
    get() = savedState.savedStateRegistry

  fun create() {
    savedState.performAttach()
    savedState.performRestore(null)
    registry.currentState = Lifecycle.State.CREATED
  }

  fun resume() {
    if (registry.currentState != Lifecycle.State.DESTROYED) registry.currentState = Lifecycle.State.RESUMED
  }

  fun pause() {
    if (registry.currentState.isAtLeast(Lifecycle.State.STARTED)) registry.currentState = Lifecycle.State.CREATED
  }

  fun destroy() {
    if (registry.currentState != Lifecycle.State.INITIALIZED) registry.currentState = Lifecycle.State.DESTROYED
  }
}

// ---------------------------------------------------------------------------
// Design tokens — the app's own palette (violet → cyan brand, slate text).
// ---------------------------------------------------------------------------

private object P {
  val sheet = Color(0xF70C101B)
  val card = Color(0x0DFFFFFF)
  val field = Color(0x10FFFFFF)
  val hairline = Color(0x12FFFFFF)
  val violet = Color(0xFF7C5CFF)
  val violetSoft = Color(0xFFA78BFA)
  val cyan = Color(0xFF22D3EE)
  val blue = Color(0xFF38BDF8)
  val green = Color(0xFF34D399)
  val amber = Color(0xFFFBBF24)
  val pink = Color(0xFFFB7185)
  val red = Color(0xFFF87171)
  val text = Color(0xFFF1F5F9)
  val text2 = Color(0xFFA7B0C0)
  val text3 = Color(0xFF6B7588)
  val brand = Brush.linearGradient(listOf(Color(0xFF7C5CFF), Color(0xFF22D3EE)))
}

private val TYPE_ORDER = listOf("link", "code", "json", "log", "command", "path", "text")
private val TYPE_LABELS = mapOf(
  "link" to "Links", "code" to "Code", "json" to "JSON", "log" to "Logs",
  "command" to "Commands", "path" to "Paths", "text" to "Notes",
)

private fun typeIcon(kind: String): ImageVector = when (kind) {
  "link" -> Icons.Rounded.Link
  "code" -> Icons.Rounded.Code
  "json" -> Icons.Rounded.DataObject
  "log" -> Icons.Rounded.WarningAmber
  "command" -> Icons.Rounded.Terminal
  "path" -> Icons.Rounded.FolderOpen
  else -> Icons.AutoMirrored.Rounded.Notes
}

private fun accentFor(kind: String): Color = when (kind) {
  "json" -> P.blue
  "log" -> P.pink
  "command" -> P.green
  "path" -> P.cyan
  else -> P.violet
}

private fun toneColor(tone: Int): Color = when (tone) {
  1 -> P.green
  2 -> P.amber
  else -> P.text3
}

private fun relativeTime(then: Long, now: Long): String {
  val sec = maxOf(0L, (now - then) / 1000)
  if (sec < 45) return "just now"
  if (sec < 90) return "a minute ago"
  val min = sec / 60
  if (min < 45) return "$min min ago"
  if (min < 90) return "an hour ago"
  val hr = min / 60
  if (hr < 24) return "$hr h ago"
  val day = hr / 24
  if (day == 1L) return "yesterday"
  if (day < 7) return "$day days ago"
  val wk = day / 7
  return if (wk == 1L) "a week ago" else "$wk weeks ago"
}

private fun filterNotes(all: List<NoteUi>, q: String, kind: String, type: String?, tag: String?): List<NoteUi> {
  val query = q.trim().lowercase(Locale.US)
  return all.filter { n ->
    (kind.isEmpty() || n.kind == kind) &&
      (type == null || (n.kind == "text" && n.contentKind == type)) &&
      (tag == null || n.tags.any { it.equals(tag, ignoreCase = true) }) &&
      (
        query.isEmpty() ||
          (n.kind == "text" && n.text.lowercase(Locale.US).contains(query)) ||
          n.tags.any { it.lowercase(Locale.US).contains(query) }
        )
  }
}

/** The service's spans (prose marks, token colours, severity) → AnnotatedString,
 *  so rows stay pure Compose (cheap in a LazyColumn) and keep the classifier's
 *  formatting exactly. Links become LinkAnnotations routed through the service
 *  (a Service context can't startActivity without NEW_TASK, which the default
 *  UriHandler doesn't add). */
private fun CharSequence.toAnnotated(onLink: (String) -> Unit): AnnotatedString {
  val s = this
  if (s !is Spanned) return AnnotatedString(s.toString())
  return buildAnnotatedString {
    append(s.toString())
    for (span in s.getSpans(0, s.length, Any::class.java)) {
      val st = s.getSpanStart(span)
      val en = s.getSpanEnd(span)
      if (st < 0 || en <= st) continue
      when (span) {
        is ClipboardService.UrlSpan -> {
          val url = span.url
          addLink(
            LinkAnnotation.Clickable(
              tag = url,
              styles = TextLinkStyles(SpanStyle(color = P.blue, textDecoration = TextDecoration.Underline)),
            ) { onLink(url) },
            st,
            en,
          )
        }
        is ForegroundColorSpan -> addStyle(SpanStyle(color = Color(span.foregroundColor)), st, en)
        is BackgroundColorSpan -> addStyle(SpanStyle(background = Color(span.backgroundColor)), st, en)
        is StyleSpan -> when (span.style) {
          Typeface.BOLD -> addStyle(SpanStyle(fontWeight = FontWeight.SemiBold), st, en)
          Typeface.ITALIC -> addStyle(SpanStyle(fontStyle = FontStyle.Italic), st, en)
          Typeface.BOLD_ITALIC -> addStyle(SpanStyle(fontWeight = FontWeight.SemiBold, fontStyle = FontStyle.Italic), st, en)
        }
        is TypefaceSpan -> if (span.family == "monospace") addStyle(SpanStyle(fontFamily = FontFamily.Monospace), st, en)
        is UnderlineSpan -> addStyle(SpanStyle(textDecoration = TextDecoration.Underline), st, en)
        is StrikethroughSpan -> addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), st, en)
      }
    }
  }
}

private val noRipple = MutableInteractionSource()

@Composable
private fun rememberNow(): State<Long> = produceState(System.currentTimeMillis()) {
  while (true) {
    delay(30_000)
    value = System.currentTimeMillis()
  }
}

// ---------------------------------------------------------------------------
// Root: scrim + sliding sheet
// ---------------------------------------------------------------------------

@Composable
internal fun DockContent(dock: NotesDock, ui: DockUiState, host: NotesDockHost) {
  val onRight = remember(ui.version) { host.dockPinOnRight() }
  val shown = remember { MutableTransitionState(false) }
  LaunchedEffect(ui.visible) { shown.targetState = ui.visible }
  LaunchedEffect(shown.isIdle, shown.currentState) {
    if (shown.isIdle && !shown.currentState && !ui.visible) dock.onExitFinished()
  }
  val transition = rememberTransition(shown, label = "dock")
  val progress by transition.animateFloat(
    transitionSpec = {
      if (targetState) spring(dampingRatio = 0.84f, stiffness = 420f) else tween(170, easing = FastOutLinearInEasing)
    },
    label = "progress",
  ) { if (it) 1f else 0f }

  Box(Modifier.fillMaxSize()) {
    Box(
      Modifier
        .fillMaxSize()
        .graphicsLayer { alpha = progress.coerceIn(0f, 1f) }
        .background(Color(0x99000000))
        .pointerInput(Unit) { detectTapGestures { dock.hide() } },
    )
    BoxWithConstraints(
      Modifier
        .fillMaxSize()
        .windowInsetsPadding(WindowInsets.safeDrawing)
        .padding(8.dp),
    ) {
      val sheetWidth = minOf(maxWidth, 420.dp)
      val travel = with(LocalDensity.current) { (sheetWidth + 24.dp).toPx() }
      DockSheet(
        dock,
        ui,
        host,
        onRight,
        Modifier
          .align(if (onRight) Alignment.CenterEnd else Alignment.CenterStart)
          .width(sheetWidth)
          .fillMaxHeight()
          .graphicsLayer {
            translationX = (1f - progress) * travel * (if (onRight) 1f else -1f)
            alpha = (0.35f + 0.65f * progress).coerceIn(0f, 1f)
          },
      )
    }
  }
}

@Composable
private fun DockSheet(dock: NotesDock, ui: DockUiState, host: NotesDockHost, onRight: Boolean, modifier: Modifier) {
  val shape = RoundedCornerShape(30.dp)
  val notes = remember(ui.version) { host.dockNotes() }
  val tags = remember(notes) {
    notes.asSequence().flatMap { it.tags.asSequence() }.map { it.trim() }.filter { it.isNotEmpty() }
      .distinctBy { it.lowercase(Locale.US) }.sortedWith(String.CASE_INSENSITIVE_ORDER).toList()
  }
  val typeCounts = remember(notes) {
    val counts = HashMap<String, Int>()
    for (n in notes) if (n.kind == "text") counts[n.contentKind] = (counts[n.contentKind] ?: 0) + 1
    TYPE_ORDER.filter { counts.containsKey(it) }.associateWith { counts[it] ?: 0 }
  }
  // A filter left on something that no longer exists would strand an empty list.
  LaunchedEffect(tags) {
    val t = ui.tagFilter
    if (t != null && tags.none { it.equals(t, ignoreCase = true) }) ui.tagFilter = null
  }
  LaunchedEffect(typeCounts) {
    val t = ui.typeFilter
    if (t != null && (!typeCounts.containsKey(t) || typeCounts.size < 2)) ui.typeFilter = null
  }
  LaunchedEffect(ui.tagFilter) { host.dockSetTagFilter(ui.tagFilter) }
  val filtered = remember(notes, ui.search, ui.kindFilter, ui.typeFilter, ui.tagFilter) {
    filterNotes(notes, ui.search, ui.kindFilter, ui.typeFilter, ui.tagFilter)
  }

  Box(
    modifier
      .shadow(28.dp, shape, ambientColor = Color(0x667C5CFF), spotColor = Color.Black)
      .clip(shape)
      .background(P.sheet)
      .border(
        1.dp,
        Brush.linearGradient(listOf(Color(0x807C5CFF), Color(0x3322D3EE), Color(0x0FFFFFFF))),
        shape,
      )
      // Swallow taps that land on the sheet's own background — otherwise they'd
      // fall through to the scrim and close the dock.
      .clickable(interactionSource = noRipple, indication = null) { ui.menuOpen = false },
  ) {
    // Soft brand glow in the corner nearest the edge the dock slid in from.
    Box(
      Modifier
        .fillMaxWidth()
        .height(220.dp)
        .drawBehind {
          drawRect(
            Brush.radialGradient(
              listOf(Color(0x337C5CFF), Color(0x0022D3EE)),
              center = Offset(if (onRight) size.width else 0f, 0f),
              radius = size.width * 0.9f,
            ),
          )
        },
    )
    Column(Modifier.fillMaxSize().padding(horizontal = 14.dp).padding(top = 14.dp)) {
      DockHeader(ui, host) { dock.hide() }
      Spacer(Modifier.height(12.dp))
      Composer(dock, ui, host)
      Spacer(Modifier.height(10.dp))
      SearchField(ui)
      Spacer(Modifier.height(8.dp))
      Segmented(listOf("" to "All", "text" to "Text", "image" to "Images"), ui.kindFilter) { ui.kindFilter = it }
      AnimatedVisibility(tags.isNotEmpty(), enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Column {
          Spacer(Modifier.height(8.dp))
          ChipRow(
            listOf<Pair<String?, String>>(null to "All tags") + tags.map { it to it },
            ui.tagFilter,
            P.violet,
            icon = { t -> if (t != null) Icons.Rounded.Sell else null },
          ) {
            ui.tagFilter = if (it != null && it.equals(ui.tagFilter, ignoreCase = true)) null else it
          }
        }
      }
      AnimatedVisibility(typeCounts.size >= 2, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Column {
          Spacer(Modifier.height(6.dp))
          ChipRow(
            listOf<Pair<String?, String>>(null to "Any type") +
              typeCounts.map { (k, n) -> k to "${TYPE_LABELS[k] ?: k}  $n" },
            ui.typeFilter,
            P.blue,
            icon = { k -> k?.let { typeIcon(it) } },
          ) { ui.typeFilter = if (it == ui.typeFilter) null else it }
        }
      }
      Spacer(Modifier.height(10.dp))
      Box(Modifier.weight(1f).fillMaxWidth()) {
        NotesList(dock, ui, host, notes, filtered)
        TagPicker(ui, host, notes, tags)
        SnackHost(ui, Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp))
      }
    }
    DockMenu(ui, host, onRight, Modifier.align(Alignment.TopEnd).padding(top = 58.dp, end = 12.dp))
  }
}

// ---------------------------------------------------------------------------
// Header + overflow menu
// ---------------------------------------------------------------------------

@Composable
private fun DockHeader(ui: DockUiState, host: NotesDockHost, onClose: () -> Unit) {
  val status = remember(ui.version) { host.dockStatusText() }
  val tone = remember(ui.version) { host.dockStatusTone() }
  Row(verticalAlignment = Alignment.CenterVertically) {
    Box(
      Modifier.size(42.dp).clip(RoundedCornerShape(14.dp)).background(P.brand),
      contentAlignment = Alignment.Center,
    ) {
      Icon(Icons.AutoMirrored.Rounded.StickyNote2, contentDescription = null, tint = Color.White, modifier = Modifier.size(23.dp))
    }
    Spacer(Modifier.width(11.dp))
    Column(Modifier.weight(1f)) {
      Text("Notes", color = P.text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp)
      Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(tone)
        Spacer(Modifier.width(6.dp))
        Text(status, color = toneColor(tone).copy(alpha = 0.95f), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
    HeaderButton(Icons.Rounded.MoreVert, "More", ui.menuOpen) { ui.menuOpen = !ui.menuOpen }
    Spacer(Modifier.width(2.dp))
    HeaderButton(Icons.Rounded.Close, "Close", false, onClose)
  }
}

@Composable
private fun StatusDot(tone: Int) {
  val color = toneColor(tone)
  if (tone == 2) {
    val pulse = rememberInfiniteTransition(label = "pulse")
    val a by pulse.animateFloat(0.3f, 1f, infiniteRepeatable(tween(800), RepeatMode.Reverse), label = "a")
    Box(Modifier.size(8.dp).graphicsLayer { alpha = a }.clip(CircleShape).background(color))
  } else {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
  }
}

@Composable
private fun HeaderButton(icon: ImageVector, label: String, active: Boolean, onClick: () -> Unit) {
  val bg by animateColorAsState(if (active) Color(0x297C5CFF) else Color(0x0DFFFFFF), label = "hb")
  Box(
    Modifier.size(38.dp).clip(CircleShape).background(bg).clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Icon(icon, contentDescription = label, tint = if (active) P.violetSoft else P.text2, modifier = Modifier.size(20.dp))
  }
}

@Composable
private fun DockMenu(ui: DockUiState, host: NotesDockHost, onRight: Boolean, modifier: Modifier) {
  val previews = remember(ui.version) { host.dockPreviewsOn() }
  val edge = remember(ui.version) { host.dockEdgeHandleOn() }
  AnimatedVisibility(
    ui.menuOpen,
    modifier = modifier,
    enter = fadeIn(tween(120)) + scaleIn(initialScale = 0.9f, transformOrigin = androidx.compose.ui.graphics.TransformOrigin(1f, 0f)),
    exit = fadeOut(tween(100)) + scaleOut(targetScale = 0.9f, transformOrigin = androidx.compose.ui.graphics.TransformOrigin(1f, 0f)),
  ) {
    Column(
      Modifier
        .width(236.dp)
        .shadow(18.dp, RoundedCornerShape(20.dp))
        .clip(RoundedCornerShape(20.dp))
        .background(Color(0xFF161B2B))
        .border(1.dp, P.hairline, RoundedCornerShape(20.dp))
        .clickable(interactionSource = noRipple, indication = null) {}
        .padding(vertical = 6.dp),
    ) {
      MenuSwitch(Icons.Rounded.Link, "Link previews", previews) { host.dockSetPreviews(!previews) }
      MenuSwitch(Icons.AutoMirrored.Rounded.ViewSidebar, "Edge handle", edge) { host.dockSetEdgeHandle(!edge) }
      MenuItem(Icons.Rounded.SwapHoriz, if (onRight) "Move to left edge" else "Move to right edge") {
        ui.menuOpen = false
        host.dockFlipSide()
      }
      MenuItem(Icons.Rounded.ContentCopy, "Copy latest note") {
        ui.menuOpen = false
        host.dockCopyLatest()
      }
      MenuItem(Icons.AutoMirrored.Rounded.OpenInNew, "Open GameTracker") {
        ui.menuOpen = false
        host.dockOpenApp()
      }
    }
  }
}

@Composable
private fun MenuItem(icon: ImageVector, label: String, onClick: () -> Unit) {
  Row(
    Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 11.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(icon, contentDescription = null, tint = P.text2, modifier = Modifier.size(19.dp))
    Spacer(Modifier.width(12.dp))
    Text(label, color = P.text, fontSize = 14.sp)
  }
}

@Composable
private fun MenuSwitch(icon: ImageVector, label: String, on: Boolean, onToggle: () -> Unit) {
  Row(
    Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(start = 14.dp, end = 10.dp, top = 4.dp, bottom = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(icon, contentDescription = null, tint = P.text2, modifier = Modifier.size(19.dp))
    Spacer(Modifier.width(12.dp))
    Text(label, color = P.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
    Switch(
      checked = on,
      onCheckedChange = { onToggle() },
      colors = SwitchDefaults.colors(
        checkedThumbColor = Color.White,
        checkedTrackColor = P.violet,
        uncheckedThumbColor = P.text2,
        uncheckedTrackColor = Color(0x1AFFFFFF),
        uncheckedBorderColor = Color.Transparent,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

@Composable
private fun Composer(dock: NotesDock, ui: DockUiState, host: NotesDockHost) {
  val editing = ui.editingId != null
  val mic = remember(ui.version) { host.dockMicState() }
  val shape = RoundedCornerShape(22.dp)
  val border by animateColorAsState(if (editing) Color(0x997C5CFF) else Color(0x0FFFFFFF), label = "cb")
  Column(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .background(P.field)
      .border(1.dp, border, shape)
      .padding(start = 14.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
  ) {
    AnimatedVisibility(editing, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
      Row(Modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Edit, contentDescription = null, tint = P.violetSoft, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text("Editing note", color = P.violetSoft, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
        Text(
          "Cancel",
          color = P.text2,
          fontSize = 12.sp,
          fontWeight = FontWeight.Medium,
          modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { dock.cancelEdit() }.padding(horizontal = 8.dp, vertical = 2.dp),
        )
      }
    }
    AndroidView(
      factory = { dock.composerView() },
      modifier = Modifier.fillMaxWidth().padding(end = 6.dp).heightIn(min = 22.dp),
    )
    Spacer(Modifier.height(10.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      ToolButton(Icons.Rounded.ContentPaste, "Paste from clipboard") { host.dockPaste() }
      Spacer(Modifier.width(4.dp))
      ToolButton(Icons.Rounded.AddPhotoAlternate, "Add image") { host.dockPickImage() }
      Spacer(Modifier.width(4.dp))
      MicButton(mic) { host.dockToggleMic() }
      Spacer(Modifier.weight(1f))
      SendButton(ui.composerHasText, if (editing) "Save" else "Add") { dock.submitComposer() }
    }
  }
}

@Composable
private fun ToolButton(icon: ImageVector, label: String, onClick: () -> Unit) {
  Box(
    Modifier.size(36.dp).clip(CircleShape).background(Color(0x0FFFFFFF)).clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Icon(icon, contentDescription = label, tint = P.text2, modifier = Modifier.size(19.dp))
  }
}

@Composable
private fun MicButton(state: Int, onClick: () -> Unit) {
  val live = state == 1
  val bg by animateColorAsState(if (live) Color(0x33FB7185) else Color(0x0FFFFFFF), label = "mic")
  Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) {
    if (live) {
      val pulse = rememberInfiniteTransition(label = "micPulse")
      val s by pulse.animateFloat(1f, 1.35f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "s")
      Box(Modifier.size(36.dp).graphicsLayer { scaleX = s; scaleY = s; alpha = 1.4f - s }.clip(CircleShape).background(Color(0x40FB7185)))
    }
    Box(
      Modifier.size(36.dp).clip(CircleShape).background(bg).clickable(onClick = onClick),
      contentAlignment = Alignment.Center,
    ) {
      when (state) {
        2 -> CircularProgressIndicator(Modifier.size(16.dp), color = P.text2, strokeWidth = 2.dp)
        1 -> Icon(Icons.Rounded.Stop, contentDescription = "Stop", tint = P.pink, modifier = Modifier.size(19.dp))
        else -> Icon(Icons.Rounded.Mic, contentDescription = "Voice note", tint = P.text2, modifier = Modifier.size(19.dp))
      }
    }
  }
}

@Composable
private fun SendButton(enabled: Boolean, label: String, onClick: () -> Unit) {
  val haptics = LocalHapticFeedback.current
  val alpha by androidx.compose.animation.core.animateFloatAsState(if (enabled) 1f else 0.38f, label = "send")
  Row(
    Modifier
      .height(36.dp)
      .graphicsLayer { this.alpha = alpha }
      .clip(RoundedCornerShape(18.dp))
      .background(if (enabled) P.brand else SolidColor(Color(0x1AFFFFFF)))
      .clickable(enabled = enabled) {
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        onClick()
      }
      .padding(start = 14.dp, end = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
    Spacer(Modifier.width(7.dp))
    Text(label, color = Color.White, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
  }
}

// ---------------------------------------------------------------------------
// Search + filters
// ---------------------------------------------------------------------------

@Composable
private fun SearchField(ui: DockUiState) {
  Row(
    Modifier
      .fillMaxWidth()
      .height(42.dp)
      .clip(RoundedCornerShape(21.dp))
      .background(Color(0x0BFFFFFF))
      .border(1.dp, Color(0x0DFFFFFF), RoundedCornerShape(21.dp))
      .padding(start = 13.dp, end = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(Icons.Rounded.Search, contentDescription = null, tint = P.text3, modifier = Modifier.size(18.dp))
    Spacer(Modifier.width(9.dp))
    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
      if (ui.search.isEmpty()) Text("Search notes, links and tags", color = P.text3, fontSize = 13.5.sp, maxLines = 1)
      BasicTextField(
        value = ui.search,
        onValueChange = { ui.search = it },
        singleLine = true,
        textStyle = TextStyle(color = P.text, fontSize = 13.5.sp),
        cursorBrush = SolidColor(P.violetSoft),
        modifier = Modifier.fillMaxWidth(),
      )
    }
    AnimatedVisibility(ui.search.isNotEmpty(), enter = fadeIn() + scaleIn(), exit = fadeOut() + scaleOut()) {
      Box(
        Modifier.size(30.dp).clip(CircleShape).clickable { ui.search = "" },
        contentAlignment = Alignment.Center,
      ) {
        Icon(Icons.Rounded.Close, contentDescription = "Clear search", tint = P.text2, modifier = Modifier.size(16.dp))
      }
    }
  }
}

@Composable
private fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
  val index = options.indexOfFirst { it.first == selected }.coerceAtLeast(0)
  BoxWithConstraints(
    Modifier
      .fillMaxWidth()
      .height(38.dp)
      .clip(RoundedCornerShape(19.dp))
      .background(Color(0x0BFFFFFF))
      .padding(3.dp),
  ) {
    val segment = maxWidth / options.size
    val x by animateDpAsState(segment * index, spring(dampingRatio = 0.78f, stiffness = 520f), label = "seg")
    Box(
      Modifier
        .offset(x = x)
        .width(segment)
        .fillMaxHeight()
        .shadow(6.dp, RoundedCornerShape(16.dp), ambientColor = Color(0x557C5CFF))
        .clip(RoundedCornerShape(16.dp))
        .background(P.brand),
    )
    Row(Modifier.fillMaxSize()) {
      options.forEachIndexed { i, (key, label) ->
        val on = i == index
        val color by animateColorAsState(if (on) Color.White else P.text2, label = "segText")
        Box(
          Modifier
            .weight(1f)
            .fillMaxHeight()
            .clip(RoundedCornerShape(16.dp))
            .clickable(interactionSource = noRipple, indication = null) { onSelect(key) },
          contentAlignment = Alignment.Center,
        ) {
          Text(label, color = color, fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium)
        }
      }
    }
  }
}

@Composable
private fun <T> ChipRow(
  items: List<Pair<T, String>>,
  selected: T,
  accent: Color,
  icon: (T) -> ImageVector? = { null },
  onSelect: (T) -> Unit,
) {
  LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    items(items, key = { it.second }) { (value, label) ->
      val on = value == selected
      val bg by animateColorAsState(if (on) accent.copy(alpha = 0.92f) else Color(0x0BFFFFFF), label = "chip")
      Box(
        Modifier
          .height(30.dp)
          .clip(RoundedCornerShape(15.dp))
          .background(bg)
          .border(1.dp, if (on) Color.Transparent else Color(0x10FFFFFF), RoundedCornerShape(15.dp))
          .clickable { onSelect(value) }
          .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
      ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          val glyph = icon(value)
          if (glyph != null) {
            Icon(glyph, contentDescription = null, tint = if (on) Color.White else P.text3, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(5.dp))
          }
          Text(label, color = if (on) Color.White else P.text2, fontSize = 12.5.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// History list
// ---------------------------------------------------------------------------

@Composable
private fun NotesList(dock: NotesDock, ui: DockUiState, host: NotesDockHost, all: List<NoteUi>, notes: List<NoteUi>) {
  if (notes.isEmpty()) {
    EmptyState(any = all.isNotEmpty())
    return
  }
  val previews = remember(ui.version) { host.dockPreviewsOn() }
  val now by rememberNow()
  val pinned = remember(notes) { notes.filter { it.pinned } }
  val rest = remember(notes) { notes.filter { !it.pinned } }
  val listState = rememberLazyListState()
  LazyColumn(
    state = listState,
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(bottom = 20.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    if (pinned.isNotEmpty()) {
      item(key = "#pinned", contentType = "label") { SectionLabel("Pinned", Modifier.animateItem()) }
      items(pinned, key = { it.id }, contentType = { it.kind }) { n -> NoteCard(n, dock, ui, host, previews, now) }
      if (rest.isNotEmpty()) {
        item(key = "#recent", contentType = "label") { SectionLabel("Recent", Modifier.animateItem()) }
      }
    }
    items(rest, key = { it.id }, contentType = { it.kind }) { n -> NoteCard(n, dock, ui, host, previews, now) }
  }
}

@Composable
private fun SectionLabel(text: String, modifier: Modifier) {
  Text(
    text.uppercase(Locale.US),
    color = P.text3,
    fontSize = 11.sp,
    fontWeight = FontWeight.SemiBold,
    letterSpacing = 1.1.sp,
    modifier = modifier.padding(start = 4.dp, top = 4.dp, bottom = 0.dp),
  )
}

@Composable
private fun EmptyState(any: Boolean) {
  Column(Modifier.fillMaxSize().padding(top = 36.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Box(
      Modifier
        .size(68.dp)
        .clip(RoundedCornerShape(22.dp))
        .background(Brush.linearGradient(listOf(Color(0x407C5CFF), Color(0x2E22D3EE)))),
      contentAlignment = Alignment.Center,
    ) {
      Icon(if (any) Icons.Rounded.SearchOff else Icons.AutoMirrored.Rounded.StickyNote2, contentDescription = null, tint = P.text, modifier = Modifier.size(30.dp))
    }
    Spacer(Modifier.height(14.dp))
    Text(if (any) "No matches" else "Nothing here yet", color = P.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(4.dp))
    Text(
      if (any) "Try a different search or filter." else "Copy something on your PC and it lands here — or write a note above.",
      color = P.text3,
      fontSize = 13.sp,
      textAlign = TextAlign.Center,
      modifier = Modifier.padding(horizontal = 28.dp),
    )
  }
}

@Composable
private fun LazyItemScope.NoteCard(n: NoteUi, dock: NotesDock, ui: DockUiState, host: NotesDockHost, previews: Boolean, now: Long) {
  val pending = ui.pendingDelete == n.id
  val shape = RoundedCornerShape(20.dp)
  val borderColor by animateColorAsState(
    when {
      pending -> Color(0xB3F87171)
      n.pinned -> Color(0x737C5CFF)
      else -> Color(0x10FFFFFF)
    },
    label = "cardBorder",
  )
  val bg by animateColorAsState(if (pending) Color(0x26EF4444) else P.card, label = "cardBg")
  Column(
    Modifier
      .animateItem()
      .fillMaxWidth()
      .clip(shape)
      .background(bg)
      .border(1.dp, borderColor, shape)
      .padding(start = 13.dp, end = 6.dp, top = 12.dp, bottom = 4.dp),
  ) {
    Box(Modifier.padding(end = 7.dp)) {
      if (n.kind == "image") ImageBody(n, ui, host) else TextBody(n, ui, host, previews)
    }
    NoteMeta(n, dock, ui, host, now, pending)
  }
}

@Composable
private fun TextBody(n: NoteUi, ui: DockUiState, host: NotesDockHost, previews: Boolean) {
  val expanded = ui.expanded[n.id] == true
  var overflow by remember(n.id, n.text) { mutableStateOf(false) }
  val body = remember(n.text, n.contentKind) { host.dockBody(n.text, n.contentKind).toAnnotated { host.dockOpenUrl(it) } }
  Column {
    if (n.mono) {
      val accent = accentFor(n.contentKind)
      val textColor = when (n.contentKind) {
        "command" -> Color(0xFFD1FAE5)
        "path" -> Color(0xFFCFFAFE)
        else -> Color(0xFFE2E8F0)
      }
      Box(
        Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(12.dp))
          .background(Color(0x47000000))
          .drawBehind { drawRect(accent.copy(alpha = 0.75f), size = Size(3.dp.toPx(), size.height)) },
      ) {
        SelectionContainer {
          Text(
            body,
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
            color = textColor,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            softWrap = false,
            maxLines = if (expanded) Int.MAX_VALUE else 8,
            overflow = TextOverflow.Clip,
            onTextLayout = { if (!expanded) overflow = it.hasVisualOverflow },
          )
        }
      }
    } else {
      // A third of all notes are a single short line — a name, a code, a
      // reminder. At title weight they read as the label they are.
      val title = !n.text.contains('\n') && n.text.trim().length <= 60
      SelectionContainer {
        Text(
          body,
          color = if (title) P.text else Color(0xFFE2E8F0),
          fontSize = if (title) 16.sp else 14.sp,
          fontWeight = if (title) FontWeight.SemiBold else FontWeight.Normal,
          lineHeight = if (title) 21.sp else 20.sp,
          maxLines = if (expanded) Int.MAX_VALUE else 6,
          overflow = TextOverflow.Ellipsis,
          onTextLayout = { if (!expanded) overflow = it.hasVisualOverflow },
        )
      }
    }
    if (overflow || expanded) {
      Row(
        Modifier
          .padding(top = 4.dp)
          .clip(RoundedCornerShape(8.dp))
          .clickable { ui.expanded[n.id] = !expanded }
          .padding(vertical = 4.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(if (expanded) "Show less" else "Show more", color = P.violetSoft, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Icon(
          if (expanded) Icons.Rounded.KeyboardArrowUp else Icons.Rounded.KeyboardArrowDown,
          contentDescription = null,
          tint = P.violetSoft,
          modifier = Modifier.size(16.dp),
        )
      }
    }
    if (previews && !n.mono) {
      val url = remember(n.text) { host.dockLinkFor(n.text) }
      if (url != null) {
        Spacer(Modifier.height(8.dp))
        LinkCard(url, ui, host)
      }
    }
  }
}

@Composable
private fun LinkCard(url: String, ui: DockUiState, host: NotesDockHost) {
  val info = remember(ui.version, url) { host.dockLinkPreview(url) }
  LaunchedEffect(url) { if (host.dockLinkPreview(url) == null) host.dockRequestLinkPreview(url) }
  val heroUrl = info?.image?.takeIf { info.hero }
  val favUrl = if (info != null && heroUrl == null) {
    "https://www.google.com/s2/favicons?domain=" + Uri.encode(info.host) + "&sz=64"
  } else {
    null
  }
  val hero = heroUrl?.let { u -> remember(ui.version, u) { host.dockBitmap(u) } }
  val fav = favUrl?.let { u -> remember(ui.version, u) { host.dockBitmap(u) } }
  LaunchedEffect(heroUrl, favUrl) {
    heroUrl?.let { if (host.dockBitmap(it) == null) host.dockRequestBitmap(it) }
    favUrl?.let { if (host.dockBitmap(it) == null) host.dockRequestBitmap(it) }
  }
  val shape = RoundedCornerShape(16.dp)
  Column(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .background(Color(0x1238BDF8))
      .border(1.dp, Color(0x1F38BDF8), shape)
      .clickable { host.dockOpenUrl(url) },
  ) {
    if (hero != null) {
      val img = remember(hero) { hero.asImageBitmap() }
      Image(img, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(150.dp))
    }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        if (fav != null) {
          val icon = remember(fav) { fav.asImageBitmap() }
          Image(icon, contentDescription = null, modifier = Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)))
          Spacer(Modifier.width(6.dp))
        }
        Text(
          info?.host ?: (Uri.parse(url).host ?: url),
          color = P.cyan,
          fontSize = 11.sp,
          fontWeight = FontWeight.SemiBold,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.weight(1f, fill = false),
        )
      }
      Text(
        info?.title ?: "Loading preview…",
        color = if (info == null) P.text3 else P.text,
        fontSize = 13.5.sp,
        fontWeight = FontWeight.SemiBold,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 2.dp),
      )
      val desc = info?.description
      if (!desc.isNullOrEmpty()) {
        Text(desc, color = P.text2, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
      }
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImageBody(n: NoteUi, ui: DockUiState, host: NotesDockHost) {
  val bmp = remember(ui.version, n.id) { host.dockThumb(n.id) }
  LaunchedEffect(n.id) { if (host.dockThumb(n.id) == null) host.dockRequestThumb(n.id) }
  val shape = RoundedCornerShape(14.dp)
  BoxWithConstraints(Modifier.fillMaxWidth()) {
    if (bmp != null) {
      val img = remember(bmp) { bmp.asImageBitmap() }
      val ratio = (bmp.width.toFloat() / maxOf(1, bmp.height)).coerceIn(0.4f, 3f)
      val h: Dp = minOf(maxWidth / ratio, 220.dp)
      val w: Dp = minOf(maxWidth, h * ratio)
      Image(
        img,
        contentDescription = "Image note",
        contentScale = ContentScale.Crop,
        modifier = Modifier
          .width(w)
          .height(h)
          .clip(shape)
          .border(1.dp, Color(0x14FFFFFF), shape)
          .combinedClickable(onClick = { host.dockShare(n.id) }, onLongClick = { host.dockOpenApp() }),
      )
    } else {
      Shimmer(Modifier.fillMaxWidth().height(120.dp).clip(shape))
    }
  }
}

@Composable
private fun Shimmer(modifier: Modifier) {
  val t = rememberInfiniteTransition(label = "shimmer")
  val x by t.animateFloat(-1f, 2f, infiniteRepeatable(tween(1300, easing = LinearEasing)), label = "x")
  Box(
    modifier.drawWithCache {
      onDrawBehind {
        val w = size.width
        drawRect(Color(0x0FFFFFFF))
        drawRect(
          Brush.linearGradient(
            listOf(Color.Transparent, Color(0x14FFFFFF), Color.Transparent),
            start = Offset(w * x - w * 0.6f, 0f),
            end = Offset(w * x, size.height),
          ),
        )
      }
    },
  )
}

@Composable
private fun NoteMeta(n: NoteUi, dock: NotesDock, ui: DockUiState, host: NotesDockHost, now: Long, pending: Boolean) {
  Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f)) {
      if (n.tags.isNotEmpty()) {
        Text(
          n.tags.take(2).joinToString("  ") { "#$it" } + (if (n.tags.size > 2) "  +${n.tags.size - 2}" else ""),
          color = P.violetSoft,
          fontSize = 11.sp,
          fontWeight = FontWeight.Medium,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      val kindLabel = if (n.kind == "image") "Image" else n.contentLabel?.takeIf { n.mono }
      Text(
        listOfNotNull(kindLabel, n.deviceName.takeIf { it.isNotEmpty() }, relativeTime(n.createdAtMs, now)).joinToString(" · "),
        color = P.text3,
        fontSize = 11.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    if (n.kind == "text") ActionIcon(Icons.Rounded.Edit, "Edit", P.text3) { dock.startEdit(n) }
    ActionIcon(Icons.Rounded.Sell, "Tags", if (n.tags.isNotEmpty()) P.violetSoft else P.text3) {
      ui.tagPickerFor = n.id
    }
    ActionIcon(if (n.pinned) Icons.Rounded.PushPin else Icons.Outlined.PushPin, if (n.pinned) "Unpin" else "Pin", if (n.pinned) P.violetSoft else P.text3) {
      host.dockTogglePin(n.id)
    }
    ActionIcon(Icons.Rounded.Share, "Share", P.text3) { host.dockShare(n.id) }
    DeleteAction(pending) {
      if (pending) {
        ui.pendingDelete = null
        host.dockDelete(n.id)
      } else {
        ui.pendingDelete = n.id
        dock.armDeleteTimeout(n.id)
      }
    }
    if (n.kind == "text") {
      Spacer(Modifier.width(2.dp))
      CopyPill { host.dockCopy(n.id) }
    }
  }
}

@Composable
private fun ActionIcon(icon: ImageVector, label: String, tint: Color, onClick: () -> Unit) {
  val haptics = LocalHapticFeedback.current
  Box(
    Modifier.size(34.dp).clip(CircleShape).clickable {
      haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
      onClick()
    },
    contentAlignment = Alignment.Center,
  ) {
    Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(18.dp))
  }
}

@Composable
private fun DeleteAction(pending: Boolean, onClick: () -> Unit) {
  val haptics = LocalHapticFeedback.current
  Row(
    Modifier
      .height(34.dp)
      .clip(RoundedCornerShape(17.dp))
      .background(if (pending) Color(0x40EF4444) else Color.Transparent)
      .clickable {
        haptics.performHapticFeedback(if (pending) HapticFeedbackType.LongPress else HapticFeedbackType.TextHandleMove)
        onClick()
      }
      .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(Icons.Rounded.DeleteOutline, contentDescription = "Delete", tint = if (pending) P.red else Color(0xB3F87171), modifier = Modifier.size(18.dp))
    AnimatedVisibility(pending, enter = expandHorizontally() + fadeIn(), exit = shrinkHorizontally() + fadeOut()) {
      Text("Delete?", color = P.red, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 4.dp))
    }
  }
}

@Composable
private fun CopyPill(onCopy: () -> Unit) {
  var copied by remember { mutableStateOf(false) }
  LaunchedEffect(copied) {
    if (copied) {
      delay(1300)
      copied = false
    }
  }
  val haptics = LocalHapticFeedback.current
  val bg by animateColorAsState(if (copied) Color(0x3334D399) else Color(0x2438BDF8), label = "copy")
  Row(
    Modifier
      .height(32.dp)
      .clip(RoundedCornerShape(16.dp))
      .background(bg)
      .clickable {
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        copied = true
        onCopy()
      }
      .padding(horizontal = 11.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
      contentDescription = null,
      tint = if (copied) P.green else Color(0xFF7DD3FC),
      modifier = Modifier.size(15.dp),
    )
    Spacer(Modifier.width(5.dp))
    Text(if (copied) "Copied" else "Copy", color = if (copied) P.green else Color(0xFF7DD3FC), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
  }
}

// ---------------------------------------------------------------------------
// Tag picker (in-sheet; no Popup windows inside an overlay window)
// ---------------------------------------------------------------------------

@Composable
private fun TagPicker(ui: DockUiState, host: NotesDockHost, notes: List<NoteUi>, tags: List<String>) {
  val target = remember(notes, ui.tagPickerFor) { notes.firstOrNull { it.id == ui.tagPickerFor } }
  var last by remember { mutableStateOf<NoteUi?>(null) }
  SideEffect { if (target != null) last = target }
  AnimatedVisibility(
    target != null,
    enter = fadeIn(tween(160)) + slideInVertically { it / 4 },
    exit = fadeOut(tween(140)) + slideOutVertically { it / 4 },
  ) {
    val n = target ?: last ?: return@AnimatedVisibility
    var name by remember(n.id) { mutableStateOf("") }
    Column(
      Modifier
        .fillMaxSize()
        .clip(RoundedCornerShape(24.dp))
        .background(Color(0xFF111626))
        .border(1.dp, P.hairline, RoundedCornerShape(24.dp))
        .clickable(interactionSource = noRipple, indication = null) {}
        .padding(16.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text("Tags", color = P.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
          Text("Choose as many as you like", color = P.text3, fontSize = 12.sp)
        }
        Box(
          Modifier.height(34.dp).clip(RoundedCornerShape(17.dp)).background(P.brand).clickable { ui.tagPickerFor = null }.padding(horizontal = 16.dp),
          contentAlignment = Alignment.Center,
        ) { Text("Done", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
      }
      Spacer(Modifier.height(14.dp))
      Row(
        Modifier
          .fillMaxWidth()
          .height(44.dp)
          .clip(RoundedCornerShape(14.dp))
          .background(P.field)
          .padding(start = 12.dp, end = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
          if (name.isEmpty()) Text("New tag…", color = P.text3, fontSize = 14.sp)
          BasicTextField(
            value = name,
            onValueChange = { name = it.replace("\n", "") },
            singleLine = true,
            textStyle = TextStyle(color = P.text, fontSize = 14.sp),
            cursorBrush = SolidColor(P.violetSoft),
            modifier = Modifier.fillMaxWidth(),
          )
        }
        val canCreate = name.isNotBlank()
        Box(
          Modifier
            .height(34.dp)
            .clip(RoundedCornerShape(11.dp))
            .background(if (canCreate) Color(0x337C5CFF) else Color.Transparent)
            .clickable(enabled = canCreate) {
              host.dockToggleTag(n.id, name.trim())
              name = ""
            }
            .padding(horizontal = 12.dp),
          contentAlignment = Alignment.Center,
        ) { Text("Add", color = if (canCreate) P.violetSoft else P.text3, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
      }
      Spacer(Modifier.height(10.dp))
      if (tags.isEmpty()) {
        Text("No tags yet — create the first one above.", color = P.text3, fontSize = 13.sp, modifier = Modifier.padding(4.dp))
      }
      LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(tags, key = { it }) { tag ->
          val on = n.tags.any { it.equals(tag, ignoreCase = true) }
          Row(
            Modifier
              .fillMaxWidth()
              .clip(RoundedCornerShape(14.dp))
              .background(if (on) Color(0x1F7C5CFF) else Color.Transparent)
              .clickable { host.dockToggleTag(n.id, tag) }
              .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Icon(
              if (on) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked,
              contentDescription = null,
              tint = if (on) P.violetSoft else P.text3,
              modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(12.dp))
            Text("#$tag", color = if (on) P.text else P.text2, fontSize = 14.sp, fontWeight = if (on) FontWeight.Medium else FontWeight.Normal)
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Snackbar
// ---------------------------------------------------------------------------

@Composable
private fun SnackHost(ui: DockUiState, modifier: Modifier) {
  val snack = ui.snack
  LaunchedEffect(snack?.seq) {
    if (snack != null) {
      delay(1700)
      if (ui.snack?.seq == snack.seq) ui.snack = null
    }
  }
  var lastText by remember { mutableStateOf("") }
  SideEffect { if (snack != null) lastText = snack.text }
  AnimatedVisibility(
    snack != null,
    modifier = modifier,
    enter = fadeIn(tween(150)) + slideInVertically { it / 2 },
    exit = fadeOut(tween(200)) + slideOutVertically { it / 2 },
  ) {
    Row(
      Modifier
        .widthIn(max = 320.dp)
        .shadow(14.dp, RoundedCornerShape(22.dp))
        .clip(RoundedCornerShape(22.dp))
        .background(Color(0xF21A2033))
        .border(1.dp, P.hairline, RoundedCornerShape(22.dp))
        .padding(horizontal = 16.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = P.green, modifier = Modifier.size(16.dp))
      Spacer(Modifier.width(8.dp))
      Text(snack?.text ?: lastText, color = P.text, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 2)
    }
  }
}
