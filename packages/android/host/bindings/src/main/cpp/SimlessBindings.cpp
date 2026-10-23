#include <fbjni/fbjni.h>
#include <jsi/jsi.h>

#include <functional>
#include <string>
#include <utility>

namespace facebook::react {

// As React Native declares them in ReactCommon/react/runtime/BindingsInstaller.h and
// ReactAndroid/src/main/jni/react/runtime/jni/JBindingsInstaller.h, which its prefab does not ship. React Native
// calls getBindingsInstallFunc() through its own copy of these classes, so the layout (a HybridClass, then a class
// with one virtual method) has to stay exactly theirs.
class BindingsInstaller {
 public:
  virtual std::function<void(jsi::Runtime &runtime)> getBindingsInstallFunc() {
    return nullptr;
  }
};

class JBindingsInstaller : public jni::HybridClass<JBindingsInstaller>, public BindingsInstaller {
 public:
  static constexpr auto kJavaDescriptor = "Lcom/facebook/react/runtime/BindingsInstaller;";
  ~JBindingsInstaller() {}

 private:
  friend HybridBase;
};

} // namespace facebook::react

namespace {

using namespace facebook;

// dev.simless.bindings.SimlessBridge, which hands each call to the activity running the plan.
struct JSimlessBridge : jni::JavaClass<JSimlessBridge> {
  static constexpr auto kJavaDescriptor = "Ldev/simless/bindings/SimlessBridge;";

  static void mount(const std::string &renderId, const std::string &options) {
    static const auto method = javaClassStatic()->getStaticMethod<void(jstring, jstring)>("mount");
    method(javaClassStatic(), jni::make_jstring(renderId).get(), jni::make_jstring(options).get());
  }

  static void ready(const std::string &renderId, double contentHeight) {
    static const auto method = javaClassStatic()->getStaticMethod<void(jstring, jdouble)>("ready");
    method(javaClassStatic(), jni::make_jstring(renderId).get(), contentHeight);
  }

  static void fail(const std::string &renderId, const std::string &error) {
    static const auto method = javaClassStatic()->getStaticMethod<void(jstring, jstring)>("fail");
    method(javaClassStatic(), jni::make_jstring(renderId).get(), jni::make_jstring(error).get());
  }

  static jni::local_ref<jstring> result(const std::string &renderId) {
    static const auto method = javaClassStatic()->getStaticMethod<jstring(jstring)>("result");
    return method(javaClassStatic(), jni::make_jstring(renderId).get());
  }

  static void done(const std::string &script) {
    static const auto method = javaClassStatic()->getStaticMethod<void(jstring)>("done");
    method(javaClassStatic(), jni::make_jstring(script).get());
  }
};

std::string stringArgument(jsi::Runtime &runtime, const jsi::Value *arguments, size_t count, size_t index) {
  if (index >= count || !arguments[index].isString()) {
    return "";
  }
  return arguments[index].asString(runtime).utf8(runtime);
}

jsi::Function hostFunction(jsi::Runtime &runtime, const char *name, unsigned int count, jsi::HostFunctionType body) {
  // A Java exception would otherwise unwind through Hermes; it becomes a JS error the script can report.
  auto guarded = [name, body = std::move(body)](
                     jsi::Runtime &rt, const jsi::Value &self, const jsi::Value *arguments, size_t argumentCount) {
    try {
      return body(rt, self, arguments, argumentCount);
    } catch (const jsi::JSIException &) {
      throw;
    } catch (const std::exception &error) {
      throw jsi::JSError(rt, std::string("simless host: ") + name + ": " + error.what());
    }
  };
  return jsi::Function::createFromHostFunction(runtime, jsi::PropNameID::forAscii(runtime, name), count, guarded);
}

// Installs globalThis.__simless before the bundle runs, so runtime/index.js can call it at module scope. The script
// drives the host: mount(id, options) shows a render, ready/fail report on it, result(id) is how it went, and
// done(script) ends the run. The same contract as ios/react-native/SMLReactHost.mm in @expo-simless/macos.
class SimlessBindingsInstaller : public jni::HybridClass<SimlessBindingsInstaller, react::JBindingsInstaller> {
 public:
  static constexpr auto kJavaDescriptor = "Ldev/simless/bindings/SimlessBindingsInstaller;";

  static jni::local_ref<jhybriddata> initHybrid(jni::alias_ref<jclass>, std::string selection, std::string locale) {
    return makeCxxInstance(std::move(selection), std::move(locale));
  }

  static void registerNatives() {
    registerHybrid({makeNativeMethod("initHybrid", SimlessBindingsInstaller::initHybrid)});
  }

  std::function<void(jsi::Runtime &runtime)> getBindingsInstallFunc() override {
    return [selection = selection_, locale = locale_](jsi::Runtime &runtime) {
      jsi::Object bridge(runtime);
      bridge.setProperty(
          runtime,
          "mount",
          hostFunction(runtime, "mount", 2, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) {
            JSimlessBridge::mount(stringArgument(rt, args, n, 0), stringArgument(rt, args, n, 1));
            return jsi::Value::undefined();
          }));
      bridge.setProperty(
          runtime,
          "ready",
          hostFunction(runtime, "ready", 2, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) {
            double height = n > 1 && args[1].isNumber() ? args[1].asNumber() : 0;
            JSimlessBridge::ready(stringArgument(rt, args, n, 0), height);
            return jsi::Value::undefined();
          }));
      bridge.setProperty(
          runtime,
          "fail",
          hostFunction(runtime, "fail", 2, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) {
            JSimlessBridge::fail(stringArgument(rt, args, n, 0), stringArgument(rt, args, n, 1));
            return jsi::Value::undefined();
          }));
      bridge.setProperty(
          runtime,
          "result",
          hostFunction(runtime, "result", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) {
            auto json = JSimlessBridge::result(stringArgument(rt, args, n, 0));
            return json ? jsi::Value(jsi::String::createFromUtf8(rt, json->toStdString())) : jsi::Value::undefined();
          }));
      bridge.setProperty(
          runtime,
          "done",
          hostFunction(runtime, "done", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) {
            JSimlessBridge::done(stringArgument(rt, args, n, 0));
            return jsi::Value::undefined();
          }));
      if (!selection.empty()) {
        bridge.setProperty(runtime, "selection", jsi::String::createFromUtf8(runtime, selection));
      }
      if (!locale.empty()) {
        bridge.setProperty(runtime, "locale", jsi::String::createFromUtf8(runtime, locale));
      }
      runtime.global().setProperty(runtime, "__simless", bridge);
    };
  }

 private:
  friend HybridBase;

  SimlessBindingsInstaller(std::string selection, std::string locale)
      : selection_(std::move(selection)), locale_(std::move(locale)) {}

  std::string selection_;
  std::string locale_;
};

} // namespace

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  return jni::initialize(vm, [] {
    SimlessBindingsInstaller::registerNatives();
    // Found now, on a thread with the app's class loader; the JS thread looks it up from this cache.
    JSimlessBridge::javaClassStatic();
  });
}
