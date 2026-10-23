package dev.simless.host

import android.app.Application
import android.content.res.Configuration
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import expo.modules.ApplicationLifecycleDispatcher

// Holds the ReactHost SimlessActivity makes once it has read its plan; modules reach it through ReactApplication.
object SimlessHost {
  @Volatile
  var reactHost: ReactHost? = null
}

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost
    get() = SimlessHost.reactHost ?: error("simless: the host has no plan yet")

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
