#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

// One render: a view, a device, an appearance, and where the PNG goes. Read from the plan file the CLI writes, or
// made from the plan's template when a render script asks for one.
@interface SMLJob : NSObject
@property (nonatomic, copy, readonly) NSString *identifier;
@property (nonatomic, copy, readonly) NSString *name;
@property (nonatomic, copy, readonly) NSString *outputPath;
@property (nonatomic, copy, readonly) NSString *component;
@property (nonatomic, copy, readonly) NSDictionary *props;
@property (nonatomic, readonly) CGSize size;
@property (nonatomic, readonly) CGFloat scale;
@property (nonatomic, readonly) UIEdgeInsets safeArea;
@property (nonatomic, readonly) CGFloat cornerRadius;
@property (nonatomic, readonly) UIUserInterfaceStyle style;
@property (nonatomic, strong, readonly, nullable) UIColor *background;
@property (nonatomic, readonly) NSTimeInterval settle;
@property (nonatomic, readonly) NSTimeInterval timeout;
// Crop the PNG to the content's height instead of the whole screen; the host measures it and sets contentHeight.
@property (nonatomic, readonly) BOOL fit;
@property (nonatomic, readonly) CGFloat padding;
@property (nonatomic) CGFloat contentHeight;
// Milliseconds after the render is ready at which to write a PNG each, before the settled one: a filmstrip of an
// animation. The paths written, in order, are kept in capturedFrames.
@property (nonatomic, copy, readonly) NSArray<NSNumber *> *frames;
@property (nonatomic, strong, readonly) NSMutableArray<NSString *> *capturedFrames;
// What the JS side receives as the root component's props.
@property (nonatomic, copy, readonly) NSDictionary *initialProperties;
@end

@interface SMLPlan : NSObject
@property (nonatomic, copy, readonly) NSArray<SMLJob *> *jobs;
// For a render script: what every render it asks for shares (device, appearance, defaults, and the output path
// with `{name}` in it), and which of its renders this process performs. Both nil for a plan of jobs.
@property (nonatomic, copy, readonly, nullable) NSDictionary *renderTemplate;
@property (nonatomic, copy, readonly, nullable) NSString *selection;
@property (nonatomic, copy, readonly) NSString *resultPath;
@property (nonatomic, copy, readonly, nullable) NSString *bundlePath;
@property (nonatomic, copy, readonly) NSArray<NSString *> *fonts;
@property (nonatomic, readonly) BOOL verbose;
// A BCP 47 tag such as nl-NL, or nil for the system's.
@property (nonatomic, copy, readonly, nullable) NSString *locale;
// `simless show`: the render stays on screen in a window people can use, with animations, and is never captured.
@property (nonatomic, readonly) BOOL interactive;
@end

@interface SMLCapture : NSObject

// Reads `--plan <path>` from the process arguments; exits with a message when it is missing or malformed.
+ (SMLPlan *)loadPlan NS_SWIFT_NAME(loadPlan());
+ (SMLPlan *)plan NS_SWIFT_NAME(plan());

// Must run before UIApplicationMain: it registers fonts, fakes the device's screen, and keeps AppKit from
// ever showing the scene's window.
+ (void)prepareProcess NS_SWIFT_NAME(prepareProcess());

// Runs `block` once the app's window scene is foreground active, or after two seconds. Metal layers (Skia) in a
// scene that is not active yet never get a drawable, so the first job must not start before.
+ (void)whenSceneIsActive:(void (^)(void))block NS_SWIFT_NAME(whenSceneIsActive(_:));

+ (UIWindow *)makeWindowForJob:(SMLJob *)job
           rootViewController:(UIViewController *)root NS_SWIFT_NAME(makeWindow(for:rootViewController:));
+ (void)waitUntilSettled:(UIWindow *)window
                     job:(SMLJob *)job
              completion:(void (^)(BOOL settled))completion NS_SWIFT_NAME(waitUntilSettled(_:job:completion:));
+ (BOOL)writePNGOfWindow:(UIWindow *)window job:(SMLJob *)job error:(NSError **)error NS_SWIFT_NAME(writePNG(of:job:));
+ (BOOL)writePNGOfWindow:(UIWindow *)window
                     job:(SMLJob *)job
                    path:(NSString *)path
                   error:(NSError **)error NS_SWIFT_NAME(writePNG(of:job:path:));
// Where the frame `milliseconds` after ready goes: next to the job's PNG, with the offset in its name.
+ (NSString *)framePathForJob:(SMLJob *)job milliseconds:(double)milliseconds;
+ (void)tearDownWindow:(UIWindow *)window NS_SWIFT_NAME(tearDownWindow(_:));
// Makes UIDevice report the device preset's idiom, as the window's traits already do. Call once UIKit has set up
// its scene, which it does as an iPad on a Mac, and before React Native reads Platform.isPad.
+ (void)reportDeviceIdiom;
// For an interactive plan: makes the host a regular app (Dock, menu bar, Cmd-Q) and brings its window to the front.
+ (void)activateApp;
+ (BOOL)windowContainsMetal:(UIWindow *)window NS_SWIFT_NAME(windowContainsMetal(_:));
// The lowest edge of any UIView in the window that draws, 0 when none does. SwiftUI draws into layers inside its
// hosting view, which this does not see.
+ (CGFloat)drawnBottomOfWindow:(UIWindow *)window;

// A job for one render a script asked for: the plan's template with the render's own options over it.
+ (SMLJob *)jobWithIdentifier:(NSString *)identifier options:(NSDictionary *)options;
+ (void)startJob:(SMLJob *)job NS_SWIFT_NAME(start(_:));
+ (void)log:(NSString *)line NS_SWIFT_NAME(log(_:));
+ (void)finishJob:(SMLJob *)job
            error:(nullable NSString *)error
          settled:(BOOL)settled NS_SWIFT_NAME(finish(_:error:settled:));
// Writes the result file and exits the process.
+ (void)finish NS_SWIFT_NAME(finish());
// The same, with what the script reported: the name of every render it asked for, and the error it stopped on.
+ (void)finishScript:(NSDictionary *)script;

@end

NS_ASSUME_NONNULL_END
