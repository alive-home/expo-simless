package dev.simless.bindings

// What globalThis.__simless calls, from the JS thread. The C++ half finds these static methods by name.
interface SimlessBridgeHandler {
  fun mount(renderId: String, options: String)

  fun ready(renderId: String, contentHeight: Double)

  fun fail(renderId: String, error: String)

  fun result(renderId: String): String?

  fun done(script: String)
}

object SimlessBridge {
  @Volatile
  @JvmStatic
  var handler: SimlessBridgeHandler? = null

  @JvmStatic
  fun mount(renderId: String, options: String) {
    handler?.mount(renderId, options)
  }

  @JvmStatic
  fun ready(renderId: String, contentHeight: Double) {
    handler?.ready(renderId, contentHeight)
  }

  @JvmStatic
  fun fail(renderId: String, error: String) {
    handler?.fail(renderId, error)
  }

  @JvmStatic
  fun result(renderId: String): String? = handler?.result(renderId)

  @JvmStatic
  fun done(script: String) {
    handler?.done(script)
  }
}
