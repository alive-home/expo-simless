#import <UIKit/UIKit.h>
#import <objc/runtime.h>

#import <React/RCTAssert.h>
#import <React/RCTLog.h>
// React Native's prebuilt artifacts name the app delegate headers React_RCTAppDelegate; CocoaPods may name them
// after the pod.
#if __has_include(<React_RCTAppDelegate/RCTReactNativeFactory.h>)
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <React_RCTAppDelegate/RCTReactNativeFactory.h>
#import <React_RCTAppDelegate/RCTRootViewFactory.h>
#else
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <React-RCTAppDelegate/RCTReactNativeFactory.h>
#import <React-RCTAppDelegate/RCTRootViewFactory.h>
#endif
#import <ReactCommon/RCTHost.h>
#include <jsi/jsi.h>

#import "SMLCapture.h"

using namespace facebook;

// Must match the name runtime/index.js registers with AppRegistry.
static NSString *const SMLModuleName = @"Simless";

@interface SMLRunner : NSObject
+ (instancetype)shared;
- (void)start;
- (void)mountRender:(NSString *)renderId options:(NSDictionary *)options;
- (void)jobWithId:(NSString *)jobId reportedError:(nullable NSString *)error contentHeight:(double)contentHeight;
- (void)failEverything:(NSString *)error;
@property (nonatomic, strong, readonly, nullable) UIWindow *window;
@end

// What each finished render came to, as JSON, read by the script from the JS thread while the main thread writes.
static NSMutableDictionary<NSString *, NSString *> *gRenderResults;

static void SMLStoreResult(NSString *renderId, NSDictionary *result) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  @synchronized(gRenderResults) {
    gRenderResults[renderId] = json;
  }
}

static NSDictionary *SMLParseJSON(NSString *json) {
  id parsed = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  return [parsed isKindOfClass:NSDictionary.class] ? parsed : @{};
}

static std::string SMLString(jsi::Runtime &runtime, const jsi::Value *arguments, size_t count, size_t index) {
  if (index >= count || !arguments[index].isString()) {
    return "";
  }
  return arguments[index].asString(runtime).utf8(runtime);
}

static void SMLReport(NSString *jobId, NSString *_Nullable error, double contentHeight) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [SMLRunner.shared jobWithId:jobId reportedError:error contentHeight:contentHeight];
  });
}

static jsi::Function SMLFunction(jsi::Runtime &runtime, const char *name, unsigned int count,
                                 jsi::HostFunctionType body) {
  return jsi::Function::createFromHostFunction(runtime, jsi::PropNameID::forAscii(runtime, name), count, body);
}

// Runs on the JS thread before the bundle executes, so runtime/index.js can call these at module scope. The script
// drives the host: mount(id, options) shows a render, ready/fail report on it, result(id) is how it went, and
// done(script) ends the process.
static void SMLInstallBridge(jsi::Runtime &runtime) {
  jsi::Object bridge(runtime);
  bridge.setProperty(runtime, "mount",
                     SMLFunction(runtime, "mount", 2,
                                 [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *arguments, size_t count) {
                                   NSString *renderId = @(SMLString(rt, arguments, count, 0).c_str());
                                   NSDictionary *options = SMLParseJSON(@(SMLString(rt, arguments, count, 1).c_str()));
                                   dispatch_async(dispatch_get_main_queue(), ^{
                                     [SMLRunner.shared mountRender:renderId options:options];
                                   });
                                   return jsi::Value::undefined();
                                 }));
  bridge.setProperty(runtime, "ready",
                     SMLFunction(runtime, "ready", 2,
                                 [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *arguments, size_t count) {
                                   double height = count > 1 && arguments[1].isNumber() ? arguments[1].asNumber() : 0;
                                   SMLReport(@(SMLString(rt, arguments, count, 0).c_str()), nil, height);
                                   return jsi::Value::undefined();
                                 }));
  bridge.setProperty(runtime, "fail",
                     SMLFunction(runtime, "fail", 2,
                                 [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *arguments, size_t count) {
                                   SMLReport(@(SMLString(rt, arguments, count, 0).c_str()),
                                             @(SMLString(rt, arguments, count, 1).c_str()), 0);
                                   return jsi::Value::undefined();
                                 }));
  bridge.setProperty(runtime, "result",
                     SMLFunction(runtime, "result", 1,
                                 [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *arguments, size_t count) {
                                   NSString *renderId = @(SMLString(rt, arguments, count, 0).c_str());
                                   NSString *json = nil;
                                   @synchronized(gRenderResults) {
                                     json = gRenderResults[renderId];
                                   }
                                   return json != nil ? jsi::Value(jsi::String::createFromUtf8(rt, json.UTF8String))
                                                      : jsi::Value::undefined();
                                 }));
  bridge.setProperty(runtime, "done",
                     SMLFunction(runtime, "done", 1,
                                 [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *arguments, size_t count) {
                                   NSDictionary *script = SMLParseJSON(@(SMLString(rt, arguments, count, 0).c_str()));
                                   dispatch_async(dispatch_get_main_queue(), ^{
                                     [SMLCapture finishScript:script];
                                   });
                                   return jsi::Value::undefined();
                                 }));
  NSString *selection = SMLCapture.plan.selection;
  if (selection != nil) {
    bridge.setProperty(runtime, "selection", jsi::String::createFromUtf8(runtime, selection.UTF8String));
  }
  bridge.setProperty(runtime, "interactive", jsi::Value(static_cast<bool>(SMLCapture.plan.interactive)));
  NSString *locale = SMLCapture.plan.locale;
  if (locale != nil) {
    bridge.setProperty(runtime, "locale", jsi::String::createFromUtf8(runtime, locale.UTF8String));
  }
  runtime.global().setProperty(runtime, "__simless", bridge);
}

// The factory is the RCTHost's delegate. Expo's overrides host:didInitializeRuntime: without forwarding it to
// the React Native delegate, so the bridge is installed by wrapping the method on whichever factory class runs.
static void SMLHookRuntimeInit(Class factoryClass) {
  SEL selector = @selector(host:didInitializeRuntime:);
  Method method = class_getInstanceMethod(factoryClass, selector);
  typedef void (*Original)(id, SEL, RCTHost *, jsi::Runtime &);
  Original original = method != NULL ? (Original)method_getImplementation(method) : NULL;
  IMP patched = imp_implementationWithBlock(^(id receiver, RCTHost *host, jsi::Runtime &runtime) {
    if (original != NULL) {
      original(receiver, selector, host, runtime);
    }
    SMLInstallBridge(runtime);
  });
  // Added on the class itself when it only inherits the method, so its superclass is left alone.
  if (!class_addMethod(factoryClass, selector, patched, "v@:@^v")) {
    method_setImplementation(method, patched);
  }
}

// React Native's own containers, between the root view and the app's views. Something may give them a background
// after creation (expo-system-ui paints the root view from the app config), which would cover the job's
// background and make --fit measure the whole screen.
static void SMLClearContainers(UIView *view) {
  view.backgroundColor = UIColor.clearColor;
  for (UIView *subview in view.subviews) {
    NSString *name = NSStringFromClass(subview.class);
    if ([name hasPrefix:@"RCTSurface"] || [name isEqualToString:@"RCTRootComponentView"]) {
      SMLClearContainers(subview);
    }
  }
}

@implementation SMLRunner {
  RCTReactNativeFactory *_factory;
  RCTDefaultReactNativeFactoryDelegate *_delegate;
  SMLJob *_current;
  NSTimer *_timeout;
  BOOL _capturing;
  BOOL _warmedUp;
  BOOL _shownOnce;
}

+ (instancetype)shared {
  static SMLRunner *runner;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    runner = [SMLRunner new];
    gRenderResults = [NSMutableDictionary dictionary];
  });
  return runner;
}

- (void)start {
  // Swift classes, so found by name: Expo's factory, and SMLExpoDelegate, the delegate it requires.
  Class factoryClass = NSClassFromString(@"Expo.ExpoReactNativeFactory") ?: NSClassFromString(@"ExpoReactNativeFactory");
  Class delegateClass = NSClassFromString(@"SMLExpoDelegate");
  if (factoryClass == nil || delegateClass == nil) {
    [self failEverything:@"the host was built without Expo's factory or its delegate"];
    return;
  }
  SMLHookRuntimeInit(factoryClass);
  [SMLCapture reportDeviceIdiom];
  _delegate = [delegateClass new];
  // Generated by codegen into the host; it registers the third-party Fabric components (react-native-svg and the
  // like).
  Class dependencyProvider = NSClassFromString(@"RCTAppDependencyProvider");
  if (dependencyProvider != nil) {
    _delegate.dependencyProvider = [dependencyProvider new];
  }
  _factory = [[factoryClass alloc] initWithDelegate:_delegate];
  [SMLCapture log:[NSString stringWithFormat:@"[info] simless factory %@, delegate %@, dependency provider %@",
                                             NSStringFromClass(factoryClass), NSStringFromClass(delegateClass),
                                             dependencyProvider != nil ? @"yes" : @"no"]];
  // The bundle runs before any surface exists: it is the script, and it asks for each render with mount().
  RCTRootViewFactory *rootViewFactory = _factory.rootViewFactory;
  if (rootViewFactory.reactHost == nil) {
    rootViewFactory.reactHost = [rootViewFactory createReactHost:nil];
  }
  if (SMLCapture.plan.interactive) {
    [self endWithTheWindow];
  }
}

- (void)endWithTheWindow {
  // Closing the window ends the session, as quitting does. AppKit's notification, because Catalyst disconnects the
  // scene only seconds after its window has gone.
  [NSNotificationCenter.defaultCenter addObserverForName:@"NSWindowWillCloseNotification"
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(NSNotification *notification) {
                                                if ([NSStringFromClass([notification.object class]) isEqualToString:@"UINSWindow"]) {
                                                  exit(0);
                                                }
                                              }];
  [NSNotificationCenter.defaultCenter addObserverForName:UISceneDidDisconnectNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(NSNotification *notification) {
                                                exit(0);
                                              }];
}

- (void)mountRender:(NSString *)renderId options:(NSDictionary *)options {
  if (_current != nil) {
    SMLStoreResult(renderId, @{@"ok" : @NO, @"error" : @"render() was called while another render was running; await each one"});
    return;
  }
  _current = [SMLCapture jobWithIdentifier:renderId options:options];
  [SMLCapture startJob:_current];
  [self mountCurrent];
}

- (void)mountCurrent {
  _capturing = NO;
  UIView *root = [_factory.rootViewFactory viewWithModuleName:SMLModuleName
                                            initialProperties:_current.initialProperties];
  root.backgroundColor = UIColor.clearColor;
  UIViewController *controller = [UIViewController new];
  controller.view = root;
  _window = [SMLCapture makeWindowForJob:_current rootViewController:controller];

  SMLJob *job = _current;
  // A shown render waits for as long as it takes; what goes wrong is printed, and the window stays.
  if (SMLCapture.plan.interactive) {
    return;
  }
  _timeout = [NSTimer scheduledTimerWithTimeInterval:job.timeout
                                             repeats:NO
                                               block:^(NSTimer *timer) {
                                                 [self complete:job
                                                          error:@"timed out waiting for the component to render"
                                                        settled:NO];
                                               }];
}

- (void)jobWithId:(NSString *)jobId reportedError:(NSString *)error contentHeight:(double)contentHeight {
  SMLJob *job = _current;
  if (job == nil || ![job.identifier isEqualToString:jobId] || _capturing) {
    return;
  }
  if (error != nil) {
    if (SMLCapture.plan.interactive) {
      fprintf(stderr, "simless: %s failed: %s\n", job.name.UTF8String, error.UTF8String);
      return;
    }
    [self complete:job error:error settled:NO];
    return;
  }
  // The first Skia canvas in a process never draws (a later one draws at once), so a first job that has a Metal
  // layer is mounted once more before it is captured.
  if (!_warmedUp) {
    _warmedUp = YES;
    if ([SMLCapture windowContainsMetal:_window]) {
      [SMLCapture log:@"[info] simless: rendering the first Metal-backed job twice"];
      [_timeout invalidate];
      [SMLCapture tearDownWindow:_window];
      _window = nil;
      [self mountCurrent];
      return;
    }
  }
  _capturing = YES;
  if (SMLCapture.plan.interactive) {
    fprintf(stderr, "simless: showing %s\n", job.name.UTF8String);
    if (!_shownOnce) {
      _shownOnce = YES;
      [SMLCapture activateApp];
    }
    return;
  }
  // From here the settle wait has its own limit, past which it captures anyway and says the render did not settle.
  [_timeout invalidate];
  _timeout = nil;
  job.contentHeight = contentHeight;
  SMLClearContainers(_window.rootViewController.view);
  [self captureFramesOf:job from:0 readyAt:CACurrentMediaTime() then:^{
    [self captureWhenSettled:job];
  }];
}

// Each frame is written when its time comes, whatever is on screen: an animation is meant to be caught part-way.
- (void)captureFramesOf:(SMLJob *)job from:(NSUInteger)index readyAt:(CFTimeInterval)readyAt then:(void (^)(void))then {
  if (job != _current || index >= job.frames.count) {
    then();
    return;
  }
  double milliseconds = job.frames[index].doubleValue;
  double wait = MAX(0, readyAt + milliseconds / 1000.0 - CACurrentMediaTime());
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (job != self->_current) {
      return;
    }
    NSString *path = [SMLCapture framePathForJob:job milliseconds:milliseconds];
    NSError *writeError = nil;
    if ([SMLCapture writePNGOfWindow:self->_window job:job path:path error:&writeError]) {
      [job.capturedFrames addObject:path];
    } else {
      [SMLCapture log:[NSString stringWithFormat:@"[warn] simless: frame %@ms not written: %@", job.frames[index],
                                                 writeError.localizedDescription]];
    }
    [self captureFramesOf:job from:index + 1 readyAt:readyAt then:then];
  });
}

- (void)captureWhenSettled:(SMLJob *)job {
  [SMLCapture waitUntilSettled:_window
                           job:job
                    completion:^(BOOL settled) {
                      // A root sized by its content gives a flex: 1 component no height, which would otherwise be
                      // written as an empty PNG that looks like a component drawing nothing.
                      if (job.fit && [SMLCapture drawnBottomOfWindow:self->_window] <= 0) {
                        [self complete:job
                                 error:@"nothing was drawn: with fit the root is sized by its content, so a component "
                                       @"whose root is flex: 1 (a screen, an empty state) gets no height. Render it "
                                       @"without fit, or inside a view with a size"
                               settled:settled];
                        return;
                      }
                      NSError *writeError = nil;
                      BOOL written = [SMLCapture writePNGOfWindow:self->_window job:job error:&writeError];
                      [self complete:job error:written ? nil : writeError.localizedDescription settled:settled];
                    }];
}

- (void)complete:(SMLJob *)job error:(NSString *)error settled:(BOOL)settled {
  if (job != _current) {
    return;
  }
  [_timeout invalidate];
  _timeout = nil;
  [SMLCapture finishJob:job error:error settled:settled];
  [SMLCapture tearDownWindow:_window];
  _window = nil;
  _current = nil;
  NSMutableDictionary *result = [@{@"ok" : (error == nil ? @YES : @NO), @"settled" : (settled ? @YES : @NO), @"output" : job.outputPath} mutableCopy];
  if (error != nil) {
    result[@"error"] = error;
  }
  SMLStoreResult(job.identifier, result);
}

- (void)failEverything:(NSString *)error {
  if (SMLCapture.plan.interactive) {
    fprintf(stderr, "simless: %s\n", error.UTF8String);
    return;
  }
  if (_current != nil) {
    [SMLCapture finishJob:_current error:error settled:NO];
    _current = nil;
  }
  [SMLCapture finishScript:@{@"error" : error}];
}

@end

@interface SMLAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation SMLAppDelegate

// React Native asks the app delegate for its window (RCTKeyWindow and friends).
- (UIWindow *)window {
  return SMLRunner.shared.window;
}

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  RCTSetLogThreshold(RCTLogLevelInfo);
  RCTSetLogFunction(^(RCTLogLevel level, RCTLogSource source, NSString *file, NSNumber *line, NSString *message) {
    static NSString *const levels[] = {@"trace", @"info", @"warn", @"error", @"fatal"};
    NSString *name = level >= RCTLogLevelTrace && level <= RCTLogLevelFatal ? levels[level] : @"log";
    NSString *entry = [NSString stringWithFormat:@"[%@] %@", name, message];
    dispatch_async(dispatch_get_main_queue(), ^{
      [SMLCapture log:entry];
    });
  });
  // A fatal JS error leaves the runtime unusable, so every job still waiting fails with it.
  RCTSetFatalHandler(^(NSError *error) {
    NSString *message = error.localizedDescription;
    dispatch_async(dispatch_get_main_queue(), ^{
      [SMLRunner.shared failEverything:message];
    });
  });
  RCTSetFatalExceptionHandler(^(NSException *exception) {
    NSString *message = [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason];
    dispatch_async(dispatch_get_main_queue(), ^{
      [SMLRunner.shared failEverything:message];
    });
  });
  [SMLCapture whenSceneIsActive:^{
    [SMLRunner.shared start];
  }];
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    SMLPlan *plan = [SMLCapture loadPlan];
    if (plan.bundlePath == nil) {
      fprintf(stderr, "simless host: the plan has no bundle\n");
      return 64;
    }
    [SMLCapture prepareProcess];
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(SMLAppDelegate.class));
  }
}
