package dev.simless.host

import android.graphics.Color
import android.os.Bundle
import java.io.File
import org.json.JSONObject

// The plan the CLI writes, with its paths already moved onto the device by the runner.
class Plan(json: JSONObject) {
  val resultPath: String = json.getString("result")
  val bundlePath: String = json.getString("bundle")
  val fonts: List<String> = json.optJSONArray("fonts")?.let { array -> List(array.length()) { array.getString(it) } }.orEmpty()
  val locale: String? = json.optString("locale").ifEmpty { null }
  val selection: String? = json.optString("selection").ifEmpty { null }
  val interactive: Boolean = json.optBoolean("interactive")
  val template: JSONObject = json.optJSONObject("template") ?: JSONObject()

  companion object {
    fun read(path: String) = Plan(JSONObject(File(path).readText()))
  }
}

// One render a script asked for: the plan's template with the render's own options over it.
class Job(val id: String, merged: JSONObject) {
  val name: String = merged.optString("name").ifEmpty { id }
  val outputPath: String = merged.optString("output", "{name}.png").replace("{name}", name)
  val width: Double = merged.optDouble("width", 412.0)
  val height: Double = merged.optDouble("height", 915.0)
  val scale: Double = merged.optDouble("scale", 2.625)
  val dark: Boolean = merged.optString("appearance") == "dark"
  val fit: Boolean = merged.optBoolean("fit")
  val padding: Double = merged.optDouble("padding", 0.0)
  val settleMs: Long = merged.optDouble("settleMs", 150.0).toLong()
  val timeoutMs: Long = merged.optDouble("timeoutMs", 15000.0).toLong()
  val background: Int? = parseColor(merged.optString("background"))

  // A component cropped to its content is not on a screen, so it gets no status bar or navigation bar inset.
  private val safeArea: JSONObject =
    if (fit) JSONObject() else merged.optJSONObject("safeArea") ?: JSONObject()

  // What runtime/index.js receives as the root component's props.
  val initialProperties: Bundle =
    Bundle().apply {
      putString("jobId", id)
      putString("component", "")
      putBundle("props", Bundle())
      putDouble("width", width)
      putDouble("height", height)
      putDouble("scale", scale)
      putString("appearance", if (dark) "dark" else "light")
      putBoolean("fit", fit)
      putDouble("padding", padding)
      putBundle(
        "safeArea",
        Bundle().apply {
          for (edge in listOf("top", "left", "bottom", "right")) {
            putDouble(edge, safeArea.optDouble(edge, 0.0))
          }
        }
      )
    }

  companion object {
    fun from(template: JSONObject, id: String, options: JSONObject): Job {
      val merged = JSONObject(template.toString())
      for (key in options.keys()) {
        if (!options.isNull(key)) {
          merged.put(key, options.get(key))
        }
      }
      return Job(id, merged)
    }

    private fun parseColor(value: String): Int? {
      val trimmed = value.trim()
      if (trimmed.isEmpty()) {
        return null
      }
      if (trimmed == "transparent") {
        return Color.TRANSPARENT
      }
      require(trimmed.startsWith("#") && (trimmed.length == 7 || trimmed.length == 9)) {
        "background must be #RRGGBB, #RRGGBBAA or transparent, got $trimmed"
      }
      val rgba = if (trimmed.length == 7) "${trimmed.substring(1)}FF" else trimmed.substring(1)
      val hex = rgba.toLong(16)
      return Color.argb(
        (hex and 0xFF).toInt(),
        ((hex shr 24) and 0xFF).toInt(),
        ((hex shr 16) and 0xFF).toInt(),
        ((hex shr 8) and 0xFF).toInt()
      )
    }
  }
}
