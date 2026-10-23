package dev.simless.host

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.facebook.react.PackageList
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.ReactHost
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.interfaces.fabric.ReactSurface
import dev.simless.bindings.SimlessBindingsInstaller
import dev.simless.bindings.SimlessBridge
import dev.simless.bindings.SimlessBridgeHandler
import expo.modules.ExpoReactHostFactory
import expo.modules.ReactActivityDelegateWrapper
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.ceil
import kotlin.math.min
import org.json.JSONArray
import org.json.JSONObject

// Must match the name runtime/index.js registers with AppRegistry.
private const val MODULE_NAME = "Simless"
private const val TAG = "Simless"

// A view that keeps drawing for good (an animated canvas, a ticking clock) never holds still; it is captured as it
// is this long past the settle time, as the macOS host does with its Metal layers.
private const val ANIMATING_GRACE_MS = 2000L
private const val POLL_MS = 16L

// The threads image libraries decode on: Glide's (expo-image) and Fresco's (React Native's Image). Nothing draws
// while they work, so a large image would land after a quiet window had already ended; one of them running counts
// as drawing. Idle, they wait on their queues.
private val IMAGE_THREAD_PREFIXES = listOf("glide-", "Fresco")

private fun imagesDecoding(): Boolean {
  var group = Thread.currentThread().threadGroup
  while (group?.parent != null) {
    group = group.parent
  }
  val threads = arrayOfNulls<Thread>((group?.activeCount() ?: 0) * 2 + 16)
  val count = group?.enumerate(threads, true) ?: 0
  return (0 until count).any { index ->
    val thread = threads[index] ?: return@any false
    thread.state == Thread.State.RUNNABLE && IMAGE_THREAD_PREFIXES.any { thread.name.startsWith(it) }
  }
}

// Runs a plan: the bundle is the script, and it asks for each render with __simless.mount(). The same contract as
// ios/react-native/SMLReactHost.mm in @alivelabs/expo-simless-macos; the runner on the Mac pushes the plan and pulls the PNGs.
// A ReactActivity behind Expo's delegate wrapper, as an Expo app's MainActivity is: React Native sets the window up
// edge to edge from it, and Expo modules' activity listeners (navigation bar, system UI) run as they do in the app.
// It has no main component; each render mounts a surface of its own.
class SimlessActivity : ReactActivity(), SimlessBridgeHandler {

  private class Running(val job: Job, val surface: ReactSurface, val view: View) {
    val startedAt = SystemClock.uptimeMillis()
    var capturing = false
    var contentHeight = 0.0
  }

  private lateinit var plan: Plan
  private lateinit var root: FrameLayout
  private var reactHost: ReactHost? = null
  private var current: Running? = null
  private var shownOnce = false
  private var lastDraw = SystemClock.uptimeMillis()
  private val main = Handler(Looper.getMainLooper())
  private val results = ConcurrentHashMap<String, String>()
  private val finished = JSONArray()
  private var timeout: Runnable? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    val planPath = intent.getStringExtra("plan") ?: error("simless: started without a plan")
    plan = Plan.read(planPath)
    registerFonts(plan.fonts)
    SimlessBridge.handler = this
    // Made before super.onCreate, which reads it from the application.
    val host =
      ExpoReactHostFactory.getDefaultReactHost(
        context = applicationContext,
        packageList = PackageList(application).packages,
        jsBundleFilePath = plan.bundlePath,
        useDevSupport = false,
        bindingsInstaller = SimlessBindingsInstaller(plan.selection ?: "", plan.locale ?: "")
      )
    SimlessHost.reactHost = host
    reactHost = host
    // react-native-screens cannot restore its fragments, which a recreated activity would try.
    super.onCreate(null)
    root = FrameLayout(this)
    root.viewTreeObserver.addOnDrawListener { lastDraw = SystemClock.uptimeMillis() }
    setContentView(root)
    host.start()
  }

  override fun getMainComponentName(): String? = null

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    ReactActivityDelegateWrapper(
      this,
      BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
      object : DefaultReactActivityDelegate(this, MODULE_NAME, fabricEnabled) {
        override fun getMainComponentName(): String? = null
      }
    )

  // The family is the file's name, as expo-font names fonts it embeds in an Android app.
  private fun registerFonts(paths: List<String>) {
    for (path in paths) {
      val file = File(path)
      try {
        ReactFontManager.getInstance().setTypeface(file.nameWithoutExtension, Typeface.NORMAL, Typeface.createFromFile(file))
      } catch (error: RuntimeException) {
        Log.w(TAG, "simless: could not register font $path: $error")
      }
    }
  }

  override fun mount(renderId: String, options: String) {
    main.post { mountRender(renderId, JSONObject(options)) }
  }

  override fun ready(renderId: String, contentHeight: Double) {
    main.post { renderReady(renderId, contentHeight) }
  }

  override fun fail(renderId: String, error: String) {
    main.post {
      val running = current ?: return@post
      if (running.job.id != renderId) {
        return@post
      }
      if (plan.interactive) {
        Log.e(TAG, "simless: ${running.job.name} failed: $error")
        return@post
      }
      complete(running, error, false)
    }
  }

  override fun result(renderId: String): String? = results[renderId]

  override fun done(script: String) {
    main.post { finishScript(JSONObject(script)) }
  }

  private fun mountRender(renderId: String, options: JSONObject) {
    if (current != null) {
      results[renderId] =
        JSONObject()
          .put("ok", false)
          .put("error", "render() was called while another render was running; await each one")
          .toString()
      return
    }
    val job = Job.from(plan.template, renderId, options)
    applyBackground(job)
    val surface = reactHost!!.createSurface(this, MODULE_NAME, job.initialProperties)
    surface.start()
    val view = surface.view ?: error("simless: the surface has no view")
    (view.parent as? ViewGroup)?.removeView(view)
    root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    val running = Running(job, surface, view)
    current = running
    // A shown render waits for as long as it takes; what goes wrong is logged, and the window stays.
    if (!plan.interactive) {
      val onTimeout = Runnable { complete(running, "timed out waiting for the component to render", false) }
      timeout = onTimeout
      main.postDelayed(onTimeout, job.timeoutMs)
    }
  }

  private fun applyBackground(job: Job) {
    val color = job.background ?: if (job.dark) Color.BLACK else Color.WHITE
    if (Color.alpha(color) < 255) {
      window.setFormat(PixelFormat.TRANSLUCENT)
    }
    window.setBackgroundDrawable(ColorDrawable(color))
    root.setBackgroundColor(color)
  }

  private fun renderReady(renderId: String, contentHeight: Double) {
    val running = current ?: return
    if (running.job.id != renderId || running.capturing) {
      return
    }
    if (plan.interactive) {
      Log.i(TAG, "simless: showing ${running.job.name}")
      shownOnce = true
      return
    }
    running.capturing = true
    timeout?.let { main.removeCallbacks(it) }
    running.contentHeight = contentHeight
    waitUntilSettled(running) { settled -> capture(running, settled) }
  }

  // Settled once nothing has drawn, and no image has been decoding, for the job's settle time; Android draws only
  // what invalidates, so a quiet window is a finished one.
  private fun waitUntilSettled(running: Running, completion: (Boolean) -> Unit) {
    val start = SystemClock.uptimeMillis()
    val job = running.job
    val poll =
      object : Runnable {
        override fun run() {
          if (current !== running) {
            return
          }
          val now = SystemClock.uptimeMillis()
          if (imagesDecoding()) {
            lastDraw = now
          }
          when {
            now - lastDraw >= job.settleMs -> completion(true)
            now - start >= job.settleMs + ANIMATING_GRACE_MS -> completion(true)
            now - start >= job.timeoutMs -> completion(false)
            else -> main.postDelayed(this, POLL_MS)
          }
        }
      }
    main.postDelayed(poll, POLL_MS)
  }

  private fun capture(running: Running, settled: Boolean) {
    val decor = window.decorView
    val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
    PixelCopy.request(
      window,
      bitmap,
      { status ->
        if (status != PixelCopy.SUCCESS) {
          complete(running, "PixelCopy could not read the window (status $status)", settled)
          return@request
        }
        val job = running.job
        val height =
          if (job.fit) ceil(running.contentHeight * resources.displayMetrics.density).toInt() else bitmap.height
        if (height <= 0) {
          complete(
            running,
            "nothing was drawn: with fit the root is sized by its content, so a component whose root is flex: 1 " +
              "(a screen, an empty state) gets no height. Render it without fit, or inside a view with a size",
            settled
          )
          return@request
        }
        val image = if (height < bitmap.height) Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, min(height, bitmap.height)) else bitmap
        try {
          val output = File(job.outputPath)
          output.parentFile?.mkdirs()
          output.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
          complete(running, null, settled)
        } catch (error: Exception) {
          complete(running, "could not write ${job.outputPath}: $error", settled)
        }
      },
      main
    )
  }

  private fun complete(running: Running, error: String?, settled: Boolean) {
    if (current !== running) {
      return
    }
    timeout?.let { main.removeCallbacks(it) }
    timeout = null
    val job = running.job
    val entry =
      JSONObject()
        .put("id", job.id)
        .put("name", job.name)
        .put("output", job.outputPath)
        .put("ok", error == null)
        .put("settled", settled)
        .put("durationMs", SystemClock.uptimeMillis() - running.startedAt)
        .put("logs", JSONArray())
    error?.let { entry.put("error", it) }
    finished.put(entry)
    running.surface.stop()
    root.removeView(running.view)
    current = null
    val result = JSONObject().put("ok", error == null).put("settled", settled).put("output", job.outputPath)
    error?.let { result.put("error", it) }
    results[job.id] = result.toString()
  }

  private fun finishScript(script: JSONObject) {
    // A shown render never resolves, so a script that ends showed nothing. The window stays, with what it says.
    if (plan.interactive) {
      if (!shownOnce) {
        val names = script.optJSONArray("names")
        val listed = names?.let { array -> List(array.length()) { array.getString(it) }.joinToString(", ") }.orEmpty()
        val reason = script.optString("error").ifEmpty { "The script's renders: $listed" }
        Log.e(TAG, "simless: no render to show. $reason")
      }
      return
    }
    current?.let { complete(it, script.optString("error").ifEmpty { "the script ended during this render" }, false) }
    script.put("jobs", finished)
    File(plan.resultPath).writeText(script.toString())
    finishAndRemoveTask()
    Process.killProcess(Process.myPid())
  }
}
