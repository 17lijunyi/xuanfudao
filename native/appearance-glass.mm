// Native, input-transparent background blur for the glass appearance presets.
// Only validated NSViews owned by NSApp may be used. No raw handle is messaged.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>
#import <objc/message.h>

// Runtime-only Core Animation capability. Unlike a window-wide blur radius,
// this layer is a child of the rounded glass mask, including during animation.
static bool DesktopBlurAvailable() {
  if (std::getenv("FUDAO_DISABLE_NATIVE_BACKGROUND_BLUR")) return false;
  Class backdrop = NSClassFromString(@"CABackdropLayer");
  Class filter = NSClassFromString(@"CAFilter");
  return [backdrop isSubclassOfClass:[CALayer class]] &&
    [backdrop instancesRespondToSelector:NSSelectorFromString(@"setWindowServerAware:")] &&
    [backdrop instancesRespondToSelector:NSSelectorFromString(@"setScale:")] &&
    [filter respondsToSelector:NSSelectorFromString(@"filterWithType:")];
}

@interface FudaoAppearanceBackdropView : NSVisualEffectView
@end
@implementation FudaoAppearanceBackdropView
- (BOOL)isFlipped { return YES; }
@end

@interface FudaoAppearanceGlassView : NSView
@property(nonatomic) NSInteger regionSlot;
@property(nonatomic, strong) CAShapeLayer *glassMask;
@property(nonatomic, copy) NSArray<NSNumber *> *glassRadii;
@property(nonatomic, strong) FudaoAppearanceBackdropView *backdropView;
@property(nonatomic) NSInteger backgroundBlurRadius;
@property(nonatomic, strong) CALayer *desktopBlur;
@property(nonatomic) BOOL backgroundBlurFailed;
@end
@implementation FudaoAppearanceGlassView
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return NO; }
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end

// A failed or missing optional API falls back to the masked system material.
// Never use a window-wide blur fallback: it leaves rectangular corner ghosts.
static void UpdateDesktopBlur(FudaoAppearanceGlassView *effect, NSInteger radius, CGFloat scale) {
  if (effect.backgroundBlurFailed || !DesktopBlurAvailable()) return;
  @try {
    if (radius == 0) {
      [effect.desktopBlur removeFromSuperlayer];
      effect.desktopBlur = nil;
      effect.backgroundBlurRadius = 0;
      return;
    }
    if (!effect.desktopBlur) {
      CALayer *layer = [NSClassFromString(@"CABackdropLayer") layer];
      if (!layer) { effect.backgroundBlurFailed = YES; return; }
      [layer setValue:@YES forKey:@"windowServerAware"];
      [layer setValue:@1 forKey:@"scale"];
      layer.masksToBounds = YES;
      effect.desktopBlur = layer;
      [effect.layer insertSublayer:layer atIndex:0];
    }
    effect.desktopBlur.frame = effect.bounds;
    if (effect.backgroundBlurRadius != radius || effect.desktopBlur.contentsScale != scale || !effect.desktopBlur.filters.count) {
      // A fresh filter also invalidates the WindowServer presentation copy.
      id filter = ((id (*)(id, SEL, id))objc_msgSend)(NSClassFromString(@"CAFilter"),
        NSSelectorFromString(@"filterWithType:"), @"gaussianBlur");
      if (!filter) [NSException raise:@"FudaoBlurUnavailable" format:@"Missing Gaussian filter"];
      [filter setValue:@YES forKey:@"inputNormalizeEdges"];
      // Backdrop geometry and filter radius use points. contentsScale controls
      // raster resolution; dividing the radius made Retina glass twice as clear.
      [filter setValue:@(radius) forKey:@"inputRadius"];
      effect.desktopBlur.filters = @[filter];
      effect.desktopBlur.contentsScale = scale;
    }
    effect.backgroundBlurRadius = radius;
  } @catch (NSException *exception) {
    [effect.desktopBlur removeFromSuperlayer];
    effect.desktopBlur = nil;
    effect.backgroundBlurRadius = 0;
    effect.backgroundBlurFailed = YES;
  }
}

static napi_value NapiBoolean(napi_env env, bool value) {
  napi_value result; napi_get_boolean(env, value, &result); return result;
}
static napi_value Fail(napi_env env, const char *message) {
  napi_throw_type_error(env, nullptr, message); return nullptr;
}
static bool Number(napi_env env, napi_value object, const char *key, double *output, double fallback) {
  bool exists = false; napi_has_named_property(env, object, key, &exists);
  if (!exists) { *output = fallback; return true; }
  napi_value value;
  return napi_get_named_property(env, object, key, &value) == napi_ok &&
    napi_get_value_double(env, value, output) == napi_ok && std::isfinite(*output);
}
// Compare pointer values while walking valid retained Cocoa objects. Never dereference
// the caller's pointer, including after a BrowserWindow has already been destroyed.
static NSView *FindView(NSView *root, const void *pointer, unsigned depth = 0) {
  if (!root || depth > 80) return nil;
  if ((__bridge const void *)root == pointer) return root;
  for (NSView *child in root.subviews) {
    NSView *found = FindView(child, pointer, depth + 1);
    if (found) return found;
  }
  return nil;
}
static NSView *FindHandle(napi_env env, napi_value value) {
  bool isBuffer = false; void *bytes = nullptr; size_t length = 0;
  if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer ||
      napi_get_buffer_info(env, value, &bytes, &length) != napi_ok || length != sizeof(void *)) return nil;
  const void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer) return nil;
  for (NSWindow *window in NSApp.windows) {
    NSView *found = FindView(window.contentView, pointer);
    if (found) return found;
  }
  return nil;
}
static FudaoAppearanceGlassView *FindEffect(NSView *content, NSInteger slot = 0) {
  for (NSView *child in content.subviews) {
    if ([child isKindOfClass:[FudaoAppearanceGlassView class]] && ((FudaoAppearanceGlassView *)child).regionSlot == slot) return (FudaoAppearanceGlassView *)child;
  }
  return nil;
}
// This path uses top-left coordinates (the effect view is flipped).
static CGPathRef MakePath(CGFloat w, CGFloat h, const double radii[4]) {
  CGFloat tl = radii[0], tr = radii[1], br = radii[2], bl = radii[3];
  CGMutablePathRef p = CGPathCreateMutable();
  CGPathMoveToPoint(p, nullptr, tl, 0);
  CGPathAddLineToPoint(p, nullptr, w - tr, 0);
  CGPathAddArcToPoint(p, nullptr, w, 0, w, tr, tr);
  CGPathAddLineToPoint(p, nullptr, w, h - br);
  CGPathAddArcToPoint(p, nullptr, w, h, w - br, h, br);
  CGPathAddLineToPoint(p, nullptr, bl, h);
  CGPathAddArcToPoint(p, nullptr, 0, h, 0, h - bl, bl);
  CGPathAddLineToPoint(p, nullptr, 0, tl);
  CGPathAddArcToPoint(p, nullptr, 0, 0, tl, 0, tl);
  CGPathCloseSubpath(p);
  return p;
}
// Preserve hiddenInMissionControl: Stationary replaces Transient and exposes
// this utility in the desktop overview. Keep Spaces and full-screen flags intact.
static napi_value PinWindow(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Fail(env, "Native window policy requires the Electron main thread");
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSView *handle = argc ? FindHandle(env, argv[0]) : nil;
  if (!handle.window) return NapiBoolean(env, false);
  NSWindow *window = handle.window;
  window.collectionBehavior = (window.collectionBehavior & ~(NSWindowCollectionBehaviorManaged | NSWindowCollectionBehaviorStationary)) | NSWindowCollectionBehaviorTransient;
  window.animationBehavior = NSWindowAnimationBehaviorNone;
  window.hasShadow = NO;
  [window invalidateShadow];
  return NapiBoolean(env, true);
}
static napi_value InspectWindow(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Fail(env, "Native window policy requires the Electron main thread");
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSView *handle = argc ? FindHandle(env, argv[0]) : nil;
  if (!handle.window) { napi_value value; napi_get_null(env, &value); return value; }
  napi_value result; napi_create_object(env, &result);
  NSUInteger behavior = handle.window.collectionBehavior;
  napi_set_named_property(env, result, "stationary", NapiBoolean(env, (behavior & NSWindowCollectionBehaviorStationary) != 0));
  napi_set_named_property(env, result, "transient", NapiBoolean(env, (behavior & NSWindowCollectionBehaviorTransient) != 0));
  napi_set_named_property(env, result, "managed", NapiBoolean(env, (behavior & NSWindowCollectionBehaviorManaged) != 0));
  napi_set_named_property(env, result, "joinsAllSpaces", NapiBoolean(env, (behavior & NSWindowCollectionBehaviorCanJoinAllSpaces) != 0));
  napi_set_named_property(env, result, "fullscreenAuxiliary", NapiBoolean(env, (behavior & NSWindowCollectionBehaviorFullScreenAuxiliary) != 0));
  napi_set_named_property(env, result, "systemAnimationDisabled", NapiBoolean(env, handle.window.animationBehavior == NSWindowAnimationBehaviorNone));
  return result;
}
static napi_value Apply(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Fail(env, "Native appearance requires the Electron main thread");
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 2) return Fail(env, "apply requires a native handle and shape");
  NSView *handle = FindHandle(env, argv[0]);
  if (!handle || !handle.window.contentView) return NapiBoolean(env, false);
  NSView *content = handle.window.contentView;
  napi_valuetype type; napi_typeof(env, argv[1], &type);
  if (type != napi_object) return Fail(env, "shape must be an object");
  double x, y, width, height, opacity, backgroundBlurRadius, slot;
  if (!Number(env, argv[1], "x", &x, 0) || !Number(env, argv[1], "y", &y, 0) ||
      !Number(env, argv[1], "width", &width, 0) || !Number(env, argv[1], "height", &height, 0) ||
      !Number(env, argv[1], "opacity", &opacity, 1) ||
      !Number(env, argv[1], "slot", &slot, 0) || slot < 0 || slot > 1 || std::floor(slot) != slot ||
      !Number(env, argv[1], "backgroundBlurRadius", &backgroundBlurRadius, 0) ||
      backgroundBlurRadius < 0 || backgroundBlurRadius > 32 || std::floor(backgroundBlurRadius) != backgroundBlurRadius ||
      x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > NSWidth(content.bounds) + 1 || y + height > NSHeight(content.bounds) + 1 || opacity < 0 || opacity > 1)
    return Fail(env, "shape must fit inside its native window");
  double radii[4] = {0, 0, 0, 0};
  bool hasRadii = false; napi_has_named_property(env, argv[1], "radii", &hasRadii);
  if (hasRadii) {
    napi_value values; bool array = false; uint32_t length = 0;
    napi_get_named_property(env, argv[1], "radii", &values);
    if (napi_is_array(env, values, &array) != napi_ok || !array ||
        napi_get_array_length(env, values, &length) != napi_ok || length != 4)
      return Fail(env, "radii must contain TL, TR, BR and BL");
    for (uint32_t i = 0; i < 4; i++) {
      napi_value value; napi_get_element(env, values, i, &value);
      if (napi_get_value_double(env, value, &radii[i]) != napi_ok || !std::isfinite(radii[i]) || radii[i] < 0)
        return Fail(env, "invalid corner radius");
    }
  }
  // Match CSS's proportional overlap reduction, including bottom-only corners
  // which may be larger than half the height of the collapsed island.
  double factor = 1;
  const double sums[4] = {radii[0] + radii[1], radii[3] + radii[2], radii[0] + radii[3], radii[1] + radii[2]};
  const double edges[4] = {width, width, height, height};
  for (int i = 0; i < 4; i++) if (sums[i] > edges[i]) factor = std::min(factor, edges[i] / sums[i]);
  for (double &radius : radii) radius *= factor;
  @try {
    FudaoAppearanceGlassView *effect = FindEffect(content, (NSInteger)slot);
    if (!effect) {
      effect = [[FudaoAppearanceGlassView alloc] initWithFrame:NSZeroRect];
      effect.regionSlot = (NSInteger)slot;
      effect.appearance = [NSAppearance appearanceNamed:NSAppearanceNameVibrantLight];
      effect.wantsLayer = YES;
      effect.layer.masksToBounds = YES;
      effect.glassMask = [CAShapeLayer layer];
      effect.layer.mask = effect.glassMask;
      effect.accessibilityElement = NO;
      // Keep the original light tint. The separate backdrop filter supplies
      // soft focus; full material opacity turns this into a solid gray panel.
      // Chromium's foreground stays independent and fully opaque.
      FudaoAppearanceBackdropView *backdrop = [[FudaoAppearanceBackdropView alloc] initWithFrame:NSZeroRect];
      backdrop.appearance = [NSAppearance appearanceNamed:NSAppearanceNameVibrantLight];
      backdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
      backdrop.state = NSVisualEffectStateActive;
      backdrop.material = NSVisualEffectMaterialUnderWindowBackground;
      backdrop.alphaValue = 0.38;
      backdrop.accessibilityElement = NO;
      effect.backdropView = backdrop;
      [effect addSubview:backdrop];
      [content addSubview:effect positioned:NSWindowBelow relativeTo:nil];
    }
    [CATransaction begin]; [CATransaction setDisableActions:YES];
    CGFloat nativeY = content.isFlipped ? y : NSHeight(content.bounds) - y - height;
    effect.frame = NSMakeRect(x, nativeY, width, height);
    effect.alphaValue = opacity;
    effect.glassMask.frame = effect.bounds;
    CGPathRef shapePath = MakePath(width, height, radii);
    effect.glassMask.path = shapePath;
    CGFloat cap = std::max(std::max(radii[0], radii[1]), std::max(radii[2], radii[3]));
    if (effect.backdropView) {
      effect.backdropView.frame = effect.bounds;
      // maskImage also clips the WindowServer backdrop. The
      // flipped child keeps its mask aligned with the wrapper's CSS coordinates.
      CGFloat maskSize = std::ceil(cap * 2 + 1);
      CGFloat scale = handle.window.backingScaleFactor ?: 1;
      NSInteger pixels = (NSInteger)std::ceil(maskSize * scale);
      NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nil pixelsWide:pixels pixelsHigh:pixels bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
      std::memset(bitmap.bitmapData, 0, bitmap.bytesPerRow * bitmap.pixelsHigh);
      NSGraphicsContext *graphics = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
      CGContextRef context = graphics.CGContext;
      CGContextTranslateCTM(context, 0, pixels);
      CGContextScaleCTM(context, scale, -scale);
      CGPathRef maskPath = MakePath(maskSize, maskSize, radii);
      CGContextSetRGBFillColor(context, 1, 1, 1, 1);
      CGContextAddPath(context, maskPath); CGContextFillPath(context);
      CGPathRelease(maskPath);
      NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(maskSize, maskSize)];
      [image addRepresentation:bitmap];
      image.capInsets = NSEdgeInsetsMake(std::max(radii[0], radii[1]), std::max(radii[0], radii[3]), std::max(radii[3], radii[2]), std::max(radii[1], radii[2]));
      image.resizingMode = NSImageResizingModeStretch;
      effect.backdropView.maskImage = image;
    }
    CGPathRelease(shapePath);
    effect.glassRadii = @[@(radii[0]), @(radii[1]), @(radii[2]), @(radii[3])];
    UpdateDesktopBlur(effect, opacity > 0 ? (NSInteger)backgroundBlurRadius : 0,
      handle.window.backingScaleFactor ?: 1);
    [CATransaction commit];
    return NapiBoolean(env, true);
  } @catch (NSException *exception) {
    [FindEffect(content, (NSInteger)slot) removeFromSuperview];
    napi_throw_error(env, nullptr, exception.reason.UTF8String); return nullptr;
  }
}
static napi_value Clear(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Fail(env, "Native appearance requires the Electron main thread");
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!argc) return NapiBoolean(env, false);
  NSView *handle = FindHandle(env, argv[0]);
  if (!handle) return NapiBoolean(env, false);
  bool removed = false;
  for (NSView *child in [handle.window.contentView.subviews copy]) {
    if ([child isKindOfClass:[FudaoAppearanceGlassView class]]) { [child removeFromSuperview]; removed = true; }
  }
  return NapiBoolean(env, removed);
}
// Inspection is limited to visual geometry and focus state for the isolated smoke test.
static napi_value Inspect(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Fail(env, "Native appearance requires the Electron main thread");
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSView *handle = argc ? FindHandle(env, argv[0]) : nil;
  double slot = 0;
  if (argc > 1 && (napi_get_value_double(env, argv[1], &slot) != napi_ok || !std::isfinite(slot) || slot < 0 || slot > 1 || std::floor(slot) != slot)) return Fail(env, "invalid region slot");
  FudaoAppearanceGlassView *effect = handle ? FindEffect(handle.window.contentView, (NSInteger)slot) : nil;
  if (!effect) { napi_value value; napi_get_null(env, &value); return value; }
  napi_value result; napi_create_object(env, &result);
  auto setNumber = [&](const char *key, double value) { napi_value v; napi_create_double(env, value, &v); napi_set_named_property(env, result, key, v); };
  setNumber("x", NSMinX(effect.frame)); setNumber("y", handle.window.contentView.isFlipped ? NSMinY(effect.frame) : NSHeight(handle.window.contentView.bounds) - NSMaxY(effect.frame));
  setNumber("width", NSWidth(effect.frame)); setNumber("height", NSHeight(effect.frame)); setNumber("opacity", effect.alphaValue);
  setNumber("siblingIndex", [handle.window.contentView.subviews indexOfObject:effect]);
  napi_set_named_property(env, result, "ignoresMouse", NapiBoolean(env, [effect hitTest:NSMakePoint(5, 5)] == nil));
  napi_set_named_property(env, result, "acceptsFocus", NapiBoolean(env, effect.acceptsFirstResponder));
  napi_set_named_property(env, result, "hasBackdropMask", NapiBoolean(env, effect.layer.mask != nil && effect.backdropView.maskImage != nil));
  napi_value radii; napi_create_array_with_length(env, 4, &radii);
  for (uint32_t i = 0; i < 4; i++) { napi_value v; napi_create_double(env, effect.glassRadii[i].doubleValue, &v); napi_set_element(env, radii, i, v); }
  napi_set_named_property(env, result, "radii", radii);
  napi_set_named_property(env, result, "layerFlipped", NapiBoolean(env, effect.layer.geometryFlipped));
  napi_set_named_property(env, result, "windowKey", NapiBoolean(env, handle.window.isKeyWindow));
  napi_set_named_property(env, result, "fixedLightAppearance", NapiBoolean(env, [effect.appearance.name isEqualToString:NSAppearanceNameVibrantLight] && [effect.backdropView.appearance.name isEqualToString:NSAppearanceNameVibrantLight]));
  napi_set_named_property(env, result, "underWindowMaterial", NapiBoolean(env, effect.backdropView.material == NSVisualEffectMaterialUnderWindowBackground));
  napi_set_named_property(env, result, "activeBlur", NapiBoolean(env, effect.backdropView.state == NSVisualEffectStateActive));
  napi_set_named_property(env, result, "behindWindow", NapiBoolean(env, effect.backdropView.blendingMode == NSVisualEffectBlendingModeBehindWindow));
  setNumber("materialOpacity", effect.backdropView.alphaValue);
  setNumber("backgroundBlurRadius", effect.backgroundBlurRadius);
  setNumber("backgroundBlurFilterRadius", [[effect.desktopBlur.filters.firstObject valueForKey:@"inputRadius"] doubleValue]);
  napi_set_named_property(env, result, "backgroundBlurClipped", NapiBoolean(env,
    effect.desktopBlur != nil && effect.desktopBlur.superlayer == effect.layer && effect.layer.mask == effect.glassMask));
  napi_set_named_property(env, result, "backgroundBlurAvailable", NapiBoolean(env, DesktopBlurAvailable() && !effect.backgroundBlurFailed));
  return result;
}
// Window geometry is available without capturing the screen or requesting TCC
// permissions. Never read kCGWindowName or export owning applications/titles.
static napi_value SystemUIBounds(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Fail(env, "System UI inspection requires the Electron main thread");
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  if (!windows) { napi_value value; napi_get_null(env, &value); return value; }
  NSSet *systemBundles = [NSSet setWithArray:@[@"com.apple.controlcenter", @"com.apple.systemuiserver",
    @"com.apple.notificationcenterui", @"com.apple.TextInputMenuAgent"]];
  NSMutableDictionary *owners = [NSMutableDictionary dictionary];
  napi_value result; napi_create_array(env, &result);
  uint32_t index = 0;
  for (NSDictionary *row in windows) {
    NSNumber *pid = row[(id)kCGWindowOwnerPID];
    NSInteger layer = [row[(id)kCGWindowLayer] integerValue];
    if (!pid || pid.intValue == NSProcessInfo.processInfo.processIdentifier || layer < 20 ||
        [row[(id)kCGWindowAlpha] doubleValue] <= 0) continue;
    // Menu-bar backgrounds (24) and persistent status-item hit areas (25)
    // are not transient overlays. Their transparent padding may extend into
    // the wings; treating it as an obstruction permanently hides the status.
    if (layer == 24 || layer == 25) continue;
    NSString *bundle = owners[pid];
    if (!bundle) {
      bundle = [NSRunningApplication runningApplicationWithProcessIdentifier:pid.intValue].bundleIdentifier ?: @"";
      owners[pid] = bundle;
    }
    BOOL system = [systemBundles containsObject:bundle] ||
      [row[(id)kCGWindowOwnerName] isEqualToString:@"Window Server"];
    // Open menus from other apps still take priority over the island.
    if (!system && layer != 101) continue;
    CGRect rect;
    NSDictionary *dictionary = row[(id)kCGWindowBounds];
    if (![dictionary isKindOfClass:[NSDictionary class]] ||
        !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)dictionary, &rect) ||
        CGRectIsEmpty(rect) || CGRectIsInfinite(rect) || CGRectIsNull(rect)) continue;
    napi_value item; napi_create_object(env, &item);
    const char *keys[] = {"x", "y", "width", "height"};
    double values[] = {rect.origin.x, rect.origin.y, rect.size.width, rect.size.height};
    for (int i = 0; i < 4; i++) { napi_value value; napi_create_double(env, values[i], &value); napi_set_named_property(env, item, keys[i], value); }
    napi_set_element(env, result, index++, item);
    if (index == 256) break;
  }
  return result;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"clear", nullptr, Clear, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspect", nullptr, Inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pinWindow", nullptr, PinWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectWindow", nullptr, InspectWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"systemUIBounds", nullptr, SystemUIBounds, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 6, properties);
  napi_value slots; napi_create_int32(env, 2, &slots); napi_set_named_property(env, exports, "regionSlots", slots);
  return exports;
}
