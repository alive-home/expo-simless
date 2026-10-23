package dev.simless.bindings

import com.facebook.jni.HybridData
import com.facebook.react.runtime.BindingsInstaller

// Handed to the ReactHost, which installs what the C++ half returns (globalThis.__simless) before the bundle runs.
// Empty strings for no selection and the system's locale.
class SimlessBindingsInstaller(selection: String, locale: String) :
  BindingsInstaller(initHybrid(selection, locale)) {

  private companion object {
    init {
      System.loadLibrary("simlessbindings")
    }

    @JvmStatic
    external fun initHybrid(selection: String, locale: String): HybridData
  }
}
