'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const appRoot = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-glass-native-'));
app.setPath('userData', data);
app.once('will-quit', () => fs.rmSync(data, { recursive: true, force: true }));
const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
async function main() {
  if (process.platform !== 'darwin') { console.log('SKIP macOS native glass'); return; }
  await app.whenReady();
  const addonPath = process.env.FUDAO_APPEARANCE_ADDON || path.join(appRoot, '.cache', 'native', 'appearance-glass.node');
  if (!fs.existsSync(addonPath) && !process.env.FUDAO_APPEARANCE_ADDON) {
    require(path.join(appRoot, 'scripts/build-appearance-glass')).buildAppearanceGlass({ projectRoot: appRoot, outputPath: addonPath });
  }
  const native = require(addonPath);
  const errors = [];
  const controller = require(path.join(appRoot, 'appearance-native')).createAppearanceNativeController({ addonPath, onError: error => errors.push(error.message) });
  const window = new BrowserWindow({ width: 420, height: 250, frame: false, transparent: true, backgroundColor: '#00000000', roundedCorners: false, hasShadow: false, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>body{margin:0;background:transparent;color:white;font:16px system-ui}input{margin:55px 40px}</style><input value="focus stays here" aria-label="typing fixture">'));
  const shape = { x: 12, y: 8, width: 390, height: 220, radii: [0, 0, 34, 34], opacity: 0.75, backgroundBlurRadius: 3 };
  const handle = window.getNativeWindowHandle();
  try {
    window.setHiddenInMissionControl(true);
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    assert.equal(native.inspectWindow(handle).transient, true);
    assert.equal(controller.pinWindow(window), true);
    assert.equal(window.isHiddenInMissionControl(), true, 'native policy preserves Electron Mission Control exclusion');
    assert.deepEqual(native.inspectWindow(handle), { stationary: false, transient: true, managed: false,
      joinsAllSpaces: true, fullscreenAuxiliary: true, systemAnimationDisabled: true });
    assert.equal(native.pinWindow(Buffer.alloc(8, 1)), false);
    assert.equal(native.apply(Buffer.alloc(8, 1), shape), false, 'invalid pointers are never dereferenced');
    assert.equal(native.clear(Buffer.alloc(8, 1)), false);
    assert.throws(() => native.apply(handle, { ...shape, width: NaN }), /shape/);
    for (const backgroundBlurRadius of [-1, 33, 1.5, NaN]) assert.throws(() => native.apply(handle, { ...shape, backgroundBlurRadius }), /shape/);
    assert.equal(controller.apply(window, shape), true);
    let geometry = native.inspect(handle);
    assert.equal(geometry.siblingIndex, 0, 'effect is behind Chromium');
    assert.equal(geometry.hasBackdropMask, true);
    assert.equal(geometry.ignoresMouse, true);
    assert.equal(geometry.acceptsFocus, false);
    assert.equal(geometry.fixedLightAppearance, true, 'material does not follow the system light/dark appearance');
    assert.equal(geometry.underWindowMaterial, true, 'uses the fixed translucent background');
    assert.equal(geometry.activeBlur, true, 'passive and key windows use the same active material');
    assert.equal(geometry.behindWindow, true, 'samples real windows behind the panel');
    assert.equal(geometry.materialOpacity, 0.38, 'soft focus preserves the original light tint instead of an opaque gray panel');
    assert.equal(geometry.backgroundBlurRadius, geometry.backgroundBlurAvailable ? 3 : 0, 'independent blur uses its bounded radius or falls back to the existing material');
    assert.equal(geometry.backgroundBlurClipped, geometry.backgroundBlurAvailable, 'desktop blur must live inside the same rounded mask as the glass');
    assert.equal(controller.apply(window, { ...shape, backgroundBlurRadius: 20 }), true);
    const softened = native.inspect(handle);
    assert.equal(softened.backgroundBlurRadius, geometry.backgroundBlurAvailable ? 20 : 0, 'soft glass applies stronger desktop blur');
    assert.equal(softened.materialOpacity, geometry.materialOpacity, 'stronger blur preserves material transparency');
    assert.equal(softened.backgroundBlurClipped, geometry.backgroundBlurAvailable);
    if (geometry.backgroundBlurAvailable) {
      assert.equal(softened.backgroundBlurFilterRadius, 20, 'Retina preserves the full 20-point soft-glass radius');
      assert.ok(geometry.backgroundBlurFilterRadius > 0);
      assert.ok(Math.abs(softened.backgroundBlurFilterRadius / geometry.backgroundBlurFilterRadius - 20 / 3) < 0.001,
        'changing presets updates the filter actually attached to the layer');
    }
    assert.equal(controller.apply(window, { ...shape, backgroundBlurRadius: 0 }), true);
    assert.equal(native.inspect(handle).backgroundBlurClipped, false, 'zero radius removes the extra backdrop');
    assert.equal(native.inspect(handle).backgroundBlurFilterRadius, 0);
    assert.equal(controller.apply(window, shape), true);
    assert.equal(native.inspect(handle).backgroundBlurRadius, geometry.backgroundBlurRadius, 'switching back restores light blur');
    if (process.env.FUDAO_DISABLE_NATIVE_BACKGROUND_BLUR) assert.equal(geometry.backgroundBlurAvailable, false, 'missing system capability retains a working material');
    assert.deepEqual(geometry.radii, shape.radii);
    assert.equal(geometry.width, 390);
    assert.equal(geometry.y, 8);
    assert.equal(geometry.layerFlipped, true, "native mask uses the same top-left coordinates as CSS");
    assert.equal(controller.apply(window, { x: 0, y: 0, width: 256, height: 24, radii: [0, 0, 17, 17] }), true);
    assert.deepEqual(native.inspect(handle).radii, [0, 0, 17, 17], "24px menus keep bottom-only 17px corners");
    assert.equal(controller.apply(window, shape), true);
    window.setFocusable(false);
    const leftPill = {x:16,y:50,width:254,height:54,radii:[27,27,27,27],opacity:1,backgroundBlurRadius:20};
    const rightPill = {...leftPill,x:278,width:54};
    assert.equal(controller.applyPair(window,[leftPill,rightPill]),true);
    assert.equal(native.inspect(handle,0).x,16);
    assert.equal(native.inspect(handle,0).width,254);
    assert.equal(native.inspect(handle,1).x,278);
    assert.equal(native.inspect(handle,1).width,54);
    assert.deepEqual(native.inspect(handle,1).radii,[27,27,27,27]);
    assert.equal(native.inspect(handle,1).hasBackdropMask,true);
    assert.throws(()=>native.apply(handle,{...shape,slot:2}),/shape/);
    controller.clear(window);
    assert.equal(native.inspect(handle,0),null);
    assert.equal(native.inspect(handle,1),null,'clear removes both separate native materials');
    window.showInactive();
    const inactiveFocus = window.isFocused();
    assert.equal(controller.apply(window, shape), true);
    assert.equal(window.isFocused(), inactiveFocus, 'applying a native effect must not activate an inactive window');
    assert.equal(native.inspect(handle).activeBlur, true, 'passive hover keeps the same material state');
    assert.equal(native.inspect(handle).materialOpacity, geometry.materialOpacity, 'passive hover keeps the same material strength');
    assert.equal(native.inspect(handle).backgroundBlurRadius, geometry.backgroundBlurRadius, 'passive hover keeps the independent blur radius');
    controller.clear(window);
    window.setFocusable(true);
    window.show(); window.focus();
    for (let i = 0; i < 40 && !window.isFocused(); i++) await wait(10);
    assert.equal(window.isFocused(), true, 'focus fixture must own native window focus before testing');
    let blurEvents = 0;
    const countBlur = () => { blurEvents++; };
    window.on('blur', countBlur);
    assert.equal(controller.apply(window, shape), true);
    assert.equal(native.inspect(handle).windowKey, true, 'creating the native backdrop preserves the Cocoa key window');
    await window.webContents.executeJavaScript('document.querySelector("input").focus()');
    for (let i = 0; i < 24; i++) {
      const opacity = 0.5 + i / 48;
      if (i % 6 === 0) controller.clear(window);
      assert.equal(controller.apply(window, { ...shape, opacity }), true);
      await wait(10);
      assert.equal(window.isFocused(), true, `effect update ${i} preserves Electron focus`);
      assert.equal(native.inspect(handle).windowKey, true, `effect update ${i} preserves the Cocoa key window`);
    }
    assert.equal(await window.webContents.executeJavaScript('document.activeElement.tagName'), 'INPUT');
    assert.equal(blurEvents, 0, 'creating, changing or clearing the effect never emits native blur');
    window.removeListener('blur', countBlur);
    geometry = native.inspect(handle);
    assert.equal(geometry.siblingIndex, 0, 'layout has not raised the effect');
    if (process.env.FUDAO_GLASS_SCREENSHOT) fs.writeFileSync(process.env.FUDAO_GLASS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    window.setSize(430, 260); await wait(80);
    assert.equal(native.inspect(handle), null, 'bounds changes clear stale geometry');
    assert.equal(controller.apply(window, shape), true);
    // Electron 44 showInactive windows may not emit hide; main hide paths
    // explicitly call clear as well as using the controller event listener.
    controller.clear(window); window.hide(); await wait(50);
    assert.equal(native.inspect(handle), null, 'hidden windows do not retain effects');
    assert.equal(controller.apply(window, shape), true);
    window.destroy();
    assert.equal(native.apply(handle, shape), false, 'closed handles are rejected');
    assert.equal(controller.apply(window, shape), false);
    assert.equal(controller.clear(window), false);
    controller.dispose();
    assert.deepEqual(errors, []);
    console.log('PASS native glass: fixed translucent material, verified handles, clipped shape, bottom sibling, Electron/Cocoa/DOM focus preserved, resize/hide/destroy cleanup');
  } finally { controller.dispose(); if (!window.isDestroyed()) window.destroy(); }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
