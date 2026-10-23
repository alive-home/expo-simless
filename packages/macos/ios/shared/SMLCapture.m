#import "SMLCapture.h"

#import <CoreText/CoreText.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>

static SMLPlan *gPlan;
static NSMutableArray<NSDictionary *> *gResults;
static NSMutableArray<NSString *> *gJobLogs;
static CFTimeInterval gJobStart;

static void SMLFail(NSString *message) {
  fprintf(stderr, "simless host: %s\n", message.UTF8String);
  exit(64);
}

static UIColor *_Nullable SMLParseColor(id value) {
  if (![value isKindOfClass:NSString.class]) {
    return nil;
  }
  NSString *string = [(NSString *)value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  if ([string isEqualToString:@"transparent"]) {
    return UIColor.clearColor;
  }
  if (![string hasPrefix:@"#"] || (string.length != 7 && string.length != 9)) {
    SMLFail([NSString stringWithFormat:@"background must be #RRGGBB, #RRGGBBAA or transparent, got %@", string]);
  }
  unsigned long long hex = 0;
  [[NSScanner scannerWithString:[string substringFromIndex:1]] scanHexLongLong:&hex];
  if (string.length == 7) {
    hex = (hex << 8) | 0xFF;
  }
  return [UIColor colorWithRed:((hex >> 24) & 0xFF) / 255.0
                         green:((hex >> 16) & 0xFF) / 255.0
                          blue:((hex >> 8) & 0xFF) / 255.0
                         alpha:(hex & 0xFF) / 255.0];
}

static double SMLNumber(NSDictionary *dictionary, NSString *key, double fallback) {
  id value = dictionary[key];
  return [value isKindOfClass:NSNumber.class] ? [value doubleValue] : fallback;
}

@implementation SMLJob

- (instancetype)initWithDictionary:(NSDictionary *)dictionary {
  if ((self = [super init])) {
    _identifier = [dictionary[@"id"] description] ?: @"0";
    _name = [dictionary[@"name"] isKindOfClass:NSString.class] ? dictionary[@"name"] : _identifier;
    _outputPath = dictionary[@"output"];
    _component = dictionary[@"component"] ?: @"";
    _props = [dictionary[@"props"] isKindOfClass:NSDictionary.class] ? dictionary[@"props"] : @{};
    _size = CGSizeMake(SMLNumber(dictionary, @"width", 402), SMLNumber(dictionary, @"height", 874));
    _scale = SMLNumber(dictionary, @"scale", 3);
    NSDictionary *insets = [dictionary[@"safeArea"] isKindOfClass:NSDictionary.class] ? dictionary[@"safeArea"] : @{};
    _safeArea = UIEdgeInsetsMake(SMLNumber(insets, @"top", 0), SMLNumber(insets, @"left", 0),
                                 SMLNumber(insets, @"bottom", 0), SMLNumber(insets, @"right", 0));
    _cornerRadius = SMLNumber(dictionary, @"cornerRadius", 0);
    _style = [dictionary[@"appearance"] isEqual:@"dark"] ? UIUserInterfaceStyleDark : UIUserInterfaceStyleLight;
    _background = SMLParseColor(dictionary[@"background"]);
    _settle = SMLNumber(dictionary, @"settleMs", 150) / 1000.0;
    _timeout = SMLNumber(dictionary, @"timeoutMs", 15000) / 1000.0;
    _fit = [dictionary[@"fit"] boolValue];
    _padding = SMLNumber(dictionary, @"padding", 0);
    NSMutableArray<NSNumber *> *frames = [NSMutableArray array];
    if ([dictionary[@"frames"] isKindOfClass:NSArray.class]) {
      for (id frame in dictionary[@"frames"]) {
        if ([frame isKindOfClass:NSNumber.class] && [frame doubleValue] >= 0) {
          [frames addObject:frame];
        }
      }
    }
    _frames = [frames sortedArrayUsingSelector:@selector(compare:)];
    _capturedFrames = [NSMutableArray array];
    if (![_outputPath isKindOfClass:NSString.class]) {
      SMLFail([NSString stringWithFormat:@"job %@ has no output path", _identifier]);
    }
    _initialProperties = @{
      @"jobId" : _identifier,
      @"component" : _component,
      @"props" : _props,
      @"width" : @(_size.width),
      @"height" : @(_size.height),
      @"scale" : @(_scale),
      @"appearance" : _style == UIUserInterfaceStyleDark ? @"dark" : @"light",
      @"fit" : @(_fit),
      @"padding" : @(_padding),
      @"safeArea" : @{
        @"top" : @(_safeArea.top),
        @"left" : @(_safeArea.left),
        @"bottom" : @(_safeArea.bottom),
        @"right" : @(_safeArea.right),
      },
    };
  }
  return self;
}

@end

@implementation SMLPlan

- (instancetype)initWithDictionary:(NSDictionary *)dictionary {
  if ((self = [super init])) {
    NSMutableArray *jobs = [NSMutableArray array];
    for (id job in dictionary[@"jobs"]) {
      if ([job isKindOfClass:NSDictionary.class]) {
        [jobs addObject:[[SMLJob alloc] initWithDictionary:job]];
      }
    }
    _jobs = jobs;
    _renderTemplate = [dictionary[@"template"] isKindOfClass:NSDictionary.class] ? dictionary[@"template"] : nil;
    _selection = [dictionary[@"selection"] isKindOfClass:NSString.class] ? dictionary[@"selection"] : nil;
    _resultPath = dictionary[@"result"];
    _bundlePath = dictionary[@"bundle"];
    _fonts = [dictionary[@"fonts"] isKindOfClass:NSArray.class] ? dictionary[@"fonts"] : @[];
    _verbose = [dictionary[@"verbose"] boolValue];
    _locale = [dictionary[@"locale"] isKindOfClass:NSString.class] ? dictionary[@"locale"] : nil;
    _interactive = [dictionary[@"interactive"] boolValue];
    if (![_resultPath isKindOfClass:NSString.class]) {
      SMLFail(@"the plan has no result path");
    }
    if (jobs.count == 0 && _renderTemplate == nil) {
      SMLFail(@"the plan has no jobs");
    }
  }
  return self;
}

@end

// The window server has to know the window: drawViewHierarchy gets liquid glass, blurs and other backdrop
// effects from it, and draws them empty for a window it has never had. So the scene's NSWindow is ordered in as
// usual, but made invisible first: transparent, click-through, shadowless, out of the Window menu and window cycling.
static void SMLMakeInvisible(id window) {
  ((void (*)(id, SEL, CGFloat))objc_msgSend)(window, NSSelectorFromString(@"setAlphaValue:"), 0);
  ((void (*)(id, SEL, BOOL))objc_msgSend)(window, NSSelectorFromString(@"setIgnoresMouseEvents:"), YES);
  ((void (*)(id, SEL, BOOL))objc_msgSend)(window, NSSelectorFromString(@"setHasShadow:"), NO);
  ((void (*)(id, SEL, BOOL))objc_msgSend)(window, NSSelectorFromString(@"setExcludedFromWindowsMenu:"), YES);
  // NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle.
  ((void (*)(id, SEL, NSUInteger))objc_msgSend)(window, NSSelectorFromString(@"setCollectionBehavior:"), (1 << 3) | (1 << 6));
}

static void SMLKeepAppKitWindowsHidden(void) {
  Class window = NSClassFromString(@"NSWindow");
  Class application = NSClassFromString(@"NSApplication");
  if (window == nil || application == nil) {
    return;
  }
  for (NSString *name in @[ @"makeKeyAndOrderFront:", @"orderFront:" ]) {
    SEL selector = NSSelectorFromString(name);
    Method method = class_getInstanceMethod(window, selector);
    if (method != NULL) {
      void (*original)(id, SEL, id) = (void (*)(id, SEL, id))method_getImplementation(method);
      method_setImplementation(method, imp_implementationWithBlock(^(id receiver, id sender) {
                                 SMLMakeInvisible(receiver);
                                 original(receiver, selector, sender);
                               }));
    }
  }
  SEL regardless = NSSelectorFromString(@"orderFrontRegardless");
  Method front = class_getInstanceMethod(window, regardless);
  if (front != NULL) {
    void (*original)(id, SEL) = (void (*)(id, SEL))method_getImplementation(front);
    method_setImplementation(front, imp_implementationWithBlock(^(id receiver) {
                               SMLMakeInvisible(receiver);
                               original(receiver, regardless);
                             }));
  }
  SEL orderSelector = NSSelectorFromString(@"orderWindow:relativeTo:");
  Method order = class_getInstanceMethod(window, orderSelector);
  if (order != NULL) {
    void (*original)(id, SEL, NSInteger, NSInteger) = (void (*)(id, SEL, NSInteger, NSInteger))method_getImplementation(order);
    method_setImplementation(order, imp_implementationWithBlock(^(id receiver, NSInteger place, NSInteger other) {
                               SMLMakeInvisible(receiver);
                               original(receiver, orderSelector, place, other);
                             }));
  }
  // LSBackgroundOnly already keeps the process from activating; this covers frameworks that ask anyway.
  for (NSString *name in @[ @"activateIgnoringOtherApps:", @"activate" ]) {
    Method method = class_getInstanceMethod(application, NSSelectorFromString(name));
    if (method != NULL) {
      method_setImplementation(method, imp_implementationWithBlock(^(id receiver, BOOL flag){
                               }));
    }
  }
  // Catalyst draws controls in a window that is not key, in an app that is not active, the way a Mac draws a
  // background window: switches gray instead of green. An iPhone is always the active window.
  NSArray<NSArray *> *alwaysYes = @[
    @[ window, @"isKeyWindow" ], @[ window, @"isMainWindow" ], @[ application, @"isActive" ]
  ];
  for (NSArray *pair in alwaysYes) {
    Method method = class_getInstanceMethod(pair[0], NSSelectorFromString(pair[1]));
    if (method != NULL) {
      method_setImplementation(method, imp_implementationWithBlock(^BOOL(id receiver) {
                                 return YES;
                               }));
    }
  }
}

// React Native reads the screen for PixelRatio, Dimensions and every layer's contentsScale. On a Mac that is the
// display, so without this a 3x render would upscale text drawn at 2x and report the Mac's screen size.
static void SMLFakeScreen(CGSize size, CGFloat scale) {
  Class screen = UIScreen.class;
  CGRect bounds = CGRectMake(0, 0, size.width, size.height);
  CGRect nativeBounds = CGRectMake(0, 0, size.width * scale, size.height * scale);
  method_setImplementation(class_getInstanceMethod(screen, @selector(bounds)),
                           imp_implementationWithBlock(^CGRect(id receiver) {
                             return bounds;
                           }));
  method_setImplementation(class_getInstanceMethod(screen, @selector(nativeBounds)),
                           imp_implementationWithBlock(^CGRect(id receiver) {
                             return nativeBounds;
                           }));
  method_setImplementation(class_getInstanceMethod(screen, @selector(scale)),
                           imp_implementationWithBlock(^CGFloat(id receiver) {
                             return scale;
                           }));
  method_setImplementation(class_getInstanceMethod(screen, @selector(nativeScale)),
                           imp_implementationWithBlock(^CGFloat(id receiver) {
                             return scale;
                           }));
}

// iOS 26 rounds sheets and other containers concentric with the display's corners, read from the screen, from the
// trait collection, and per view from the scene's corners it touches. A Mac reports none (or the Mac window's), which
// gives a sheet 20pt corners where an iPhone has 56. The device's radius stands in for all three.
static void SMLFakeDisplayCorners(CGFloat radius) {
  for (NSString *name in @[ @"_displayCornerRadius", @"_displayCornerRadiusIgnoringZoom", @"_traitCollectionDisplayCornerRadius" ]) {
    Method method = class_getInstanceMethod(UIScreen.class, NSSelectorFromString(name));
    if (method != NULL) {
      method_setImplementation(method, imp_implementationWithBlock(^CGFloat(id receiver) {
                                 return radius;
                               }));
    }
  }
  Method trait = class_getInstanceMethod(UITraitCollection.class, NSSelectorFromString(@"displayCornerRadius"));
  if (trait != NULL) {
    method_setImplementation(trait, imp_implementationWithBlock(^CGFloat(id receiver) {
                               return radius;
                             }));
  }
  // CACornerRadii: top left, top right, bottom right, bottom left. A view gets the radius on each corner it shares
  // with the window, as on an iPhone, where the window is the screen.
  typedef struct {
    CGSize topLeft, topRight, bottomRight, bottomLeft;
  } SMLCornerRadii;
  Method scene = class_getInstanceMethod(UIView.class, NSSelectorFromString(@"_intersectedSceneCornerRadii"));
  if (scene != NULL) {
    method_setImplementation(scene, imp_implementationWithBlock(^SMLCornerRadii(UIView *view) {
                               SMLCornerRadii radii = {CGSizeZero, CGSizeZero, CGSizeZero, CGSizeZero};
                               UIWindow *window = view.window;
                               if (window == nil) {
                                 return radii;
                               }
                               CGRect frame = [view convertRect:view.bounds toView:window];
                               CGRect bounds = window.bounds;
                               BOOL left = CGRectGetMinX(frame) <= CGRectGetMinX(bounds) + 0.5;
                               BOOL right = CGRectGetMaxX(frame) >= CGRectGetMaxX(bounds) - 0.5;
                               BOOL top = CGRectGetMinY(frame) <= CGRectGetMinY(bounds) + 0.5;
                               BOOL bottom = CGRectGetMaxY(frame) >= CGRectGetMaxY(bounds) - 0.5;
                               CGSize corner = CGSizeMake(radius, radius);
                               radii.topLeft = top && left ? corner : CGSizeZero;
                               radii.topRight = top && right ? corner : CGSizeZero;
                               radii.bottomRight = bottom && right ? corner : CGSizeZero;
                               radii.bottomLeft = bottom && left ? corner : CGSizeZero;
                               return radii;
                             }));
  }
}

// A Catalyst UISwitch with no onTintColor is gray when on; on iOS it is green. SwiftUI sets nil explicitly, so the
// appearance proxy is not enough. A tint the app picks still wins.
static void SMLGreenSwitches(void) {
  Method setter = class_getInstanceMethod(UISwitch.class, @selector(setOnTintColor:));
  void (*setOnTint)(id, SEL, UIColor *) = (void (*)(id, SEL, UIColor *))method_getImplementation(setter);
  method_setImplementation(setter, imp_implementationWithBlock(^(UISwitch *receiver, UIColor *color) {
                             setOnTint(receiver, @selector(setOnTintColor:), color ?: UIColor.systemGreenColor);
                           }));
  // didMoveToWindow may be UIView's, inherited; patch it on UISwitch only, never on every view.
  Method moved = class_getInstanceMethod(UISwitch.class, @selector(didMoveToWindow));
  void (*didMove)(id, SEL) = (void (*)(id, SEL))method_getImplementation(moved);
  IMP patched = imp_implementationWithBlock(^(UISwitch *receiver) {
    didMove(receiver, @selector(didMoveToWindow));
    if (receiver.onTintColor == nil) {
      receiver.onTintColor = UIColor.systemGreenColor;
    }
  });
  if (!class_addMethod(UISwitch.class, @selector(didMoveToWindow), patched, method_getTypeEncoding(moved))) {
    method_setImplementation(moved, patched);
  }
}

// Catalyst draws a rim image around a sheet's edge, a Mac window's, with corners tighter than the sheet's own; an
// iPhone's sheet has no rim (UIDropShadowView holds none there), so the rim stays hidden: shown, its corners stand out
// beyond the sheet's.
static void SMLHideSheetRims(void) {
  Class rim = NSClassFromString(@"UIDropShadowRimPartView");
  if (rim == Nil) {
    return;
  }
  SEL setHidden = @selector(setHidden:);
  Method hidden = class_getInstanceMethod(rim, setHidden);
  void (*originalSetHidden)(id, SEL, BOOL) = (void (*)(id, SEL, BOOL))method_getImplementation(hidden);
  IMP alwaysHidden = imp_implementationWithBlock(^(UIView *view, BOOL flag) {
    originalSetHidden(view, setHidden, YES);
  });
  if (!class_addMethod(rim, setHidden, alwaysHidden, method_getTypeEncoding(hidden))) {
    method_setImplementation(hidden, alwaysHidden);
  }
  SEL moved = @selector(didMoveToWindow);
  Method didMove = class_getInstanceMethod(rim, moved);
  void (*originalDidMove)(id, SEL) = (void (*)(id, SEL))method_getImplementation(didMove);
  IMP hideOnMove = imp_implementationWithBlock(^(UIView *view) {
    originalDidMove(view, moved);
    view.hidden = YES;
  });
  if (!class_addMethod(rim, moved, hideOnMove, method_getTypeEncoding(didMove))) {
    method_setImplementation(didMove, hideOnMove);
  }
}

// Catalyst presents a sheet in a separate scene, an AppKit-backed window (_UIBridgedPresentationWindow) the host never
// orders in, so the sheet's content is never added anywhere. An iPhone presents it in the window; so does this.
static void SMLPresentInWindow(void) {
  Method method = class_getInstanceMethod(UIPresentationController.class, NSSelectorFromString(@"_canPresentInSeparateScene"));
  if (method != NULL) {
    method_setImplementation(method, imp_implementationWithBlock(^BOOL(id receiver) {
                               return NO;
                             }));
  }
}

// Animations are off in the host (prepareProcess), so an animator's block lands at its end at once. One that is
// scrubbed to a fraction and left paused is a way to hold a partial effect, not an animation: expo-blur sets its
// intensity so, which would otherwise draw every BlurView at full strength. Such an animator gets them back.
static void SMLKeepScrubbedAnimators(void) {
  SEL selector = @selector(setFractionComplete:);
  Method method = class_getInstanceMethod(UIViewPropertyAnimator.class, selector);
  if (method == NULL) {
    return;
  }
  void (*original)(id, SEL, CGFloat) = (void (*)(id, SEL, CGFloat))method_getImplementation(method);
  method_setImplementation(method, imp_implementationWithBlock(^(id animator, CGFloat fraction) {
    BOOL enabled = UIView.areAnimationsEnabled;
    [UIView setAnimationsEnabled:YES];
    original(animator, selector, fraction);
    [UIView setAnimationsEnabled:enabled];
  }));
}

static void SMLRegisterFonts(NSArray<NSString *> *paths) {
  for (NSString *path in paths) {
    CFErrorRef error = NULL;
    NSURL *url = [NSURL fileURLWithPath:path];
    if (!CTFontManagerRegisterFontsForURL((__bridge CFURLRef)url, kCTFontManagerScopeProcess, &error)) {
      NSError *bridged = CFBridgingRelease(error);
      // Already registered is fine: two jobs in one plan can list the same font.
      if (bridged.code != kCTFontManagerErrorAlreadyRegistered) {
        fprintf(stderr, "simless host: could not register font %s: %s\n", path.UTF8String,
                bridged.localizedDescription.UTF8String);
      }
    }
  }
}

static uint64_t SMLMix(uint64_t hash, uint64_t value) {
  return (hash ^ value) * 1099511628211ULL;
}

static uint64_t SMLMixDouble(uint64_t hash, double value) {
  return SMLMix(hash, (uint64_t)llround(value * 100));
}

// A cheap digest of everything that changes what the window draws. Settled means it stopped changing.
// A focused field's caret (and the glow beside it) blinks for as long as the field has focus, so it is left out of
// the settle checks and drawn steady at capture.
static BOOL SMLIsTextCursor(CALayer *layer) {
  id delegate = layer.delegate;
  return [delegate isKindOfClass:UIView.class] && [NSStringFromClass([delegate class]) containsString:@"TextCursor"];
}

// A spinner turns for as long as it is shown, so it would keep any render with one from settling.
static BOOL SMLIsSpinner(CALayer *layer) {
  return [layer.delegate isKindOfClass:UIActivityIndicatorView.class];
}

static void SMLSteadyTextCursors(UIView *view) {
  if (SMLIsTextCursor(view.layer)) {
    [view.layer removeAllAnimations];
    view.layer.opacity = 1;
    return;
  }
  for (UIView *subview in view.subviews) {
    SMLSteadyTextCursors(subview);
  }
}

static uint64_t SMLFingerprint(CALayer *layer, uint64_t hash) {
  if (SMLIsTextCursor(layer) || SMLIsSpinner(layer)) {
    return hash;
  }
  hash = SMLMix(hash, (uint64_t)(uintptr_t)(__bridge void *)layer);
  hash = SMLMixDouble(hash, layer.position.x);
  hash = SMLMixDouble(hash, layer.position.y);
  hash = SMLMixDouble(hash, layer.bounds.size.width);
  hash = SMLMixDouble(hash, layer.bounds.size.height);
  hash = SMLMixDouble(hash, layer.opacity);
  // Reanimated moves and scales views through their transform, on the UI thread, so an entrance animation shows
  // here and nowhere else.
  CATransform3D transform = layer.transform;
  CGFloat parts[] = {transform.m11, transform.m12, transform.m21, transform.m22, transform.m41, transform.m42};
  for (size_t index = 0; index < sizeof(parts) / sizeof(parts[0]); index += 1) {
    hash = SMLMixDouble(hash, parts[index]);
  }
  hash = SMLMix(hash, layer.hidden);
  hash = SMLMix(hash, (uint64_t)(uintptr_t)(__bridge void *)layer.contents);
  hash = SMLMix(hash, (uint64_t)(uintptr_t)layer.backgroundColor);
  hash = SMLMix(hash, layer.sublayers.count);
  for (CALayer *sublayer in layer.sublayers) {
    hash = SMLFingerprint(sublayer, hash);
  }
  return hash;
}

static BOOL SMLDraws(UIView *view) {
  CALayer *layer = view.layer;
  CGFloat alpha = 0;
  [view.backgroundColor getRed:NULL green:NULL blue:NULL alpha:&alpha];
  return alpha > 0 || layer.contents != nil || layer.borderWidth > 0 || layer.shadowOpacity > 0 ||
         [view isKindOfClass:UIControl.class] || [view isKindOfClass:UIImageView.class] ||
         [view isKindOfClass:UILabel.class] || [view isKindOfClass:UIVisualEffectView.class];
}

// The lowest edge of anything that draws. Clear containers are skipped: React Native's surface and root views
// span the whole window whatever their content.
static CGFloat SMLContentBottom(UIView *view, UIWindow *window) {
  CGFloat bottom = 0;
  for (UIView *subview in view.subviews) {
    if (subview.hidden || subview.alpha < 0.01) {
      continue;
    }
    CGRect frame = [subview convertRect:subview.bounds toView:window];
    // A view with no size still has children: a --fit root laid out by its content is 0 tall when all of that
    // content is absolutely positioned.
    if (CGRectIsEmpty(subview.bounds) && subview.clipsToBounds) {
      continue;
    }
    if (SMLDraws(subview) && !CGRectIsEmpty(subview.bounds)) {
      bottom = MAX(bottom, CGRectGetMaxY(frame));
    }
    CGFloat inner = SMLContentBottom(subview, window);
    bottom = MAX(bottom, subview.clipsToBounds ? MIN(inner, CGRectGetMaxY(frame)) : inner);
  }
  return bottom;
}

// UIKit transitions (a sheet sliding up) move only the presentation layers, which the fingerprint does not read, so a
// running animation counts as change. One that repeats for good (a spinner) never ends and is ignored.
// One past its end is over too: UIViewPropertyAnimator's pacing animations are removed by a render server callback
// that never comes to a window that is never on screen, so they stay attached after they finish.
static BOOL SMLIsAnimating(CALayer *layer) {
  if (SMLIsTextCursor(layer) || SMLIsSpinner(layer)) {
    return NO;
  }
  CFTimeInterval now = [layer convertTime:CACurrentMediaTime() fromLayer:nil];
  for (NSString *key in layer.animationKeys) {
    CAAnimation *animation = [layer animationForKey:key];
    BOOL endless = animation.repeatCount == HUGE_VALF || animation.repeatDuration == HUGE_VAL ||
                   animation.duration >= 1e6;
    CFTimeInterval length = animation.repeatDuration > 0 ? animation.repeatDuration
                                                         : animation.duration * MAX(1.0f, animation.repeatCount) *
                                                               (animation.autoreverses ? 2 : 1);
    BOOL over = animation.beginTime > 0 && now > animation.beginTime + length;
    if (!endless && !over) {
      return YES;
    }
  }
  for (CALayer *sublayer in layer.sublayers) {
    if (SMLIsAnimating(sublayer)) {
      return YES;
    }
  }
  return NO;
}

// With SIMLESS_DUMP_TREE, what kept a render from settling: the layers still animating and their animation keys.
static void SMLDumpAnimations(CALayer *layer, UIView *owner) {
  // A layer of no view's (a Skia surface, a gradient) is named by the nearest view above it, with its frame there.
  UIView *view = [layer.delegate isKindOfClass:UIView.class] ? (UIView *)layer.delegate : owner;
  for (NSString *key in layer.animationKeys) {
    CAAnimation *animation = [layer animationForKey:key];
    CGRect frame = [view.layer convertRect:layer.frame fromLayer:layer.superlayer];
    fprintf(stderr, "animating: %s (in %s at %.0f,%.0f %.0fx%.0f) key %s duration %.2f repeat %.0f\n",
            class_getName(layer.class), class_getName(view.class), frame.origin.x, frame.origin.y, frame.size.width,
            frame.size.height, key.UTF8String, animation.duration, animation.repeatCount);
  }
  for (CALayer *sublayer in layer.sublayers) {
    SMLDumpAnimations(sublayer, view);
  }
}

// With SIMLESS_DUMP_TREE, every layer's geometry by layer, so a render that never settles can say which layers moved
// between its last two checks.
static void SMLLayerStates(CALayer *layer, UIView *owner, UIWindow *window, NSMutableDictionary *states) {
  UIView *view = [layer.delegate isKindOfClass:UIView.class] ? (UIView *)layer.delegate : owner;
  CGRect frame = [window.layer convertRect:layer.bounds fromLayer:layer];
  CATransform3D transform = layer.transform;
  states[[NSValue valueWithPointer:(__bridge void *)layer]] =
      [NSString stringWithFormat:@"%s in %s: frame %.2f,%.2f %.2fx%.2f transform %.3f %.2f,%.2f opacity %.2f",
                                 class_getName(layer.class), class_getName(view.class), frame.origin.x, frame.origin.y,
                                 frame.size.width, frame.size.height, transform.m11, transform.m41, transform.m42,
                                 layer.opacity];
  for (CALayer *sublayer in layer.sublayers) {
    SMLLayerStates(sublayer, view, window, states);
  }
}

// Metal layers (Skia, video, GL) draw into drawables the layer tree does not show, so the fingerprint above
// cannot tell when they are done; a small render of the window can.
static const CFTimeInterval SMLMetalGrace = 2.0;

static BOOL SMLContainsMetal(CALayer *layer) {
  if ([layer isKindOfClass:CAMetalLayer.class]) {
    return YES;
  }
  for (CALayer *sublayer in layer.sublayers) {
    if (SMLContainsMetal(sublayer)) {
      return YES;
    }
  }
  return NO;
}

static uint64_t SMLPixelDigest(UIWindow *window) {
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
  format.scale = 0.25;
  UIImage *image = [[[UIGraphicsImageRenderer alloc] initWithSize:window.bounds.size format:format]
      imageWithActions:^(UIGraphicsImageRendererContext *context) {
        [window drawViewHierarchyInRect:window.bounds afterScreenUpdates:NO];
      }];
  CFDataRef data = CGDataProviderCopyData(CGImageGetDataProvider(image.CGImage));
  const uint8_t *bytes = CFDataGetBytePtr(data);
  uint64_t hash = 14695981039346656037ULL;
  for (CFIndex index = 0; index < CFDataGetLength(data); index += 1) {
    hash = SMLMix(hash, bytes[index]);
  }
  CFRelease(data);
  return hash;
}

// The device preset is the window's size. Size restrictions stop a drag, but not full screen or zoom, which
// Catalyst offers on every window: off, with the green button greyed out.
static void SMLLockWindowSize(void) {
  id application = ((id (*)(id, SEL))objc_msgSend)(NSClassFromString(@"NSApplication"), NSSelectorFromString(@"sharedApplication"));
  for (id window in ((NSArray * (*)(id, SEL)) objc_msgSend)(application, NSSelectorFromString(@"windows"))) {
    if (![NSStringFromClass([window class]) isEqualToString:@"UINSWindow"]) {
      continue;
    }
    // NSWindowCollectionBehaviorFullScreenPrimary and Auxiliary off, FullScreenNone on.
    NSUInteger behavior = ((NSUInteger (*)(id, SEL))objc_msgSend)(window, NSSelectorFromString(@"collectionBehavior"));
    behavior = (behavior & ~((NSUInteger)(1 << 7) | (1 << 8))) | (1 << 9);
    ((void (*)(id, SEL, NSUInteger))objc_msgSend)(window, NSSelectorFromString(@"setCollectionBehavior:"), behavior);
    // NSWindowStyleMaskResizable, which also makes the zoom button and a title bar double-click resize the window.
    NSUInteger style = ((NSUInteger (*)(id, SEL))objc_msgSend)(window, NSSelectorFromString(@"styleMask"));
    ((void (*)(id, SEL, NSUInteger))objc_msgSend)(window, NSSelectorFromString(@"setStyleMask:"), style & ~(NSUInteger)(1 << 3));
    // NSWindowZoomButton.
    id zoom = ((id (*)(id, SEL, NSUInteger))objc_msgSend)(window, NSSelectorFromString(@"standardWindowButton:"), 2);
    ((void (*)(id, SEL, BOOL))objc_msgSend)(zoom, NSSelectorFromString(@"setEnabled:"), NO);
  }
}

// Catalyst draws an iPad-idiom app at 77% of its size on a Mac: UINSSceneViewController hands that factor to both
// of these when it makes the window. A window that stands in for a phone shows it at the phone's size.
static void SMLDrawScenesAtFullSize(void) {
  NSArray<NSArray<NSString *> *> *setters = @[
    @[ @"UINSSceneView", @"setFixedSceneToSceneViewScaleFactor:" ],
    @[ @"UINSSceneContainerView", @"setSceneToSceneViewScaleForLayout:" ],
  ];
  for (NSArray<NSString *> *pair in setters) {
    SEL selector = NSSelectorFromString(pair[1]);
    Method method = class_getInstanceMethod(NSClassFromString(pair[0]), selector);
    if (method == NULL) {
      fprintf(stderr, "simless: -[%s %s] is gone, so the window shows the app at 77%%\n", pair[0].UTF8String,
              pair[1].UTF8String);
      continue;
    }
    void (*original)(id, SEL, double) = (void (*)(id, SEL, double))method_getImplementation(method);
    method_setImplementation(method, imp_implementationWithBlock(^(id receiver, double factor) {
                               original(receiver, selector, 1.0);
                             }));
  }
}

@implementation SMLCapture

+ (SMLPlan *)loadPlan {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger index = [arguments indexOfObject:@"--plan"];
  if (index == NSNotFound || index + 1 >= arguments.count) {
    SMLFail(@"usage: <host> --plan <plan.json>");
  }
  NSData *data = [NSData dataWithContentsOfFile:arguments[index + 1]];
  if (data == nil) {
    SMLFail([NSString stringWithFormat:@"cannot read plan %@", arguments[index + 1]]);
  }
  NSError *error = nil;
  NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![json isKindOfClass:NSDictionary.class]) {
    SMLFail([NSString stringWithFormat:@"plan is not a JSON object: %@", error.localizedDescription]);
  }
  gPlan = [[SMLPlan alloc] initWithDictionary:json];
  gResults = [NSMutableArray array];
  gJobLogs = [NSMutableArray array];
  return gPlan;
}

+ (SMLPlan *)plan {
  return gPlan;
}

+ (void)prepareProcess {
  SMLJob *first = gPlan.jobs.firstObject ?: [self jobWithIdentifier:@"template" options:@{@"name" : @"template"}];
  SMLFakeScreen(first.size, first.scale);
  SMLFakeDisplayCorners(first.cornerRadius);
  SMLRegisterFonts(gPlan.fonts);
  SMLGreenSwitches();
  SMLPresentInWindow();
  SMLHideSheetRims();
  if (gPlan.interactive) {
    SMLDrawScenesAtFullSize();
    return;
  }
  SMLKeepAppKitWindowsHidden();
  // A snapshot wants where an animated change ends up. UIView animations (a sheet sliding up, iOS 26's scroll edge
  // effect fading) also run on UIViewPropertyAnimator, whose completion needs a window that is on screen; without it
  // one can stop part-way and stay there. With them off, each change lands at its final value at once.
  [UIView setAnimationsEnabled:NO];
  SMLKeepScrubbedAnimators();
}

+ (void)whenSceneIsActive:(void (^)(void))block {
  CFTimeInterval start = CACurrentMediaTime();
  [NSTimer scheduledTimerWithTimeInterval:1.0 / 60.0
                                  repeats:YES
                                    block:^(NSTimer *timer) {
                                      BOOL active = NO;
                                      for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                                        active = active || scene.activationState == UISceneActivationStateForegroundActive;
                                      }
                                      if (active || CACurrentMediaTime() - start > 2) {
                                        [timer invalidate];
                                        block();
                                      }
                                    }];
}

+ (UIWindow *)makeWindowForJob:(SMLJob *)job rootViewController:(UIViewController *)root {
  UIWindowScene *scene = nil;
  for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes) {
    if ([candidate isKindOfClass:UIWindowScene.class]) {
      scene = (UIWindowScene *)candidate;
      break;
    }
  }
  CGRect frame = CGRectMake(0, 0, job.size.width, job.size.height);
  if (gPlan.interactive && scene != nil) {
    // The Mac window is the device's screen: its size, and no title bar over the status bar.
    scene.sizeRestrictions.minimumSize = job.size;
    scene.sizeRestrictions.maximumSize = job.size;
    scene.title = job.name;
#if TARGET_OS_MACCATALYST
    scene.titlebar.titleVisibility = UITitlebarTitleVisibilityHidden;
    scene.titlebar.toolbar = nil;
#endif
  }
  UIWindow *window = scene != nil ? [[UIWindow alloc] initWithWindowScene:scene] : [[UIWindow alloc] initWithFrame:frame];
  window.frame = frame;
  BOOL phone = job.size.width < 600;
  window.traitOverrides.userInterfaceIdiom = phone ? UIUserInterfaceIdiomPhone : UIUserInterfaceIdiomPad;
  window.traitOverrides.horizontalSizeClass = phone ? UIUserInterfaceSizeClassCompact : UIUserInterfaceSizeClassRegular;
  window.traitOverrides.verticalSizeClass = UIUserInterfaceSizeClassRegular;
  window.traitOverrides.displayScale = job.scale;
  window.traitOverrides.userInterfaceStyle = job.style;
  // Catalyst marks the traits of a window that is not key inactive, and tinted controls (glass prominent buttons)
  // then draw desaturated. An iPhone's window is always active.
  window.traitOverrides.activeAppearance = UIUserInterfaceActiveAppearanceActive;
  window.overrideUserInterfaceStyle = job.style;
  // A Catalyst window that is not key dims every tint to gray, which no iPhone ever shows.
  window.tintAdjustmentMode = UIViewTintAdjustmentModeNormal;
  window.backgroundColor = job.background ?: UIColor.systemBackgroundColor;
  window.rootViewController = root;
  [window makeKeyAndVisible];
  if (gPlan.interactive) {
    SMLLockWindowSize();
  }
  [window layoutIfNeeded];
  // A Catalyst window has an inset of its own, the Mac title bar's, which additionalSafeAreaInsets adds to; it is
  // taken off so the safe area is the device's alone.
  UIEdgeInsets own = window.safeAreaInsets;
  root.additionalSafeAreaInsets = UIEdgeInsetsMake(job.safeArea.top - own.top, job.safeArea.left - own.left,
                                                   job.safeArea.bottom - own.bottom, job.safeArea.right - own.right);
  [window layoutIfNeeded];
  return window;
}

+ (void)waitUntilSettled:(UIWindow *)window job:(SMLJob *)job completion:(void (^)(BOOL settled))completion {
  CFTimeInterval start = CACurrentMediaTime();
  __block uint64_t lastTree = 0;
  __block uint64_t lastPixels = 0;
  __block CFTimeInterval treeStableSince = start;
  __block CFTimeInterval pixelsStableSince = start;
  __block BOOL done = NO;
  BOOL dumping = getenv("SIMLESS_DUMP_TREE") != NULL;
  __block NSDictionary<NSValue *, NSString *> *lastStates = nil;
  __block NSMutableArray<NSString *> *lastChanges = [NSMutableArray array];
  [NSTimer scheduledTimerWithTimeInterval:1.0 / 60.0
                                  repeats:YES
                                    block:^(NSTimer *timer) {
                                      if (done) {
                                        return;
                                      }
                                      [window layoutIfNeeded];
                                      [CATransaction flush];
                                      CFTimeInterval now = CACurrentMediaTime();
                                      uint64_t tree = SMLFingerprint(window.layer, 14695981039346656037ULL);
                                      if (dumping) {
                                        NSMutableDictionary *states = [NSMutableDictionary dictionary];
                                        SMLLayerStates(window.layer, window, window, states);
                                        NSMutableArray *changes = [NSMutableArray array];
                                        [states enumerateKeysAndObjectsUsingBlock:^(NSValue *key, NSString *now, BOOL *stop) {
                                          NSString *before = lastStates[key];
                                          if (before != nil && ![before isEqualToString:now]) {
                                            [changes addObject:[NSString stringWithFormat:@"%@\n      was %@", now, before]];
                                          }
                                        }];
                                        if (changes.count > 0) {
                                          lastChanges = changes;
                                        }
                                        lastStates = states;
                                      }
                                      if (tree != lastTree || SMLIsAnimating(window.layer)) {
                                        lastTree = tree;
                                        treeStableSince = now;
                                      }
                                      BOOL treeSettled = now - treeStableSince >= job.settle;
                                      BOOL pixelsSettled = YES;
                                      if (SMLContainsMetal(window.layer)) {
                                        uint64_t pixels = SMLPixelDigest(window);
                                        if (pixels != lastPixels) {
                                          lastPixels = pixels;
                                          pixelsStableSince = now;
                                        }
                                        // A canvas that animates for good never holds still; it is captured as it
                                        // is once the rest has settled and the render has had the grace period.
                                        // Counted from the start, not from the tree settling: a ticking clock on
                                        // screen (a tapped-out timer) changes the tree every second.
                                        pixelsSettled = now - pixelsStableSince >= job.settle ||
                                                        (treeSettled && now - start >= job.settle + SMLMetalGrace);
                                      }
                                      BOOL settled = treeSettled && pixelsSettled;
                                      if (settled || now - start >= job.timeout) {
                                        if (!settled && getenv("SIMLESS_DUMP_TREE") != NULL) {
                                          fprintf(stderr, "not settled: tree changed %.2fs ago, pixels %.2fs ago\n",
                                                  now - treeStableSince, now - pixelsStableSince);
                                          SMLDumpAnimations(window.layer, window);
                                          for (NSString *change in lastChanges) {
                                            fprintf(stderr, "moved: %s\n", change.UTF8String);
                                          }
                                        }
                                        done = YES;
                                        [timer invalidate];
                                        completion(settled);
                                      }
                                    }];
}

// SIMLESS_DUMP_TREE=1 prints every window in the scene and its view tree at capture, to see where UIKit put a view.
static void SMLDumpInsets(UIView *view, int depth) {
  UIEdgeInsets insets = view.safeAreaInsets;
  NSString *name = NSStringFromClass(view.class);
  if ([name containsString:@"NavigationBar"] || [name containsString:@"Screen"] || [name containsString:@"RootView"] || depth < 3) {
    CGRect frame = [view convertRect:view.bounds toView:nil];
    fprintf(stderr, "insets %*s%s frame y %.1f h %.1f safe top %.1f bottom %.1f\n", depth * 2, "", name.UTF8String,
            frame.origin.y, frame.size.height, insets.top, insets.bottom);
  }
  for (UIView *subview in view.subviews) {
    SMLDumpInsets(subview, depth + 1);
  }
}

// With SIMLESS_DUMP_TREE, every view that rounds or clips its corners: where a sheet's corner comes from.
static void SMLDumpCorners(UIView *view, UIWindow *window, int depth) {
  CALayer *layer = view.layer;
  double radii[8] = {0};
  id value = [layer respondsToSelector:NSSelectorFromString(@"cornerRadii")] ? [layer valueForKey:@"cornerRadii"] : nil;
  if ([value isKindOfClass:NSValue.class]) {
    [(NSValue *)value getValue:radii size:sizeof(radii)];
  }
  BOOL rounded = layer.cornerRadius > 0 || radii[0] > 0 || radii[4] > 0;
  BOOL screen = [NSStringFromClass(view.class) hasPrefix:@"RNS"] || [NSStringFromClass(view.class) containsString:@"SDF"];
  if (rounded || layer.mask != nil || screen) {
    CGRect frame = [view convertRect:view.bounds toView:window];
    CGFloat alpha = 0;
    [view.backgroundColor getRed:NULL green:NULL blue:NULL alpha:&alpha];
    fprintf(stderr, "corners %*s%s %.1f,%.1f %.1fx%.1f radius %.1f radii %.1f/%.1f clips %d mask %d background %.2f\n",
            depth, "", class_getName(view.class), frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
            layer.cornerRadius, radii[0], radii[4], view.clipsToBounds, layer.mask != nil, alpha);
  }
  // A glass element copies its shape from another layer through match animations; say which, and what it holds.
  for (NSString *key in layer.animationKeys) {
    CAAnimation *animation = [layer animationForKey:key];
    if (![key hasPrefix:@"match-"] || ![animation respondsToSelector:NSSelectorFromString(@"sourceLayer")]) {
      continue;
    }
    CALayer *source = [animation valueForKey:@"sourceLayer"];
    double sourceRadii[8] = {0};
    id sourceValue = [source respondsToSelector:NSSelectorFromString(@"cornerRadii")] ? [source valueForKey:@"cornerRadii"] : nil;
    if ([sourceValue isKindOfClass:NSValue.class]) {
      [(NSValue *)sourceValue getValue:sourceRadii size:sizeof(sourceRadii)];
    }
    CGRect sourceFrame = source ? [window.layer convertRect:source.bounds fromLayer:source] : CGRectZero;
    fprintf(stderr, "corners %*s  %s matches %s (of %s) %.1f,%.1f %.1fx%.1f radius %.1f radii %.1f/%.1f\n", depth, "",
            key.UTF8String, class_getName(source.class),
            class_getName([source.delegate isKindOfClass:NSObject.class] ? [(id)source.delegate class] : source.class),
            sourceFrame.origin.x, sourceFrame.origin.y, sourceFrame.size.width, sourceFrame.size.height,
            source.cornerRadius, sourceRadii[0], sourceRadii[4]);
  }
  for (UIView *subview in view.subviews) {
    SMLDumpCorners(subview, window, depth + 1);
  }
}

// With SIMLESS_DUMP_TREE, the glass layers (SDF shapes, backdrops), which are no view's subviews, with their shape.
static void SMLDumpGlassLayers(CALayer *layer, UIWindow *window, int depth) {
  NSString *name = NSStringFromClass(layer.class);
  if ([name containsString:@"SDF"] || [name containsString:@"Backdrop"] || [name containsString:@"Portal"]) {
    double radii[8] = {0};
    id value = [layer respondsToSelector:NSSelectorFromString(@"cornerRadii")] ? [layer valueForKey:@"cornerRadii"] : nil;
    if ([value isKindOfClass:NSValue.class]) {
      [(NSValue *)value getValue:radii size:sizeof(radii)];
    }
    CGRect frame = [window.layer convertRect:layer.bounds fromLayer:layer];
    fprintf(stderr, "glass %*s%s (%s) %.1f,%.1f %.1fx%.1f radius %.1f radii %.1f/%.1f/%.1f/%.1f keys %s\n", depth, "",
            name.UTF8String, class_getName([(NSObject *)layer.delegate class]), frame.origin.x, frame.origin.y,
            frame.size.width, frame.size.height, layer.cornerRadius, radii[0], radii[2], radii[4], radii[6],
            [[layer.animationKeys componentsJoinedByString:@","] UTF8String] ?: "");
    for (NSString *key in layer.animationKeys) {
      CAAnimation *animation = [layer animationForKey:key];
      if (![key hasPrefix:@"match-corner"] || ![animation respondsToSelector:NSSelectorFromString(@"sourceLayer")]) {
        continue;
      }
      CALayer *source = [animation valueForKey:@"sourceLayer"];
      double sourceRadii[8] = {0};
      id sourceValue = [source respondsToSelector:NSSelectorFromString(@"cornerRadii")] ? [source valueForKey:@"cornerRadii"] : nil;
      if ([sourceValue isKindOfClass:NSValue.class]) {
        [(NSValue *)sourceValue getValue:sourceRadii size:sizeof(sourceRadii)];
      }
      CGRect sourceFrame = source ? [window.layer convertRect:source.bounds fromLayer:source] : CGRectZero;
      fprintf(stderr, "glass %*s  %s matches %s (%s) %.1f,%.1f %.1fx%.1f radius %.1f radii %.1f/%.1f/%.1f/%.1f\n", depth,
              "", key.UTF8String, class_getName(source.class), class_getName([(NSObject *)source.delegate class]),
              sourceFrame.origin.x, sourceFrame.origin.y, sourceFrame.size.width, sourceFrame.size.height,
              source.cornerRadius, sourceRadii[0], sourceRadii[2], sourceRadii[4], sourceRadii[6]);
    }
  }
  for (CALayer *sublayer in layer.sublayers) {
    SMLDumpGlassLayers(sublayer, window, depth + 1);
  }
}

// With SIMLESS_DUMP_TREE, the layers that make up a presented sheet, down to the first React Native view.
static void SMLDumpSheetLayers(CALayer *layer, UIWindow *window, int depth) {
  NSString *owner = NSStringFromClass([(NSObject *)layer.delegate class]);
  if ([owner hasPrefix:@"RCT"] || [owner hasPrefix:@"RNS"]) {
    return;
  }
  double radii[8] = {0};
  id value = [layer respondsToSelector:NSSelectorFromString(@"cornerRadii")] ? [layer valueForKey:@"cornerRadii"] : nil;
  if ([value isKindOfClass:NSValue.class]) {
    [(NSValue *)value getValue:radii size:sizeof(radii)];
  }
  CGFloat alpha = layer.backgroundColor ? CGColorGetAlpha(layer.backgroundColor) : 0;
  CGRect frame = [window.layer convertRect:layer.bounds fromLayer:layer];
  fprintf(stderr, "sheet %*s%s (%s) %.1f,%.1f %.1fx%.1f radius %.1f radii %.1f/%.1f clips %d background %.2f "
                  "shadow %.2f r %.1f path %d contents %d filters %lu\n",
          depth, "", class_getName(layer.class), owner.UTF8String, frame.origin.x, frame.origin.y, frame.size.width,
          frame.size.height, layer.cornerRadius, radii[0], radii[4], layer.masksToBounds, alpha, layer.shadowOpacity,
          layer.shadowRadius, layer.shadowPath != NULL, layer.contents != nil, (unsigned long)layer.filters.count);
  for (CALayer *sublayer in layer.sublayers) {
    SMLDumpSheetLayers(sublayer, window, depth + 1);
  }
}

// The first layer of `owner`'s that is smaller than the window: a presented sheet's, not a full-screen one.
static CALayer *_Nullable SMLFindLayerOf(CALayer *layer, NSString *owner, UIWindow *window) {
  if ([NSStringFromClass([(NSObject *)layer.delegate class]) isEqualToString:owner] &&
      [window.layer convertRect:layer.bounds fromLayer:layer].size.width < window.bounds.size.width) {
    return layer;
  }
  for (CALayer *sublayer in layer.sublayers) {
    CALayer *found = SMLFindLayerOf(sublayer, owner, window);
    if (found != nil) {
      return found;
    }
  }
  return nil;
}

static void SMLDumpTree(UIWindow *window) {
  CALayer *sheet = SMLFindLayerOf(window.layer, @"UIDropShadowView", window);
  if (sheet != nil) {
    SMLDumpSheetLayers(sheet, window, 0);
  }
  SMLDumpGlassLayers(window.layer, window, 0);
  SMLDumpCorners(window, window, 0);
  fprintf(stderr, "insets window safe top %.1f, root additional top %.1f\n", window.safeAreaInsets.top,
          window.rootViewController.additionalSafeAreaInsets.top);
  SMLDumpInsets(window, 0);
  for (UIWindow *candidate in window.windowScene.windows) {
    NSString *tree = [candidate performSelector:NSSelectorFromString(@"recursiveDescription")];
    fprintf(stderr, "== window %p%s level %.0f hidden %d\n%s\n", (__bridge void *)candidate,
            candidate == window ? " (captured)" : "", candidate.windowLevel, candidate.hidden, tree.UTF8String);
  }
}

// An InputAccessoryView belongs above the keyboard, and a render never has one up; until a text input claims it,
// React Native leaves it drawn in place, a bar over whatever is under it. Hidden at capture, because Fabric sets
// `hidden` again on every layout pass.
static void SMLHideInputAccessories(UIView *view) {
  if ([NSStringFromClass(view.class) containsString:@"InputAccessory"]) {
    view.hidden = YES;
    return;
  }
  for (UIView *subview in view.subviews) {
    SMLHideInputAccessories(subview);
  }
}

// SIMLESS_HIDE_LAYERS=CASDFLayer,CAPortalLayer hides every layer of those classes before the capture, to find which
// layer draws something.
static void SMLHideLayers(CALayer *layer, NSArray<NSString *> *classes) {
  if ([classes containsObject:NSStringFromClass(layer.class)] ||
      [classes containsObject:NSStringFromClass([(NSObject *)layer.delegate class])]) {
    layer.hidden = YES;
  }
  for (CALayer *sublayer in layer.sublayers) {
    SMLHideLayers(sublayer, classes);
  }
}

+ (BOOL)writePNGOfWindow:(UIWindow *)window job:(SMLJob *)job error:(NSError **)error {
  return [self writePNGOfWindow:window job:job path:job.outputPath error:error];
}

+ (NSString *)framePathForJob:(SMLJob *)job milliseconds:(double)milliseconds {
  NSString *base = job.outputPath.stringByDeletingPathExtension;
  return [NSString stringWithFormat:@"%@-%lldms.png", base, llround(milliseconds)];
}

+ (BOOL)writePNGOfWindow:(UIWindow *)window job:(SMLJob *)job path:(NSString *)path error:(NSError **)error {
  const char *hide = getenv("SIMLESS_HIDE_LAYERS");
  if (hide != NULL) {
    SMLHideLayers(window.layer, [@(hide) componentsSeparatedByString:@","]);
  }
  // Set again: something in the app may have changed it since the window was made (expo-system-ui paints windows
  // from the app config), and the background belongs to the job.
  window.backgroundColor = job.background ?: UIColor.systemBackgroundColor;
  [window layoutIfNeeded];
  SMLHideInputAccessories(window);
  SMLSteadyTextCursors(window);
  if (getenv("SIMLESS_DUMP_TREE") != NULL) {
    SMLDumpTree(window);
  }
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat formatForTraitCollection:window.traitCollection];
  format.scale = job.scale;
  format.preferredRange = UIGraphicsImageRendererFormatRangeStandard;
  CGFloat alpha = 1;
  [window.backgroundColor getRed:NULL green:NULL blue:NULL alpha:&alpha];
  format.opaque = alpha >= 1;
  CGSize size = job.size;
  if (job.fit) {
    // What the host measured (the root's layout, or SwiftUI's fitting size) is a floor: absolutely positioned
    // and overflowing children reach below it.
    CGFloat drawn = SMLContentBottom(window, window) + job.padding;
    CGFloat height = MAX(job.contentHeight, drawn);
    if (height > 0) {
      size.height = MIN(ceil(height), job.size.height);
    }
  }
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
  UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    // drawViewHierarchy is the only path that draws UISwitch knobs and other render-server-backed layers.
    if (![window drawViewHierarchyInRect:window.bounds afterScreenUpdates:YES]) {
      [window.layer renderInContext:context.CGContext];
    }
  }];
  NSData *png = UIImagePNGRepresentation(image);
  NSString *directory = path.stringByDeletingLastPathComponent;
  if (![NSFileManager.defaultManager createDirectoryAtPath:directory
                               withIntermediateDirectories:YES
                                                attributes:nil
                                                     error:error]) {
    return NO;
  }
  return [png writeToFile:path options:NSDataWritingAtomic error:error];
}

+ (CGFloat)drawnBottomOfWindow:(UIWindow *)window {
  return SMLContentBottom(window, window);
}

+ (BOOL)windowContainsMetal:(UIWindow *)window {
  return SMLContainsMetal(window.layer);
}

+ (void)tearDownWindow:(UIWindow *)window {
  window.hidden = YES;
  window.rootViewController = nil;
  window.windowScene = nil;
}

+ (void)reportDeviceIdiom {
  SMLJob *first = gPlan.jobs.firstObject ?: [self jobWithIdentifier:@"template" options:@{@"name" : @"template"}];
  UIUserInterfaceIdiom idiom = first.size.width < 600 ? UIUserInterfaceIdiomPhone : UIUserInterfaceIdiomPad;
  method_setImplementation(class_getInstanceMethod(UIDevice.class, @selector(userInterfaceIdiom)),
                           imp_implementationWithBlock(^UIUserInterfaceIdiom(id receiver) {
                             return idiom;
                           }));
}

+ (void)activateApp {
  id application = ((id (*)(id, SEL))objc_msgSend)(NSClassFromString(@"NSApplication"), NSSelectorFromString(@"sharedApplication"));
  if (application == nil) {
    return;
  }
  // The host's Info.plist says LSBackgroundOnly, which keeps a capture from ever taking focus; 0 is
  // NSApplicationActivationPolicyRegular.
  ((BOOL (*)(id, SEL, NSInteger))objc_msgSend)(application, NSSelectorFromString(@"setActivationPolicy:"), 0);
  ((void (*)(id, SEL, BOOL))objc_msgSend)(application, NSSelectorFromString(@"activateIgnoringOtherApps:"), YES);
}

+ (SMLJob *)jobWithIdentifier:(NSString *)identifier options:(NSDictionary *)options {
  NSMutableDictionary *merged = [gPlan.renderTemplate mutableCopy] ?: [NSMutableDictionary dictionary];
  [options enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
    if (value != NSNull.null) {
      merged[key] = value;
    }
  }];
  merged[@"id"] = identifier;
  NSString *pattern = [merged[@"output"] isKindOfClass:NSString.class] ? merged[@"output"] : @"{name}.png";
  merged[@"output"] = [pattern stringByReplacingOccurrencesOfString:@"{name}" withString:merged[@"name"] ?: identifier];
  // A component cropped to its content is not on a screen, so it gets no status bar or home indicator inset.
  if ([merged[@"fit"] boolValue]) {
    merged[@"safeArea"] = @{@"top" : @0, @"left" : @0, @"bottom" : @0, @"right" : @0};
  }
  return [[SMLJob alloc] initWithDictionary:merged];
}

+ (void)startJob:(SMLJob *)job {
  [gJobLogs removeAllObjects];
  gJobStart = CACurrentMediaTime();
}

+ (void)log:(NSString *)line {
  // A shown render is never reported, and a session can log for hours.
  if (!gPlan.interactive) {
    [gJobLogs addObject:line];
  }
  BOOL problem = [line hasPrefix:@"[warn]"] || [line hasPrefix:@"[error]"] || [line hasPrefix:@"[fatal]"];
  if (gPlan.verbose || (gPlan.interactive && problem)) {
    fprintf(stderr, "%s\n", line.UTF8String);
  }
}

+ (void)finishJob:(SMLJob *)job error:(NSString *)error settled:(BOOL)settled {
  NSMutableDictionary *result = [@{
    @"id" : job.identifier,
    @"name" : job.name,
    @"output" : job.outputPath,
    @"ok" : (error == nil ? @YES : @NO),
    @"settled" : (settled ? @YES : @NO),
    @"durationMs" : @(llround((CACurrentMediaTime() - gJobStart) * 1000)),
    @"logs" : [gJobLogs copy],
  } mutableCopy];
  if (job.capturedFrames.count > 0) {
    result[@"frames"] = [job.capturedFrames copy];
  }
  if (error != nil) {
    result[@"error"] = error;
  }
  [gResults addObject:result];
}

+ (void)finish {
  [self finishScript:@{}];
}

+ (void)finishScript:(NSDictionary *)script {
  // A shown render never resolves, so a script that ends showed nothing. The window stays, with what it says.
  if (gPlan.interactive) {
    NSString *error = [script[@"error"] isKindOfClass:NSString.class] ? script[@"error"] : nil;
    NSArray *names = [script[@"names"] isKindOfClass:NSArray.class] ? script[@"names"] : @[];
    NSString *message = error != nil ? [@"the script stopped: " stringByAppendingString:error]
                                     : [NSString stringWithFormat:@"no render to show. The script's renders: %@",
                                                                  names.count > 0 ? [names componentsJoinedByString:@", "] : @"none"];
    fprintf(stderr, "simless: %s\n", message.UTF8String);
    return;
  }
  NSMutableDictionary *result = [script mutableCopy];
  result[@"jobs"] = gResults;
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  [data writeToFile:gPlan.resultPath atomically:YES];
  exit(0);
}

@end
