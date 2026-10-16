const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell,
  systemPreferences,
  clipboard,
  globalShortcut,
  safeStorage,
  dialog,
  desktopCapturer,
  ClipboardItem,
  powerMonitor,
} = require('electron');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { createAppearanceSettingsService } = require('./appearance-settings');
const { createWindowSizeSettingsService } = require('./window-size-settings');
const { createAppearanceNativeController } = require('./appearance-native');
const { normalizeAppearanceSurface } = require('./appearance-surface');
const { normalizeWindowMotion } = require('./window-handoff');
const windowHandoff = require('./window-handoff').createWindowHandoffController({
  onError: (error) => console.warn('窗口切换未完成：', error.message),
});
const appearanceNative = createAppearanceNativeController({
  onError: (error) => console.warn('玻璃背景暂不可用：', error.message),
});
const systemUIGuard = require('./system-ui-guard').createSystemUIGuard({
  read: () => appearanceNative.readSystemUIBounds(),
  onRefresh: () => syncSystemUIAvoidance(),
});
let systemSessionLocked = false;
let systemSleeping = false;
function systemUIBlocks(bounds) { return systemSessionLocked || systemSleeping || systemUIGuard.blocks(bounds); }
const http = require('http');
const dns = require('dns');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { fileURLToPath } = require('node:url');
const { getSystemVolume, setSystemVolume, createSystemStatusService } = require('./island-system');
const { cleanActivity, selectIslandActivity, systemFeedback,
  hasCodexAttention, statusIslandSurfaceAllowed } = require('./island-activities');
const { createIslandStatusWindow, getStatusIslandBounds } = require('./island-status-window');
const { createComputerStatusService } = require('./computer-status');
const { getLifecycleToken, createLifecycleHttpHandler } = require('./codex-lifecycle-http');
const { createWeatherService } = require('./weather-service');
const weatherService = createWeatherService();
const {
  isPrivateAddress,
  extractPageTitle,
  recordingExtension,
  normalizeWindowRows,
  todoReminderState,
  todoReminderTimerDelay,
  taskNotificationIdentity,
  normalizeCredentialInput,
  parseSmartLinkMetadata,
  extractFaviconHref,
  parseSmartMaterialMetadata,
  clipboardServicePolicy,
  createClipboardImageFingerprint,
  prepareClipboardImagePayload,
  installLocalWebContentsGuards,
  runOwnedOpenDialog,
  readClipboardObservation,
  screenRecordingProbePolicy,
  windowScanStatusError,
  windowFocusError,
  taskNotificationWindowPolicy,
  updateFeaturePreference,
  selectTranscriptionSettings,
  publicTranscriptionMetadata,
  createWorkspacePersistenceGate,
  hoverSpacePollingPolicy,
  reduceClipboardObservation,
} = require('./main-services');

// Public branding is 悬浮岛. Electron uses its internal name for the macOS
// Safe Storage service/account, so retain it alongside the historical data path.
// CFBundleName supplies the macOS 工作台 menu title; app.setName retains the
// existing Safe Storage identity independently of that system-facing label.
const LEGACY_USER_DATA_PATH = path.join(app.getPath('appData'), 'Dynamic Panel');
app.setName('TO-DO Panel');
app.setPath('userData', LEGACY_USER_DATA_PATH);
const appearanceSettings = createAppearanceSettingsService({
  filePath: path.join(app.getPath('userData'), 'appearance-settings.json'),
});

const windowSizeSettings = createWindowSizeSettingsService({
  filePath: path.join(app.getPath('userData'), 'window-size-settings.json'),
});

// ============ 托盘图标 PNG 生成 ============
// 直接在主进程编码 PNG，避免引入额外资源文件
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 4);
    scanlines[off] = 0;
    pixels.copy(scanlines, off + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(scanlines);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 生成刘海形状：扁平顶 + 圆角底，居中偏上
function makeNotchPng(scale) {
  const size = 16 * scale;
  const pixels = Buffer.alloc(size * size * 4);

  // 形状参数（pt 单位 × scale）
  const W = 10 * scale; // 刘海宽
  const H = 5 * scale; // 刘海高
  const R = 2 * scale; // 下方圆角半径
  const x0 = (size - W) / 2;
  const y0 = 3.5 * scale; // 距顶 padding

  function isInside(px, py) {
    if (px < x0 || px > x0 + W || py < y0 || py > y0 + H) return false;
    const bottomR = y0 + H - R;
    if (py < bottomR) return true;
    const leftR = x0 + R;
    const rightR = x0 + W - R;
    if (px >= leftR && px <= rightR) return true;
    if (px < leftR) {
      const dx = leftR - px;
      const dy = py - bottomR;
      return dx * dx + dy * dy <= R * R;
    }
    const dx = px - rightR;
    const dy = py - bottomR;
    return dx * dx + dy * dy <= R * R;
  }

  // 4×4 超采样抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let count = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (isInside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) count++;
        }
      }
      const alpha = Math.round((count / 16) * 255);
      const idx = (y * size + x) * 4;
      pixels[idx + 3] = alpha;
    }
  }

  return encodePng(size, size, pixels);
}

function createNotchTrayIcon() {
  const png2x = makeNotchPng(2);
  const icon = nativeImage.createFromBuffer(png2x, { scaleFactor: 2 });
  icon.setTemplateImage(true);
  return icon;
}

const COLLAPSED_CENTER_WIDTH = 200;
const COLLAPSED_WING_WIDTH = 28;
const COLLAPSED_WIDTH = COLLAPSED_CENTER_WIDTH + COLLAPSED_WING_WIDTH * 2;
const COLLAPSED_MIN_HEIGHT = 38;
// 中央保留原来的 200px 物理刘海，两侧各增加 28px 状态区，为相邻菜单栏图标留出空间。
// 额度和任务与菜单栏等高，不增加任何下沿。虽然折叠条完全在菜单栏拦截带内，
// 但本项目窗口使用 setAlwaysOnTop(true,'screen-saver') 级别，
// 实测菜单栏不拦截该级别窗口的点击，折叠条仍可点击展开。
// （见项目记忆 notch-top-geometry-constraint / commit f12aea1）

// 所有 Tab 共用同一展开尺寸，切换内容时不再改变原生窗口边界。
// 原生窗口只在折叠/展开两个模式间切换，避免 Tab 切换产生明显的宽高跳变。
const EXPANDED_WIDTH = 1040;
// B 档为整窗尺寸，已包含菜单栏安全区与导航。
const EXPANDED_HEIGHT = 480;
const TAB_SIZES = {
  home: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  todo: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  projects: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  codes: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  notes: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  clip: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  links: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  recordings: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  credentials: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
  settings: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
};
// 与渲染层结构常量对应：panel padding-top(--s-2 8) + 顶栏(--topbar-h 40)
// + panels margin-top(--s-3 12) + panel padding-bottom(--s-4 16)。系统菜单栏安全区另计。
const EXPANDED_CHROME_Y = 76;
const SCREEN_MARGIN = 24; // 宽度超屏时两侧保留的安全边
const COLLAPSE_WATCHDOG_MS = 650;

const CLIP_MAX_ITEMS = 100;
const CLIP_POLL_INTERVAL_MS = 500;
// 大图从系统 ClipboardItem 复制到进程仍有固定成本；图片探测降到 3 秒一次，
// 文本继续保持 500ms 响应，不影响日常文字剪贴体验。
const CLIP_IMAGE_POLL_INTERVAL_MS = 3000;
const CLIP_IMAGES_DIR_NAME = 'clipboard-images';

const RECORDINGS_DIR_NAME = 'recordings';
const TRANSCRIPTION_SETTINGS_FILE = 'transcription-settings.json';
const CREDENTIALS_VAULT_FILE = 'credentials.vault.json';
const APP_SETTINGS_FILE = 'app-settings.json';
const WORKSPACE_SETTINGS_FILE = 'workspace-settings.json';
const WORKSPACE_DATA_FILE = 'workspace.json';
const MIRROR_IMAGE_FILE = 'mirror-cover.jpg';
const workspacePersistenceGate = createWorkspacePersistenceGate();
let codexAttentionActive = false;
let statusIsland = null;
let aiCodeRuntime = null;
const { createCodexFloatService } = require('./codex-float');
const codexFloat = createCodexFloatService({
  version: app.getVersion(),
  activityCache: require('./codex-activity-cache').createCodexActivityCache({
    directory: path.join(app.getPath('userData'), 'codex-activities'),
    isEnabled: () => aiCodeRuntime?.isSelected('codex') === true,
  }),
  onUpdate: (snapshot) => {
    if (!aiCodeRuntime?.isSelected('codex')) return;
    aiCodeRuntime.acceptCodex(snapshot);
    const nextAttention = hasCodexAttention(snapshot);
    broadcastIsland('codex-float:status', snapshot);
    if (codexAttentionActive !== nextAttention) {
      codexAttentionActive = nextAttention;
      if (statusIsland) void statusIsland.sync();
    }
  },
  onTaskComplete: (task) => enqueueCodeTaskNotification('codex', task),
});
const TRANSCRIPTION_MODEL = 'qwen3-asr-flash-realtime';
const TRANSCRIPTION_SAMPLE_RATE = 16000;
const TRANSCRIPTION_FINISH_TIMEOUT_MS = 7000;
const RECORDING_MAX_BYTES = 200 * 1024 * 1024;
const LINK_FETCH_TIMEOUT_MS = 8000;
const LINK_FETCH_MAX_BYTES = 512 * 1024;
const LINK_FETCH_MAX_REDIRECTS = 3;

const TASK_NOTIFICATION_VISIBLE_MS = 3000;
const TASK_NOTIFICATION_LEAVE_MS = 360;
const TASK_NOTIFICATION_DEDUPE_MS = 2000;
const TASK_NOTIFICATION_MAX_QUEUE = 5;
const TASK_NOTIFICATION_BODY_LIMIT = 64 * 1024;
const TASK_NOTIFICATION_HOST = '127.0.0.1';
const TASK_NOTIFICATION_PORT = 43821;
// /notify/<source> 的来源白名单：只放行已知 Agent，其余一律 404。
const TASK_NOTIFICATION_SOURCES = new Set(['codex', 'gpt', 'claude']);
const TODO_REMINDER_LEAD_MS = 60 * 60 * 1000;

let mainWindow = null;
let tray = null;
let currentMode = 'collapsed';
let currentTab = 'home';
let collapseWatchdog = null;
let collapseGeneration = 0;
let hideWhenCollapsed = false;
let isQuitting = false;
let mediaPermissionRequests = 0;
let transientSystemInteractionRequests = 0;
let cameraBlurDeferred = false;

const QUICK_ISLAND_HEIGHT = 270;
const NOTCH_PREVIEW_MIN_HEIGHT = 56;
const NOTCH_PREVIEW_DETAIL_HEIGHT = 18;
const QUICK_ISLAND_HIDE_MS = 200;
const QUICK_ISLAND_WORKSPACE_TABS = new Set(['home', 'todo', 'projects', 'codes', 'notes', 'links', 'recordings', 'settings']);
let quickIslandWindow = null;
let quickIslandReady = null;
let quickIslandGeneration = 0;
let quickIslandHideTimer = null;
let quickIslandPointerTimer = null;
let quickIslandOutsideSince = 0;
let quickIslandInteractive = false;
let quickIslandNativeFocusable = false;
let quickIslandCameraDeferred = false;
let quickIslandOpening = 0;
let workbenchOpeningRevision = 0;
let workbenchOpeningUntil = 0;
let notchPreviewActive = false;
const islandActivities = { recording: null, timer: null };
let islandActivityTimer = null;
let lastIslandSystemSnapshot = null;
const systemStatus = createSystemStatusService({
  onChange: handleIslandSystemChange,
  // Volume and brightness keys always remain with macOS, including old enabled preferences.
  hudReplacementEnabled: false,
});
const computerStatus = createComputerStatusService({ getBattery: async () => (await systemStatus.getSnapshot())?.battery });
function canShowStatusIsland(data) {
  const display = getWindowDisplay();
  if (systemUIBlocks(getStatusIslandBounds(display, getCollapsedHeight(display), data?.compact === true, data))) return false;
  return statusIslandSurfaceAllowed(data, {
    isQuitting,
    notificationActive: Boolean(activeTaskNotification),
    notificationVisible: Boolean(notificationWindow && !notificationWindow.isDestroyed() && notificationWindow.isVisible()),
    codexAttentionActive,
    passiveAllowed: quickIslandOpening === 0 && canShowQuickIsland()
      && !(quickIslandWindow && !quickIslandWindow.isDestroyed() && quickIslandWindow.isVisible()),
  });
}

statusIsland = createIslandStatusWindow({
  BrowserWindow,
  alwaysOnTopLevel: 2,
  getBounds: (compact, data) => {
    const display = getWindowDisplay();
    return getStatusIslandBounds(display, getCollapsedHeight(display), compact, { ...data, collapsedWidth: COLLAPSED_WIDTH });
  },
  isAllowed: canShowStatusIsland,
  getAppearance: () => appearanceSettings.getSnapshot(),
  appearanceNative,
});

let notificationWindow = null;
let notificationWindowReady = false;
let notificationServer = null;
let notificationServerAvailable = false;
let activeTaskNotification = null;
let taskNotificationLeaving = false;
let taskNotificationTimer = null;
let taskNotificationFallbackTimer = null;
let taskNotificationTimerStartedAt = 0;
let taskNotificationRemainingMs = TASK_NOTIFICATION_VISIBLE_MS;
let taskNotificationPaused = false;
const taskNotificationQueue = [];
const recentTaskNotifications = new Map();
const taskCompletionHistory = [];
let todoReminderTimer = null;
let scheduledTodoReminders = [];

let clipPollTimer = null;
let clipBaselineTimer = null;
let clipPollingEnabled = false;
let clipPolling = false; // 互斥锁：大图 toPNG 同步耗时，防止上一轮未完成又进入
let clipObservationState = { textFingerprint: null, imageFingerprint: null };
let lastClipImageProbeAt = 0;
let clipPollingGeneration = 0;
let spaceShortcutTimer = null;
let spaceShortcutRegistered = false;
let configuredShortcut = '';
let previousPasteTarget = null;
let islandPasteTargetPrepared = null;
let windowScanCache = new Map();
const windowIconCache = new Map();
const transcriptionSessions = new Map();

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      hideWhenCollapsed = false;
      repositionWindow(getTargetDisplay());
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 多屏适配：定位到"鼠标当前所在屏"的物理顶端居中
// 这样接上外接屏后，无论副屏在主屏的左/右/上/下，刘海都跟着用户视线走
function getTargetDisplay() {
  try {
    const cursor = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(cursor);
  } catch (e) {
    return screen.getPrimaryDisplay();
  }
}

// 窗口当前所在屏：模式切换 / Tab 变形必须锚定在这块屏上。
// 若跟随光标（getTargetDisplay），失焦收起瞬间会把刘海"瞬移"到光标所在的另一块屏。
function getWindowDisplay() {
  try {
    if (mainWindow) return screen.getDisplayMatching(mainWindow.getBounds());
  } catch (e) {
    // fallthrough
  }
  return getTargetDisplay();
}

function getCenteredBounds(width, height, display) {
  const d = display || getTargetDisplay();
  return {
    x: Math.round(d.bounds.x + (d.bounds.width - width) / 2),
    y: d.bounds.y, // 副屏的 y 不一定是 0，可能是负数（如外接屏在主屏上方）
    width,
    height,
  };
}

// macOS 菜单栏会拦截其高度带内的所有鼠标点击（即使窗口绘制在其上方），
// 刘海屏机型菜单栏高约 37pt，等于物理刘海高度。
function getMenuBarHeight(display) {
  return Math.max(0, display.workArea.y - display.bounds.y);
}

function getCollapsedHeight(display) {
  const mb = getMenuBarHeight(display);
  // 折叠条高度恰好等于菜单栏带（≈物理刘海高），一个像素都不超出物理刘海。
  // 无刘海的外接屏 menuBarHeight 仍是真实菜单栏高，能正常露头；
  // 异常取到 0 才回退兜底（COLLAPSED_MIN_HEIGHT = 38px）。
  return mb > 0 ? mb : COLLAPSED_MIN_HEIGHT;
}

function getNotchPreviewHeight(display) {
  const collapsedHeight = getCollapsedHeight(display);
  return Math.max(NOTCH_PREVIEW_MIN_HEIGHT, collapsedHeight + NOTCH_PREVIEW_DETAIL_HEIGHT);
}

function getCollapsedWidth() { return COLLAPSED_WIDTH; }

// 展开尺寸按当前 Tab 取值；宽度超出屏幕时 clamp 到工作区内。
// 画布保持物理贴顶，导航留在系统菜单栏下方，输入窗口才能低于原生候选框。
function getExpandedSize(display) {
  const size = TAB_SIZES[currentTab] || TAB_SIZES.home;
  return {
    width: Math.min(windowSizeSettings.getSnapshot().width, display.workArea.width - SCREEN_MARGIN),
    height: Math.min(
      size.height,
      Math.max(getCollapsedHeight(display), display.bounds.height - SCREEN_MARGIN)
    ),
  };
}

// display 不传时锚定窗口当前所在屏；只有"召唤"类动作（启动/重新居中/显示）才传光标屏。
// 一律瞬时 setBounds：系统动画 resize 会持续重绘 web 内容（卡顿）。
// 原生窗口只提供透明画布，用户可见的岛体形变交给渲染层 CSS。
function getBoundsForMode(mode, display) {
  const d = display || getWindowDisplay();
  if (mode === 'expanded') {
    const { width, height } = getExpandedSize(d);
    return getCenteredBounds(width, height, d);
  }
  if (mode === 'preview') {
    return getCenteredBounds(COLLAPSED_WIDTH, getNotchPreviewHeight(d), d);
  }
  return getCenteredBounds(getCollapsedWidth(d), getCollapsedHeight(d), d);
}

function isIslandSender(event, allowQuick = true) {
  const owners = [[mainWindow, 'index.html']];
  if (allowQuick) owners.push([quickIslandWindow, 'quick-island.html']);
  return owners.some(([owner, filename]) => {
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) return false;
    if (!event.senderFrame || event.senderFrame !== owner.webContents.mainFrame) return false;
    try {
      return fileURLToPath(event.senderFrame.url) === path.join(__dirname, 'renderer', filename);
    } catch (error) {
      return false;
    }
  });
}

function isStatusIslandSender(event) {
  const owner = statusIsland.getWindow();
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return false;
  try { return fileURLToPath(event.senderFrame.url) === path.join(__dirname, 'renderer', 'status-island.html'); }
  catch (_) { return false; }
}

function broadcastIsland(channel, payload) {
  for (const owner of [mainWindow, quickIslandWindow]) {
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(channel, payload);
  }
}

function handleIslandSystemChange(snapshot, changedKeys) {
  broadcastIsland('island:system-status', snapshot);
  const keys = [...(changedKeys || [])];
  const before = lastIslandSystemSnapshot?.battery;
  const after = snapshot.battery;
  lastIslandSystemSnapshot = snapshot;
  if (keys.includes('battery') && before?.ok && after?.ok
      && before.onAC === after.onAC && before.charging === after.charging
      && ![20, 10].some((level) => before.percent > level && after.percent <= level)) {
    keys.splice(keys.indexOf('battery'), 1);
  }
  const feedback = systemFeedback(snapshot, keys.filter((key) => !['volume', 'brightness'].includes(key)));
  if (feedback && canShowStatusIsland(feedback)) {
    dismissNotchPreviewSurface();
    void statusIsland.showFeedback(feedback);
  }
}

function updateIslandActivities() {
  broadcastIsland('island:activities', islandActivities);
  void statusIsland.setPersistent(selectIslandActivity(islandActivities));
}

function getQuickIslandBounds(display = getWindowDisplay()) {
  const { width } = getExpandedSize(display);
  return getCenteredBounds(Math.round(width), Math.min(getMenuBarHeight(display) + QUICK_ISLAND_HEIGHT, display.bounds.height - SCREEN_MARGIN), display);
}

function canShowQuickIsland() {
  return !isQuitting && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    && !systemUIBlocks(getBoundsForMode('collapsed'))
    && currentMode === 'collapsed' && Date.now() >= workbenchOpeningUntil
    && !notchPreviewActive && !activeTaskNotification
    && !(notificationWindow && !notificationWindow.isDestroyed() && notificationWindow.isVisible());
}

function dismissNotchPreviewSurface() {
  if (!notchPreviewActive) return false;
  notchPreviewActive = false;
  const target = mainWindow;
  if (!target || target.isDestroyed() || currentMode !== 'collapsed') return true;
  target.setBounds(getBoundsForMode('collapsed'));
  if (!target.webContents.isDestroyed()) target.webContents.send('window:request-collapse');
  return true;
}

function stopQuickIslandPointerWatch() {
  if (quickIslandPointerTimer) clearInterval(quickIslandPointerTimer);
  quickIslandPointerTimer = null;
  quickIslandOutsideSince = 0;
}

function setCollapsedIslandCovered(covered) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // The collapsed window stays alive for task updates and entry-point policy,
  // but it must not paint its screen-saver-level wings over an editable island.
  const suppress = (covered || systemUIBlocks(getBoundsForMode('collapsed'))) && currentMode === 'collapsed';
  if (!suppress && mainWindow.getOpacity() !== 0) return;
  if (suppress) appearanceNative.clear(mainWindow);
  mainWindow.setOpacity(suppress ? 0 : 1);
  mainWindow.setIgnoreMouseEvents(suppress);
}

function hideQuickIsland(immediate = false, reason = 'explicit') {
  if (windowHandoff.isSource(quickIslandWindow) || windowHandoff.isTarget(quickIslandWindow)) windowHandoff.cancel('dismissed');
  quickIslandGeneration += 1;
  quickIslandInteractive = false;
  stopQuickIslandPointerWatch();
  const target = quickIslandWindow;
  if (!target || target.isDestroyed()) {
    quickIslandNativeFocusable = false;
    setCollapsedIslandCovered(false);
    return { ok: true };
  }
  if (quickIslandNativeFocusable) {
    // Clear state first: changing key-window eligibility may emit blur inline.
    quickIslandNativeFocusable = false;
    target.setFocusable(false);
  }
  if (quickIslandHideTimer) {
    if (!immediate) return { ok: true };
    clearTimeout(quickIslandHideTimer);
    quickIslandHideTimer = null;
  }
  if (!target.webContents.isDestroyed()) target.webContents.send('quick-island:hide', { reason });
  if (!target.isVisible()) {
    appearanceNative.clear(target);
    setCollapsedIslandCovered(false);
    return { ok: true };
  }
  if (immediate) {
    appearanceNative.clear(target);
    target.hide();
    setCollapsedIslandCovered(false);
  } else {
    quickIslandHideTimer = setTimeout(() => {
      quickIslandHideTimer = null;
      if (quickIslandWindow === target && !target.isDestroyed()) {
        appearanceNative.clear(target);
        target.hide();
        setCollapsedIslandCovered(false);
      }
      void statusIsland.sync();
    }, QUICK_ISLAND_HIDE_MS);
  }
  return { ok: true };
}

function startQuickIslandPointerWatch() {
  stopQuickIslandPointerWatch();
  quickIslandPointerTimer = setInterval(() => {
    const target = quickIslandWindow;
    if (!canShowQuickIsland() || !target || target.isDestroyed() || !target.isVisible()) {
      hideQuickIsland(true);
      return;
    }
    if (quickIslandInteractive || windowHandoff.isSource(target) || windowHandoff.isTarget(target)) {
      quickIslandOutsideSince = 0;
      return;
    }
    const point = screen.getCursorScreenPoint();
    const bounds = target.getBounds();
    const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width
      && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    if (inside) {
      quickIslandOutsideSince = 0;
    } else if (!quickIslandOutsideSince) {
      quickIslandOutsideSince = Date.now();
    } else if (Date.now() - quickIslandOutsideSince >= 400) {
      hideQuickIsland(false, 'hover');
    }
  }, 100);
  quickIslandPointerTimer.unref?.();
}

function createQuickIslandWindow(display) {
  if (quickIslandWindow && !quickIslandWindow.isDestroyed()) return quickIslandReady;
  const target = new BrowserWindow({
    ...getQuickIslandBounds(display),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    // Prevent AppKit from moving the anchored canvas below the menu bar.
    enableLargerThanScreen: true,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  quickIslandWindow = target;
  quickIslandNativeFocusable = false;
  installLocalWebContentsGuards(target.webContents);
  target.setAlwaysOnTop(true, 'screen-saver', 1);
  target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  appearanceNative.pinWindow(target);
  target.setIgnoreMouseEvents(false);
  target.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      target.webContents.send('key:escape');
    }
  });
  target.on('blur', () => {
    if (windowHandoff.isCommitting()) return;
    if (quickIslandWindow !== target || !quickIslandInteractive) return;
    if (transientSystemInteractionRequests > 0) return;
    if (mediaPermissionRequests > 0) { quickIslandCameraDeferred = true; return; }
    hideQuickIsland();
  });
  target.webContents.on('render-process-gone', () => {
    if (!target.isDestroyed()) target.destroy();
  });
  target.on('closed', () => {
    if (quickIslandWindow !== target) return;
    quickIslandGeneration += 1;
    stopQuickIslandPointerWatch();
    if (quickIslandHideTimer) clearTimeout(quickIslandHideTimer);
    quickIslandHideTimer = null;
    quickIslandWindow = null;
    setCollapsedIslandCovered(false);
    quickIslandReady = null;
    quickIslandInteractive = false;
    quickIslandNativeFocusable = false;
  });
  quickIslandReady = target.loadFile(path.join(__dirname, 'renderer', 'quick-island.html'))
    .then(() => target)
    .catch(() => {
      if (!target.isDestroyed()) target.destroy();
      return null;
    });
  return quickIslandReady;
}

async function showQuickIsland(options = {}) {
  if (!canShowQuickIsland()) return { ok: false, error: 'island_unavailable' };
  void statusIsland.syncForAppSurface();
  // A pending or visible explicit opening must not be downgraded by hover.
  const explicitlyFocused = options?.focus === true;
  quickIslandInteractive = quickIslandInteractive || explicitlyFocused;
  const generation = ++quickIslandGeneration;
  if (quickIslandHideTimer) clearTimeout(quickIslandHideTimer);
  quickIslandHideTimer = null;
  const display = getWindowDisplay();
  quickIslandOpening += 1;
  try {
    const target = await createQuickIslandWindow(display);
    if (generation !== quickIslandGeneration || !canShowQuickIsland()) return { ok: false, error: 'island_unavailable' };
    if (!target || target.isDestroyed()) return { ok: false, error: 'island_load_failed' };
    // The status heartbeat may have run while the HTML was loading. Reapply the
    // central surface policy immediately before showing the quick island.
    await statusIsland.syncForAppSurface();
    // The second sync can itself wait for a status window to load. A completion
    // notification may have cancelled this opening while that await was pending.
    if (generation !== quickIslandGeneration || !canShowQuickIsland()) return { ok: false, error: 'island_unavailable' };
    const stripHeight = getCollapsedHeight(display);
    const wasVisible = target.isVisible();
    const shouldFocus = quickIslandInteractive && (explicitlyFocused || !wasVisible || !quickIslandNativeFocusable);
    const bounds = getQuickIslandBounds(display);
    target.setBounds(bounds);
    setCollapsedIslandCovered(true);
    // macOS Chinese candidates use native layer 20. 'status' is layer 25,
    // so editable surfaces must use 'floating' (3), not merely leave screen-saver.
    target.setAlwaysOnTop(true, quickIslandInteractive ? 'floating' : 'screen-saver', quickIslandInteractive ? 0 : 1);
    if (quickIslandNativeFocusable !== quickIslandInteractive) {
      quickIslandNativeFocusable = quickIslandInteractive;
      target.setFocusable(quickIslandInteractive);
    }
    if (quickIslandInteractive) {
      // show() also activates the app on macOS; focus() alone cannot promote
      // an already-visible hover panel from an inactive application.
      if (!wasVisible || shouldFocus) target.show();
      if (shouldFocus) {
        target.focus();
        target.webContents.focus();
      }
    } else {
      target.showInactive();
    }
    target.webContents.send('quick-island:show', { stripHeight, menuBarHeight: getMenuBarHeight(display), collapsedWidth: COLLAPSED_WIDTH, width: bounds.width, height: bounds.height, interactive: quickIslandInteractive, version: app.getVersion() });
    target.webContents.send('island:activities', islandActivities);
    Promise.resolve(systemStatus.getSnapshot()).then((snapshot) => {
      if (!target.isDestroyed()) target.webContents.send('island:system-status', snapshot);
    }).catch(() => {});
    startQuickIslandPointerWatch();
    return { ok: true, interactive: quickIslandInteractive };
  } finally {
    quickIslandOpening = Math.max(0, quickIslandOpening - 1);
  }
}

function cancelCollapseWatchdog() {
  collapseGeneration++;
  if (collapseWatchdog) {
    clearTimeout(collapseWatchdog);
    collapseWatchdog = null;
  }
}

function applyMode(mode, display) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const preparingWorkspace = mode === 'expanded' && windowHandoff.isTarget(mainWindow);
  if (!preparingWorkspace) windowHandoff.cancel('mode_changed');
  notchPreviewActive = false;
  if (mode === 'expanded') {
    workbenchOpeningRevision += 1;
    workbenchOpeningUntil = 0;
    if (!preparingWorkspace) hideQuickIsland(true);
    void statusIsland.syncForAppSurface();
  }
  cancelCollapseWatchdog();
  appearanceNative.clear(mainWindow);
  if (!preparingWorkspace && !windowHandoff.isCommitting()) setCollapsedIslandCovered(false);
  mainWindow.setAlwaysOnTop(true, mode === 'expanded' ? 'floating' : 'screen-saver');
  mainWindow.setBounds(getBoundsForMode(mode, display));
  mainWindow.webContents.send('window:metrics-changed', getLayoutMetrics(display));
  mainWindow.setIgnoreMouseEvents(false);
  currentMode = mode;
  if (mode === 'expanded') hideWhenCollapsed = false;
  if (mode === 'collapsed' && hideWhenCollapsed) {
    hideWhenCollapsed = false;
    appearanceNative.clear(mainWindow);
    mainWindow.hide();
    refreshTrayMenu();
  }
  syncHoverSpacePolling();
  void statusIsland.sync();
}

// 纯重新定位不能改变收起事务，否则屏幕变化会取消 watchdog 并重新吞掉鼠标。
function repositionWindow(display) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  hideQuickIsland(true);
  const surfaceMode = currentMode === 'collapsed' && notchPreviewActive ? 'preview' : currentMode;
  mainWindow.setBounds(getBoundsForMode(surfaceMode, display));
  mainWindow.webContents.send('window:metrics-changed', getLayoutMetrics(display));
}

function beginNativeCollapse() {
  windowHandoff.cancel('collapse_requested');
  if (!mainWindow || currentMode !== 'expanded') return;
  const targetWindow = mainWindow;
  const generation = ++collapseGeneration;
  targetWindow.setIgnoreMouseEvents(true);
  if (collapseWatchdog) clearTimeout(collapseWatchdog);
  collapseWatchdog = setTimeout(() => {
    if (generation !== collapseGeneration) return;
    collapseWatchdog = null;
    if (mainWindow === targetWindow && currentMode === 'expanded') {
      applyMode('collapsed');
    }
  }, COLLAPSE_WATCHDOG_MS);
}

function requestRendererCollapse({ immediate = false } = {}) {
  if (!mainWindow || currentMode !== 'expanded') return;
  if (immediate) {
    // Show Desktop can occlude Chromium before its closing animation paints.
    // Shrink and clear the native backdrop now, then reset renderer state.
    applyMode('collapsed');
    mainWindow.webContents.send('window:request-collapse', { immediate: true });
    return;
  }
  beginNativeCollapse();
  mainWindow.webContents.send('window:request-collapse');
}

function hideWindowAfterCollapse() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  hideQuickIsland(true);
  if (currentMode === 'expanded') {
    hideWhenCollapsed = true;
    requestRendererCollapse();
    return;
  }
  dismissNotchPreviewSurface();
  hideWhenCollapsed = false;
  appearanceNative.clear(mainWindow);
  mainWindow.hide();
  refreshTrayMenu();
}

// ============ Codex / Claude / GPT 任务完成提醒 ============
// 使用独立的非激活窗口，避免打断主刘海窗口的展开、收起和焦点状态机。

function pickTaskNotificationValue(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      return String(value);
    }
  }
  return '';
}

function cleanTaskNotificationText(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const firstLine = String(value)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  const cleaned = firstLine
    .replace(/^[#>*`_~\-\s]+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(cleaned);
  return characters.length > maxLength ? characters.slice(0, maxLength).join('') : cleaned;
}

function isSubagentNotification(payload) {
  const agentType = pickTaskNotificationValue(payload, [
    'agent_type',
    'agent-type',
    'agentType',
  ]).toLowerCase();
  const hookEvent = pickTaskNotificationValue(payload, [
    'hook_event_name',
    'hook-event-name',
    'hookEventName',
  ]).toLowerCase();
  // Claude Code 的 agent_type 存的是子代理名（Explore / security-reviewer 等），
  // 不含 subagent 字样，只有身处子代理时才带 agent_id，故以该字段存在为准。
  const agentId = pickTaskNotificationValue(payload, ['agent_id', 'agent-id', 'agentId']);
  return Boolean(agentId)
    || hookEvent.includes('subagent')
    || agentType.includes('subagent')
    || payload.is_subagent === true
    || payload.isSubagent === true;
}

function normalizeTaskNotification(payload, source) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (isSubagentNotification(payload)) return null;
  const identity = taskNotificationIdentity(payload, source);

  const taskId = cleanTaskNotificationText(
    pickTaskNotificationValue(payload, [
      'turn_id',
      'turn-id',
      'turnId',
      'thread_id',
      'thread-id',
      'threadId',
      'session_id',
      'session-id',
      'sessionId',
      'task_id',
      'task-id',
      'taskId',
      'id',
    ]),
    160
  );

  const completedAtValue = Number(
    pickTaskNotificationValue(payload, ['completed_at', 'completed-at', 'completedAt'])
  );
  const completedAt = Number.isFinite(completedAtValue) && completedAtValue > 0
    ? completedAtValue
    : Date.now();

  return {
    eventId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    source,
    taskId,
    title: identity.title,
    project: identity.project,
    completedAt,
  };
}

function getPendingTaskNotificationCount() {
  return taskNotificationQueue.reduce(
    (total, item) => total + (item.summaryCount || 1),
    0
  );
}

function isCodeTaskNotification(notification) {
  return ['codex', 'claude'].includes(notification?.source) || notification?.presentation === 'code-completed';
}

function enqueueCodeTaskNotification(providerId, task) {
  if (!aiCodeRuntime?.isSelected(providerId)) return 'ignored';
  const tool = require('./ai-tools').CATALOG.find((item) => item.id === providerId);
  if (!tool || !aiCodeRuntime.holdCompletion(providerId, task)) return 'ignored';
  let result;
  try {
    result = enqueueTaskNotification({
      eventId: task.id, codeToolId: providerId, presentation: 'code-completed',
      source: providerId === 'claude-code' ? 'claude' : providerId,
      title: `${tool.name} 任务已完成`, project: task.title || '未命名项目',
      taskId: `${task.threadId}:${task.turnId}`, threadId: task.threadId,
      completedAt: task.completedAt, receivedAt: Date.now(),
    });
  } finally {
    if (result !== 'queued') aiCodeRuntime.finishCompletion(task.id);
  }
  return result;
}

function sendTaskNotificationQueueCount() {
  if (
    !notificationWindow ||
    notificationWindow.isDestroyed() ||
    !notificationWindowReady ||
    !activeTaskNotification
  ) {
    return;
  }
  notificationWindow.webContents.send(
    'task-notification:queue',
    getPendingTaskNotificationCount()
  );
}

function enqueueTaskNotification(notification) {
  if (!notification) return 'ignored';
  const now = Date.now();
  for (const [key, seenAt] of recentTaskNotifications) {
    if (now - seenAt > TASK_NOTIFICATION_DEDUPE_MS) recentTaskNotifications.delete(key);
  }

  const identity = notification.taskId || `${notification.title}:${notification.project}`;
  const dedupeKey = `${notification.source}:${identity}`;
  const lastSeenAt = recentTaskNotifications.get(dedupeKey);
  if (lastSeenAt && now - lastSeenAt <= TASK_NOTIFICATION_DEDUPE_MS) return 'duplicate';
  recentTaskNotifications.set(dedupeKey, now);

  if (notification.source !== 'todo') {
    taskCompletionHistory.unshift(notification);
    if (taskCompletionHistory.length > 20) taskCompletionHistory.length = 20;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-completion:new', notification);
    }
  }

  // Code tool confirmations retain each project and its compact presentation.
  // Only the other notification sources share the legacy summary limit.
  const otherCount = taskNotificationQueue.filter(item => !isCodeTaskNotification(item)).length;
  if (isCodeTaskNotification(notification) || otherCount < TASK_NOTIFICATION_MAX_QUEUE) {
    taskNotificationQueue.push(notification);
  } else {
    const lastIndex = taskNotificationQueue.findLastIndex(item => !isCodeTaskNotification(item));
    const previous = taskNotificationQueue[lastIndex];
    const summaryCount = previous.isSummary ? previous.summaryCount + 1 : 2;
    taskNotificationQueue[lastIndex] = {
      ...notification,
      source: 'task',
      taskId: '',
      title: `另有 ${summaryCount} 个任务已完成`,
      project: '',
      isSummary: true,
      summaryCount,
    };
  }

  if (activeTaskNotification) {
    sendTaskNotificationQueueCount();
  } else {
    showNextTaskNotification();
  }
  return 'queued';
}

function clearTodoReminderTimer() {
  if (todoReminderTimer) clearTimeout(todoReminderTimer);
  todoReminderTimer = null;
}

function fireTodoReminder(todo) {
  const deadline = Date.parse(String(todo.deadline || ''));
  const notification = {
    eventId: `todo-${todo.id}-${deadline}`,
    source: 'todo',
    taskId: String(todo.id || ''),
    title: String(todo.text || '').trim() || '待办即将截止',
    project: '',
    detail: '将在 1 小时内截止',
    deadline,
    completedAt: Date.now(),
  };
  enqueueTaskNotification(notification);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('todo:reminded', {
      id: notification.taskId,
      deadline: String(todo.deadline || ''),
      remindedAt: notification.completedAt,
    });
  }
}

function scheduleNextTodoReminder() {
  clearTodoReminderTimer();
  const now = Date.now();
  let nextDelay = Infinity;
  for (const todo of scheduledTodoReminders) {
    const status = todoReminderState(todo, now, TODO_REMINDER_LEAD_MS);
    if (status.state === 'due') {
      todo.remindedAt = now;
      fireTodoReminder(todo);
      continue;
    }
    if (status.state === 'scheduled') nextDelay = Math.min(nextDelay, status.delayMs);
  }
  if (Number.isFinite(nextDelay)) {
    todoReminderTimer = setTimeout(scheduleNextTodoReminder, todoReminderTimerDelay(nextDelay));
  }
}

ipcMain.handle('todos:schedule-reminders', (event, items) => {
  scheduledTodoReminders = Array.isArray(items)
    ? items
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || '').slice(0, 160),
        text: String(item.text || '').trim().slice(0, 160),
        deadline: String(item.deadline || ''),
        done: item.done === true,
        remindedAt: Math.max(0, Number(item.remindedAt) || 0),
      }))
      .filter((item) => item.id && item.text)
    : [];
  scheduleNextTodoReminder();
  return { ok: true, count: scheduledTodoReminders.length };
});

ipcMain.handle('pomodoro:notify', (event, payload) => {
  const minutes = typeof payload === 'object' ? payload?.minutes : payload;
  const nextFocus = payload?.phase === 'focus';
  const safeMinutes = Math.max(1, Math.min(120, Math.round(Number(minutes) || 25)));
  const completedAt = Date.now();
  const notification = {
    eventId: `pomodoro-${completedAt}`,
    taskId: `pomodoro-${completedAt}`,
    source: 'pomodoro',
    project: '番茄钟',
    title: nextFocus ? '休息结束' : '专注完成',
    body: nextFocus ? `开始下一轮 ${safeMinutes} 分钟专注` : '开始 5 分钟休息，之后自动继续专注',
    completedAt,
  };
  return { ok: true, result: enqueueTaskNotification(notification) };
});

function syncTaskNotificationAppearance(snapshot) {
  const target = notificationWindow;
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  if (snapshot.selectedId === 'classic') {
    appearanceNative.clear(target);
    target.notificationGlassReady = false;
  }
  target.webContents.send('appearance:changed', snapshot);
}

function getTaskNotificationBounds(display) {
  const d = display || getWindowDisplay();
  // 316px pair, 16px shadow gutters, 16px below the menu bar and 54px pills.
  return getCenteredBounds(348, Math.max(24, Math.min(80, getCollapsedHeight(d))) + 86, d);
}

function getTaskNotificationPresentation(display = getWindowDisplay()) {
  const codex = isCodeTaskNotification(activeTaskNotification);
  const bounds = getTaskNotificationBounds(display);
  const providerId = activeTaskNotification?.codeToolId || activeTaskNotification?.source;
  const tool = require('./ai-tools').CATALOG.find(item => item.id === (providerId === 'claude' ? 'claude-code' : providerId));
  let reducedMotion = false;
  try { reducedMotion = systemPreferences.getAnimationSettings().prefersReducedMotion; } catch (_) {}
  return {
    compactCode: codex,
    width: bounds.width,
    height: bounds.height,
    stripHeight: Math.max(24, Math.min(80, getCollapsedHeight(display))),
    collapsedWidth: getCollapsedWidth(display),
    appearance: appearanceSettings.getSnapshot(),
    sourceName: tool?.name,
    sourceIcon: tool?.icon,
    visibleMs: TASK_NOTIFICATION_VISIBLE_MS,
    confirmationMs: reducedMotion ? 0 : 420,
  };
}

function recoverClosedTaskNotificationWindow(targetWindow) {
  if (notificationWindow !== targetWindow) return;
  const interruptedNotification = activeTaskNotification;
  clearTaskNotificationTimers();
  notificationWindow = null;
  notificationWindowReady = false;
  activeTaskNotification = null;
  taskNotificationLeaving = false;
  taskNotificationPaused = false;
  taskNotificationRemainingMs = TASK_NOTIFICATION_VISIBLE_MS;
  if (!isQuitting && interruptedNotification) {
    taskNotificationQueue.unshift(interruptedNotification);
  }
  if (!isQuitting) setTimeout(showNextTaskNotification, 80);
}

function createTaskNotificationWindow() {
  if (notificationWindow && !notificationWindow.isDestroyed()) return notificationWindow;
  const bounds = getTaskNotificationBounds();
  notificationWindowReady = false;
  notificationWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    enableLargerThanScreen: true,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    hiddenInMissionControl: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  installLocalWebContentsGuards(notificationWindow.webContents);

  const targetWindow = notificationWindow;
  notificationWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notificationWindow.setIgnoreMouseEvents(false);
  notificationWindow.loadFile(path.join(__dirname, 'renderer', 'notification.html'));

  targetWindow.webContents.once('did-finish-load', () => {
    if (notificationWindow !== targetWindow || targetWindow.isDestroyed()) return;
    notificationWindowReady = true;
    showNextTaskNotification();
  });

  targetWindow.webContents.on('render-process-gone', () => {
    if (!targetWindow.isDestroyed()) targetWindow.destroy();
  });
  targetWindow.on('closed', () => {
    recoverClosedTaskNotificationWindow(targetWindow);
  });
  return notificationWindow;
}

function clearTaskNotificationTimers() {
  if (taskNotificationTimer) {
    clearTimeout(taskNotificationTimer);
    taskNotificationTimer = null;
  }
  if (taskNotificationFallbackTimer) {
    clearTimeout(taskNotificationFallbackTimer);
    taskNotificationFallbackTimer = null;
  }
}

function scheduleTaskNotificationDismiss() {
  if (!activeTaskNotification || taskNotificationLeaving || taskNotificationPaused) return;
  if (taskNotificationTimer) clearTimeout(taskNotificationTimer);
  taskNotificationTimerStartedAt = Date.now();
  taskNotificationTimer = setTimeout(
    beginTaskNotificationDismiss,
    Math.max(0, taskNotificationRemainingMs)
  );
}

function setTaskNotificationPaused() {
  // Keep the IPC entry compatible; every passive bookmark now has a fixed hold.
}

function showNextTaskNotification() {
  if (activeTaskNotification || taskNotificationQueue.length === 0 || isQuitting) return;
  if (systemUIBlocks(getTaskNotificationBounds())) return;
  const targetWindow = createTaskNotificationWindow();
  if (!notificationWindowReady || !targetWindow || targetWindow.isDestroyed()) return;

  hideQuickIsland(true);
  dismissNotchPreviewSurface();
  statusIsland.hide(true);

  activeTaskNotification = taskNotificationQueue.shift();
  taskNotificationLeaving = false;
  taskNotificationPaused = false;
  const display = getWindowDisplay();
  const presentation = getTaskNotificationPresentation(display);
  taskNotificationRemainingMs = presentation.confirmationMs + presentation.visibleMs;
  targetWindow.setBounds(getTaskNotificationBounds(display));
  targetWindow.showInactive();
  targetWindow.webContents.send('task-notification:show', {
    ...activeTaskNotification,
    pendingCount: getPendingTaskNotificationCount(),
    ...presentation,
  });
  scheduleTaskNotificationDismiss();
}

function beginTaskNotificationDismiss() {
  if (!activeTaskNotification || taskNotificationLeaving) return;
  taskNotificationLeaving = true;
  clearTaskNotificationTimers();
  const eventId = activeTaskNotification.eventId;
  if (notificationWindow && !notificationWindow.isDestroyed() && notificationWindowReady) {
    notificationWindow.webContents.send('task-notification:hide', eventId);
  }
  taskNotificationFallbackTimer = setTimeout(
    () => finishTaskNotification(eventId),
    TASK_NOTIFICATION_LEAVE_MS + 120
  );
}

function finishTaskNotification(eventId) {
  if (!activeTaskNotification || activeTaskNotification.eventId !== eventId) return;
  clearTaskNotificationTimers();
  const completedWindow = notificationWindow;
  if (completedWindow && !completedWindow.isDestroyed()) {
    appearanceNative.clear(completedWindow);
    completedWindow.hide();
  }
  // Release only after this specific popup is gone; queued completions retain
  // their counts, including when several finish between status polls.
  aiCodeRuntime?.finishCompletion(eventId);
  activeTaskNotification = null;
  taskNotificationLeaving = false;
  taskNotificationPaused = false;
  taskNotificationRemainingMs = TASK_NOTIFICATION_VISIBLE_MS;
  setTimeout(() => {
    showNextTaskNotification();
    const policy = taskNotificationWindowPolicy({
      active: Boolean(activeTaskNotification),
      queueLength: taskNotificationQueue.length,
    });
    if (
      policy === 'dispose'
      && notificationWindow === completedWindow
      && completedWindow
      && !completedWindow.isDestroyed()
    ) {
      completedWindow.destroy();
    }
  }, 80);
}

function sendTaskNotificationResponse(response, statusCode, body) {
  if (response.headersSent) return;
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  response.end(json);
}

function startTaskNotificationServer() {
  if (notificationServer) return;
  const lifecycleHandler = createLifecycleHttpHandler({
    token: getLifecycleToken(app.getPath('userData')),
    ingest: (payload) => codexFloat.ingestTaskEvent(payload),
  });
  const server = http.createServer((request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url || '/', `http://${TASK_NOTIFICATION_HOST}`);
    } catch (error) {
      sendTaskNotificationResponse(response, 400, { ok: false, error: 'invalid_url' });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      sendTaskNotificationResponse(response, 200, {
        ok: true,
        version: app.getVersion(),
        systemHud: publicHudReplacementStatus(),
        codex: codexFloat.getDiagnostics(),
      });
      return;
    }
    if (requestUrl.pathname === '/codex-lifecycle') {
      lifecycleHandler(request, response);
      return;
    }

    const sourceMatch = /^\/notify\/([a-z0-9-]{1,32})$/i.exec(requestUrl.pathname);
    const requestedSource = sourceMatch ? sourceMatch[1].toLowerCase() : '';
    const source = TASK_NOTIFICATION_SOURCES.has(requestedSource) ? requestedSource : null;
    if (request.method !== 'POST' || !source) {
      sendTaskNotificationResponse(response, 404, { ok: false, error: 'not_found' });
      return;
    }
    const contentType = String(request.headers['content-type'] || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      sendTaskNotificationResponse(response, 415, {
        ok: false,
        error: 'application_json_required',
      });
      return;
    }

    const chunks = [];
    let bodyLength = 0;
    let bodyTooLarge = false;
    request.on('data', (chunk) => {
      bodyLength += chunk.length;
      if (bodyLength > TASK_NOTIFICATION_BODY_LIMIT) {
        bodyTooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!bodyTooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (bodyTooLarge) {
        sendTaskNotificationResponse(response, 413, { ok: false, error: 'body_too_large' });
        return;
      }
      let payload;
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8').trim();
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (error) {
        sendTaskNotificationResponse(response, 400, { ok: false, error: 'invalid_json' });
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendTaskNotificationResponse(response, 400, { ok: false, error: 'invalid_payload' });
        return;
      }
      if ((source === 'codex' && !aiCodeRuntime.isSelected('codex'))
        || (source === 'claude' && !aiCodeRuntime.isSelected('claude-code'))) {
        sendTaskNotificationResponse(response, 202, { ok: true, ignored: 'tool_not_selected' });
        return;
      }
      const result = enqueueTaskNotification(normalizeTaskNotification(payload, source));
      sendTaskNotificationResponse(response, 202, { ok: true, result });
    });
    request.on('error', () => {
      if (!response.headersSent) sendTaskNotificationResponse(response, 400, { ok: false });
    });
  });
  notificationServer = server;

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.once('listening', () => {
    if (notificationServer !== server) return;
    notificationServerAvailable = true;
    refreshTrayMenu();
  });
  server.on('error', (error) => {
    if (notificationServer === server) notificationServer = null;
    notificationServerAvailable = false;
    refreshTrayMenu();
    console.warn(`Task notification server unavailable: ${error.message}`);
  });
  server.listen(TASK_NOTIFICATION_PORT, TASK_NOTIFICATION_HOST);
}

function stopTaskNotificationServer() {
  const server = notificationServer;
  notificationServer = null;
  notificationServerAvailable = false;
  if (server) server.close();
}

ipcMain.on('task-notification:surface', (event, payload) => {
  const target = notificationWindow;
  if (!target || target.isDestroyed() || event.sender !== target.webContents
    || !event.senderFrame || event.senderFrame !== target.webContents.mainFrame) return;
  try {
    if (fileURLToPath(event.senderFrame.url) !== path.join(__dirname, 'renderer', 'notification.html')) return;
  } catch (_) { return; }
  if (!activeTaskNotification || payload?.eventId !== activeTaskNotification.eventId) return;
  const appearance = appearanceSettings.getSnapshot();
  const values = target.isVisible() && !taskNotificationPaused && appearance.selectedId === 'system-glass-blurred'
    && Array.isArray(payload.surfaces) && payload.surfaces.length === 2
    ? payload.surfaces.map(surface => normalizeAppearanceSurface({ viewport: payload.viewport, surface }, target.getContentBounds())) : [];
  const applied = values.length === 2 && values.every(Boolean) ? appearanceNative.applyPair(target, values) : false;
  if (!applied) appearanceNative.clear(target);
  if (target.notificationGlassReady !== applied) {
    target.notificationGlassReady = applied;
    target.webContents.send('task-notification:material', { native: applied, appearance });
  }
});

ipcMain.on('task-notification:hover', (event, paused) => {
  if (
    notificationWindow &&
    !notificationWindow.isDestroyed() &&
    event.sender === notificationWindow.webContents
  ) {
    setTaskNotificationPaused(paused === true);
  }
});

ipcMain.on('task-notification:dismissed', (event, eventId) => {
  if (
    notificationWindow &&
    !notificationWindow.isDestroyed() &&
    event.sender === notificationWindow.webContents &&
    typeof eventId === 'string'
  ) {
    finishTaskNotification(eventId);
  }
});

function createWindow() {
  const initial = getBoundsForMode('collapsed', getTargetDisplay());

  mainWindow = new BrowserWindow({
    title: '工作台',
    width: initial.width,
    height: initial.height,
    x: initial.x,
    y: initial.y,
    frame: false,
    transparent: true,
    // 必须显式给透明底色：只写 transparent 时 BrowserWindow 仍保留不透明的默认底色，
    // 展开瞬间 setBounds 放大后，新暴露的区域会先用它画一两帧，
    // 在菜单栏带上表现为一次黑块闪烁（通知窗口一直是这么写的）。
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    // macOS caches shadows of transparent windows across shape changes; the
    // renderer owns the island edge/shadow so collapsed frames leave no trail.
    hasShadow: false,
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A hidden/occluded window must finish its closing frames before the
      // native watchdog resizes it, keeping renderer and native modes aligned.
      backgroundThrottling: false,
    },
  });

  installLocalWebContentsGuards(mainWindow.webContents);

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  appearanceNative.pinWindow(mainWindow);

  // Escape 在到达页面前会被 Chromium 浏览器层吞掉（实测 document keydown 收不到），
  // 用 before-input-event 在分发前拦截并转发给渲染层处理（退出输入 / 收起面板）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      mainWindow.webContents.send('key:escape');
    }
  });

  // 点击桌面／切换应用立即收回，避免与 macOS 显示桌面的系统动画叠加。
  mainWindow.on('blur', () => {
    if (windowHandoff.isCommitting()) return;
    if (mediaPermissionRequests > 0 || transientSystemInteractionRequests > 0) {
      cameraBlurDeferred = true;
      return;
    }
    requestRendererCollapse({ immediate: true });
  });

  mainWindow.on('focus', () => {
    cameraBlurDeferred = false;
  });
  mainWindow.on('show', syncHoverSpacePolling);
  mainWindow.webContents.on('render-process-gone', () => {
    islandActivities.recording = null;
    islandActivities.timer = null;
    updateIslandActivities();
  });
  mainWindow.on('hide', () => {
    islandPasteTargetPrepared = null;
    notchPreviewActive = false;
    hideQuickIsland(true);
    statusIsland.hide(true);
    syncHoverSpacePolling();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    applyMode('collapsed');
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    islandPasteTargetPrepared = null;
    notchPreviewActive = false;
    hideQuickIsland(true);
    statusIsland.hide(true);
    cancelCollapseWatchdog();
    hideWhenCollapsed = false;
    mainWindow = null;
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideWindowAfterCollapse();
  });
}

function toggleVisibility() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    hideWindowAfterCollapse();
  } else {
    hideWhenCollapsed = false;
    repositionWindow(getTargetDisplay()); // 显示前先回到鼠标所在屏顶部
    mainWindow.show();
    refreshTrayMenu();
  }
}

function isAutoLaunchEnabled() {
  if (process.platform !== 'darwin') return false;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
}

function setAutoLaunch(enabled) {
  if (process.platform !== 'darwin') return false;
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
    return isAutoLaunchEnabled() === enabled;
  } catch (e) {
    return false;
  }
}

const DEFAULT_FEATURES = {
  home: true,
  todo: true,
  projects: true,
  notes: true,
  links: true,
  recordings: true,
  credentials: true,
  clip: false,
};

function getJsonSettingsPath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJsonFile(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (unlinkError) {}
    return false;
  }
}

function readAppSettings() {
  const stored = readJsonFile(getJsonSettingsPath(APP_SETTINGS_FILE));
  return {
    features: { ...DEFAULT_FEATURES, ...(stored.features || {}), home: true },
    shortcut: isValidPanelShortcut(stored.shortcut) ? stored.shortcut : 'Space',
  };
}

function publicAppSettings() {
  return { ...readAppSettings(), autoLaunch: isAutoLaunchEnabled() };
}

function saveAppSettings(settings) {
  return writeJsonFile(getJsonSettingsPath(APP_SETTINGS_FILE), settings);
}

function workspaceRoot() {
  const settings = readJsonFile(getJsonSettingsPath(WORKSPACE_SETTINGS_FILE));
  const configured = String(settings.path || '').trim();
  return configured && path.isAbsolute(configured) ? configured : app.getPath('userData');
}

function workspacePath(name) {
  return path.join(workspaceRoot(), name);
}

function showOwnedOpenDialog(options, preferredOwner = mainWindow) {
  const owner = preferredOwner && !preferredOwner.isDestroyed() ? preferredOwner : null;
  return runOwnedOpenDialog(
    (...args) => {
      if (owner) {
        if (!owner.isVisible()) owner.show();
        owner.focus();
      }
      return dialog.showOpenDialog(...args);
    },
    owner,
    options,
    (delta) => {
      transientSystemInteractionRequests = Math.max(0, transientSystemInteractionRequests + delta);
      if (delta < 0 && transientSystemInteractionRequests === 0 && mediaPermissionRequests === 0) {
        cameraBlurDeferred = false;
      }
    }
  );
}

function copyWorkspaceAssets(sourceRoot, targetRoot) {
  if (!sourceRoot || !targetRoot || path.resolve(sourceRoot) === path.resolve(targetRoot)) return;
  const names = [RECORDINGS_DIR_NAME, CLIP_IMAGES_DIR_NAME, WORKSPACE_DATA_FILE, MIRROR_IMAGE_FILE];
  // Choosing a data folder migrates this workspace; it must never overwrite or
  // merge another workspace. Check all destinations before copying anything.
  for (const name of names) {
    try {
      fs.lstatSync(path.join(targetRoot, name));
      throw Object.assign(new Error('workspace_exists'), { code: 'workspace_exists' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const name of names) {
    const source = path.join(sourceRoot, name);
    let stat;
    try { stat = fs.lstatSync(source); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('invalid_workspace_asset');
    fs.cpSync(source, path.join(targetRoot, name), { recursive: true, force: false, errorOnExist: true });
  }
}

async function chooseWorkspaceFolder() {
  const result = await showOwnedOpenDialog({
    title: '选择悬浮岛数据文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  const selected = !result.canceled && result.filePaths && result.filePaths[0];
  if (!selected) return false;
  const previousRoot = workspaceRoot();
  try {
    if (fs.realpathSync(previousRoot) === fs.realpathSync(selected)) return false;
    copyWorkspaceAssets(previousRoot, selected);
    for (const directory of [RECORDINGS_DIR_NAME, CLIP_IMAGES_DIR_NAME]) {
      fs.mkdirSync(path.join(selected, directory), { recursive: true });
    }
    if (!writeJsonFile(getJsonSettingsPath(WORKSPACE_SETTINGS_FILE), { path: selected })) throw new Error('save_failed');
  } catch (error) {
    await dialog.showMessageBox({ type: 'warning', buttons: ['好'],
      message: error.code === 'workspace_exists' ? '这个文件夹已有悬浮岛数据' : '数据文件夹未更换',
      detail: error.code === 'workspace_exists'
        ? '原有数据已保留，请选择未存放悬浮岛数据的文件夹。'
        : '未能完整复制或保存数据，悬浮岛继续使用原文件夹。请检查目标文件夹的权限和剩余空间。',
    });
    return false;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:changed', { path: selected });
  refreshTrayMenu();
  return true;
}

function applyFeatureServices(features) {
  const policy = clipboardServicePolicy(features);
  if (policy.recordHistory) startClipboardPolling();
  else stopClipboardPolling();
}

function isValidPanelShortcut(shortcut) {
  if (shortcut === 'Space') return true;
  if (typeof shortcut !== 'string' || shortcut.length > 80) return false;
  const tokens = shortcut.split('+');
  if (tokens.length < 2) return false;
  const key = tokens.pop();
  const modifiers = new Set(['CommandOrControl', 'Command', 'Control', 'Alt', 'Option', 'Shift']);
  return tokens.length > 0
    && tokens.every((token) => modifiers.has(token))
    && /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Escape|Left|Right|Up|Down|Home|End|PageUp|PageDown|Backspace|Delete|Enter)$/.test(key);
}

function setPanelShortcut(shortcut) {
  if (!isValidPanelShortcut(shortcut)) return false;
  const previousShortcut = configuredShortcut || 'Space';
  // Keep the working shortcut (including hover Space) until the replacement
  // is registered. An occupied accelerator must leave the previous one intact.
  if (shortcut !== 'Space' && !(shortcut === previousShortcut && globalShortcut.isRegistered(shortcut))) {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcut, () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        hideWhenCollapsed = false;
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('shortcut:toggle-panel');
      });
    } catch (error) {}
    if (!registered) return false;
  }
  stopHoverSpaceShortcut();
  if (previousShortcut !== 'Space' && previousShortcut !== shortcut && globalShortcut.isRegistered(previousShortcut)) {
    globalShortcut.unregister(previousShortcut);
  }
  configuredShortcut = shortcut;
  if (shortcut === 'Space') startHoverSpaceShortcut();
  return true;
}

function applyAppSettings() {
  const settings = readAppSettings();
  applyFeatureServices(settings.features);
  if (!setPanelShortcut(settings.shortcut)) {
    settings.shortcut = 'Space';
    saveAppSettings(settings);
    setPanelShortcut('Space');
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', publicAppSettings());
}

function openRendererPanel(channel) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  hideWhenCollapsed = false;
  repositionWindow(getTargetDisplay());
  mainWindow.show();
  const send = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
  };
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

function mirrorImagePath() {
  return workspacePath(MIRROR_IMAGE_FILE);
}

function mirrorImageDataUrl() {
  try {
    const image = nativeImage.createFromPath(mirrorImagePath());
    if (image.isEmpty()) return null;
    return image.toDataURL();
  } catch (error) {
    return null;
  }
}

async function chooseMirrorImage() {
  const result = await showOwnedOpenDialog({
    title: '替换镜子配图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic'] }],
  });
  const selected = !result.canceled && result.filePaths && result.filePaths[0];
  if (!selected) return { ok: true, canceled: true };
  try {
    const image = nativeImage.createFromPath(selected);
    if (image.isEmpty()) throw new Error('invalid_image');
    const size = image.getSize();
    if (!size.width || !size.height || size.width * size.height > 60_000_000) throw new Error('image_too_large');
    fs.writeFileSync(mirrorImagePath(), image.toJPEG(92), { mode: 0o600 });
    const dataUrl = mirrorImageDataUrl();
    if (dataUrl && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mirror:image-changed', dataUrl);
    }
    return { ok: true, canceled: false, dataUrl };
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title: '无法替换配图', message: '请选择一张有效且尺寸适中的图片。' });
    return { ok: false, error: 'invalid_image' };
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const autoLaunch = isAutoLaunchEnabled();
  const settings = readAppSettings();
  const featureLabels = { todo: '待办', projects: '项目抽屉', notes: '笔记', links: '链接', recordings: '电脑状态', credentials: '密钥', clip: '剪贴板' };
  const menu = Menu.buildFromTemplate([
    {
      label: 'API 配置…',
      click: () => openRendererPanel('app:open-api-settings'),
    },
    {
      label: '替换镜子配图…',
      click: chooseMirrorImage,
    },
    {
      label: '显示功能',
      submenu: Object.entries(featureLabels).map(([id, label]) => ({
        label,
        type: 'checkbox',
        checked: settings.features[id] !== false,
        click: (item) => {
          const next = readAppSettings();
          next.features[id] = item.checked;
          saveAppSettings(next);
          applyAppSettings();
          refreshTrayMenu();
        },
      })),
    },
    {
      label: `设置快捷键…  当前：${settings.shortcut}`,
      click: () => openRendererPanel('app:record-shortcut'),
    },
    {
      label: '数据文件夹',
      submenu: [
        { label: '在访达中打开', click: () => shell.openPath(workspaceRoot()) },
        { label: '更换文件夹…', click: chooseWorkspaceFolder },
      ],
    },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: autoLaunch,
      click: (item) => {
        setAutoLaunch(item.checked);
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '关于',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: '关于悬浮岛',
          message: '悬浮岛',
          detail:
            `版本 ${app.getVersion()}\n\n一个开源、常驻 macOS 屏幕顶部的本地工作台。工作区数据默认保存在本机；账号密码与 API Key 由 macOS 安全存储加密。\n\nMIT License`,
          buttons: ['查看 GitHub', '好'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        }).then(({ response }) => {
          if (response === 0) shell.openExternal('https://github.com/xiaopu-ai/TO-DO-Panel');
        });
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      accelerator: 'Cmd+Q',
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(createNotchTrayIcon());
  tray.setToolTip('悬浮岛');
  tray.on('click', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) {
      hideWhenCollapsed = false;
      repositionWindow(getTargetDisplay());
      mainWindow.show();
      refreshTrayMenu();
    }
  });
  refreshTrayMenu();
}

ipcMain.handle('quick-island:show', (event, options) => {
  if (!isIslandSender(event) && !isStatusIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return showQuickIsland(options);
});

ipcMain.handle('quick-island:hide', (event, options) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return hideQuickIsland(false, options?.reason === 'hover' ? 'hover' : 'explicit');
});

async function openIslandWorkspace(tab, motionInput) {
  if (typeof tab !== 'string' || !QUICK_ISLAND_WORKSPACE_TABS.has(tab)) return { ok: false, error: 'invalid_tab' };
  const target = mainWindow;
  if (!target || target.isDestroyed() || isQuitting) return { ok: false, error: 'island_unavailable' };
  const outgoing = quickIslandWindow;
  if (outgoing && !outgoing.isDestroyed() && outgoing.isVisible() && outgoing.getOpacity() > 0
    && (currentMode === 'collapsed' || windowHandoff.isSource(outgoing))) {
    windowHandoff.cancel('superseded');
    const motion = normalizeWindowMotion(motionInput, outgoing.getContentBounds());
    return windowHandoff.begin({
      source: outgoing, target,
      prepare: async (handoffId) => {
        workbenchOpeningUntil = Date.now() + 5000;
        stopQuickIslandPointerWatch();
        await rememberPasteTarget();
        if (!windowHandoff.isCurrent(handoffId)) return;
        islandPasteTargetPrepared = { window: target, expiresAt: Date.now() + 5000 };
        target.setOpacity(0);
        target.webContents.send('island:open-workspace', tab, { handoffId, motion, targetHeight: getBoundsForMode('expanded').height });
      },
      commit: () => {
        target.setOpacity(1);
        target.show();
        target.focus();
        hideQuickIsland(true);
        workbenchOpeningUntil = 0;
      },
      animate: handoffId => target.webContents.send('window:motion-play', handoffId),
      settle: handoffId => {
        if (!target.isDestroyed()) target.webContents.send('window:motion-cleanup', handoffId);
      },
      rollback: (handoffId) => {
        workbenchOpeningUntil = 0;
        if (!target.isDestroyed()) {
          target.webContents.send('window:motion-cleanup', handoffId);
          applyMode('collapsed');
          target.webContents.send('window:request-collapse', { immediate: true });
          setCollapsedIslandCovered(!outgoing.isDestroyed() && outgoing.isVisible());
        }
        if (!outgoing.isDestroyed() && outgoing.isVisible()) startQuickIslandPointerWatch();
      },
    });
  }
  windowHandoff.cancel('workspace_requested');
  const openingRevision = ++workbenchOpeningRevision;
  workbenchOpeningUntil = Date.now() + 5000;
  hideQuickIsland(true);
  void statusIsland.syncForAppSurface();
  const needsPasteTarget = currentMode === 'collapsed';
  if (needsPasteTarget) await rememberPasteTarget();
  if (mainWindow !== target || target.isDestroyed() || isQuitting) {
    if (openingRevision === workbenchOpeningRevision) workbenchOpeningUntil = 0;
    void statusIsland.sync();
    return { ok: false, error: 'island_unavailable' };
  }
  if (needsPasteTarget) islandPasteTargetPrepared = { window: target, expiresAt: Date.now() + 5000 };
  hideWhenCollapsed = false;
  // 渲染层先准备透明 opening 状态，再经双 RAF 请求原生扩展，避免菜单栏闪黑。
  target.show();
  target.focus();
  target.webContents.send('island:open-workspace', tab);
  return { ok: true };
}

ipcMain.handle('quick-island:open-workspace', async (event, tab, motion) => {
  if (!isIslandSender(event) && !isStatusIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return openIslandWorkspace(tab, event.sender === quickIslandWindow?.webContents ? motion : null);
});

ipcMain.handle('quick-island:return', async (event, motionInput) => {
  if (!isIslandSender(event, false) || currentMode !== 'expanded' || isQuitting) return { ok: false, error: 'island_unavailable' };
  const outgoing = mainWindow;
  windowHandoff.cancel('superseded');
  const motion = normalizeWindowMotion(motionInput, outgoing.getContentBounds());
  const display = getWindowDisplay();
  const target = await createQuickIslandWindow(display);
  if (!target || target.isDestroyed() || outgoing !== mainWindow || outgoing.isDestroyed() || currentMode !== 'expanded' || isQuitting) {
    return { ok: false, error: 'island_unavailable' };
  }
  const bounds = getQuickIslandBounds(display);
  return windowHandoff.begin({
    source: outgoing, target,
    prepare: (handoffId) => {
      stopQuickIslandPointerWatch();
      if (quickIslandHideTimer) clearTimeout(quickIslandHideTimer);
      quickIslandHideTimer = null;
      target.setOpacity(0);
      target.setBounds({ ...bounds, height: motion ? Math.max(bounds.height, motion.viewport.height) : bounds.height });
      target.setAlwaysOnTop(true, 'screen-saver', 1);
      target.showInactive();
      target.webContents.send('quick-island:show', {
        stripHeight: getCollapsedHeight(display), menuBarHeight: getMenuBarHeight(display),
        collapsedWidth: COLLAPSED_WIDTH, width: bounds.width, height: bounds.height,
        interactive: false, version: app.getVersion(), handoffId, motion,
      });
      target.webContents.send('island:activities', islandActivities);
    },
    commit: () => {
      quickIslandInteractive = false;
      quickIslandNativeFocusable = false;
      target.setFocusable(false);
      target.setOpacity(1);
      target.showInactive();
      outgoing.setOpacity(0);
      applyMode('collapsed');
      outgoing.webContents.send('window:request-collapse', { immediate: true });
      setCollapsedIslandCovered(true);
      startQuickIslandPointerWatch();
    },
    animate: handoffId => target.webContents.send('window:motion-play', handoffId),
    settle: (handoffId, surface) => {
      if (target.isDestroyed()) return;
      if (target.getBounds().height !== bounds.height) {
        target.setBounds(bounds);
        // Resizing clears the native backdrop. Reapply the final sampled mask
        // in the same turn, before Chromium's resize event can expose a frame.
        if (surface && appearanceSettings.getSnapshot().selectedId !== 'classic') {
          appearanceNative.apply(target, { ...surface, height: Math.min(surface.height, bounds.height - surface.y) });
        }
      }
      target.webContents.send('window:motion-cleanup', handoffId);
    },
    rollback: (handoffId) => {
      if (!target.isDestroyed()) {
        target.webContents.send('window:motion-cleanup', handoffId);
        target.hide();
        target.setOpacity(1);
        appearanceNative.clear(target);
        target.webContents.send('quick-island:hide');
      }
    },
  });
});

ipcMain.on('window:surface-ready', (event, handoffId, motionReady) => {
  if (isIslandSender(event) && Number.isSafeInteger(handoffId)) windowHandoff.ready(event.sender, handoffId, motionReady);
});
ipcMain.handle('window:motion-complete', (event, handoffId) => {
  if (!isIslandSender(event) || !Number.isSafeInteger(handoffId)) return { ok: false };
  return { ok: windowHandoff.complete(event.sender, handoffId) };
});

ipcMain.handle('system:volume:get', (event) => {
  if (!isIslandSender(event) && !isStatusIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return Promise.resolve(systemStatus.getSnapshot()).then((state) => state?.volume?.ok ? state.volume : getSystemVolume());
});

ipcMain.handle('system:volume:set', async (event, volume) => {
  if (!isIslandSender(event) && !isStatusIslandSender(event)) return { ok: false, error: 'unauthorized' };
  const snapshot = await systemStatus.getSnapshot();
  return snapshot?.volume?.ok ? systemStatus.setVolume(volume) : setSystemVolume(volume);
});

ipcMain.handle('system:status:get', (event) => {
  if (!isIslandSender(event) && !isStatusIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return systemStatus.getSnapshot();
});

ipcMain.on('island:status-surface', (event, payload) => { if (isStatusIslandSender(event)) statusIsland.updateSurface(payload); });
ipcMain.on('island:status-hold', (event, held) => { if (isStatusIslandSender(event)) statusIsland.hold(held); });
ipcMain.handle('island:status-dismiss', (event) => {
  if (!isStatusIslandSender(event)) return { ok: false, error: 'unauthorized' };
  statusIsland.dismiss();
  return { ok: true };
});

ipcMain.on('island:activity-update', (event, payload) => {
  if (!isIslandSender(event, false)) return;
  const state = cleanActivity(payload);
  if (!state) return;
  islandActivities[state.kind] = state;
  updateIslandActivities();
});
ipcMain.handle('island:activities-get', (event) => {
  if (!isIslandSender(event) && !isStatusIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return islandActivities;
});

ipcMain.handle('window:set-mode', async (event, mode) => {
  if (!isIslandSender(event, false)) return { ok: false, error: 'unauthorized' };
  if (mode === 'preview') {
    if (!mainWindow || mainWindow.isDestroyed() || currentMode !== 'collapsed'
      || systemUIBlocks(getBoundsForMode('preview'))
      || quickIslandOpening > 0 || Date.now() < workbenchOpeningUntil || activeTaskNotification
      || (notificationWindow && !notificationWindow.isDestroyed() && notificationWindow.isVisible())) {
      return { ok: false, error: 'preview_unavailable' };
    }
    if (quickIslandWindow && !quickIslandWindow.isDestroyed() && quickIslandWindow.isVisible()) {
      return { ok: false, error: 'preview_unavailable' };
    }
    mainWindow.setBounds(getBoundsForMode('preview'));
    notchPreviewActive = true;
    return { ok: true, mode: 'preview' };
  }
  const prepared = islandPasteTargetPrepared;
  islandPasteTargetPrepared = null;
  if (mode === 'expanded' && !(prepared && prepared.window === mainWindow
    && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && Date.now() < prepared.expiresAt)) {
    await rememberPasteTarget();
  }
  applyMode(mode === 'expanded' ? 'expanded' : 'collapsed');
  return { ok: true, mode: mode === 'expanded' ? 'expanded' : 'collapsed' };
});

ipcMain.handle('window:begin-collapse', () => {
  beginNativeCollapse();
});

ipcMain.handle('app:quit', (event) => {
  if (!isIslandSender(event, false)) return { ok: false, error: 'unauthorized' };
  setImmediate(() => app.quit());
  return { ok: true };
});

ipcMain.handle('settings:get', () => publicAppSettings());
ipcMain.handle('window-size:get', (event) => {
  if (!isIslandSender(event)) return null;
  return windowSizeSettings.getSnapshot();
});
ipcMain.handle('window-size:set', async (event, presetId) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  const result = await windowSizeSettings.setPreset(presetId);
  if (result.ok) {
    // Resize in place: do not change focus, the active page, or collapse state.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (currentMode === 'expanded') {
        appearanceNative.clear(mainWindow);
        mainWindow.setBounds(getBoundsForMode('expanded'));
      }
      mainWindow.webContents.send('window:metrics-changed', getLayoutMetrics());
    }
    if (quickIslandWindow && !quickIslandWindow.isDestroyed()) {
      const display = screen.getDisplayMatching(quickIslandWindow.getBounds());
      appearanceNative.clear(quickIslandWindow);
      quickIslandWindow.setBounds(getQuickIslandBounds(display));
    }
    broadcastIsland('window-size:changed', result.snapshot);
  }
  return result;
});
ipcMain.handle('appearance:get', (event) => {
  if (!isIslandSender(event)) return null;
  return appearanceSettings.getSnapshot();
});
ipcMain.handle('appearance:set', async (event, presetId) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  const result = await appearanceSettings.setPreset(presetId);
  if (result.ok) {
    if (result.snapshot.selectedId === 'classic') {
      appearanceNative.clear(mainWindow);
      appearanceNative.clear(quickIslandWindow);
    }
    broadcastIsland('appearance:changed', result.snapshot);
    syncTaskNotificationAppearance(result.snapshot);
    statusIsland.syncAppearance(result.snapshot);
  }
  return result;
});
ipcMain.on('appearance:surface', (event, payload) => {
  if (!isIslandSender(event)) return;
  const owner = event.sender === mainWindow?.webContents ? mainWindow : quickIslandWindow;
  if (!owner || owner.isDestroyed()) return;
  if (windowHandoff.isSource(owner)) return;
  const preparing = windowHandoff.isTarget(owner);
  const surface = (!preparing && (!owner.isVisible() || (owner === mainWindow && currentMode !== 'expanded')
    || (owner === quickIslandWindow && currentMode !== 'collapsed')
    )) || appearanceSettings.getSnapshot().selectedId === 'classic'
    ? null : normalizeAppearanceSurface(payload, owner.getContentBounds());
  windowHandoff.recordSurface(owner, surface);
  if (surface) appearanceNative.apply(owner, surface);
  else appearanceNative.clear(owner);
});
ipcMain.handle('settings:set-feature', (event, payload) => {
  const current = readAppSettings();
  const features = updateFeaturePreference(current.features, payload && payload.featureId, payload && payload.enabled);
  if (!features) return { ok: false, error: 'invalid_feature' };
  const next = { ...current, features };
  if (!saveAppSettings(next)) return { ok: false, error: 'save_failed' };
  applyAppSettings();
  refreshTrayMenu();
  return { ok: true, settings: publicAppSettings() };
});
ipcMain.handle('settings:set-auto-launch', (event, enabled) => {
  if (typeof enabled !== 'boolean') return { ok: false, error: 'invalid' };
  if (!setAutoLaunch(enabled)) return { ok: false, error: 'save_failed', autoLaunch: isAutoLaunchEnabled() };
  const settings = publicAppSettings();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', settings);
  refreshTrayMenu();
  return { ok: true, autoLaunch: settings.autoLaunch };
});
ipcMain.handle('settings:set-shortcut', (event, accelerator) => {
  if (!isValidPanelShortcut(accelerator)) return { ok: false, error: 'invalid' };
  if (!setPanelShortcut(accelerator)) return { ok: false, error: 'occupied' };
  const next = readAppSettings();
  next.shortcut = accelerator;
  if (!saveAppSettings(next)) return { ok: false, error: 'save_failed' };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', publicAppSettings());
  refreshTrayMenu();
  return { ok: true, shortcut: accelerator };
});
ipcMain.handle('workspace:get', () => ({ path: workspaceRoot(), portable: workspaceRoot() !== app.getPath('userData') }));
ipcMain.handle('workspace:load-data', () => {
  const payload = readJsonFile(workspacePath(WORKSPACE_DATA_FILE), {});
  return payload && payload.localStorage && typeof payload.localStorage === 'object'
    ? payload.localStorage
    : {};
});

function normalizePortableStorage(storage) {
  const portable = { ...storage };
  const normalizers = [
    ['notch-recordings', 'audioPath', RECORDINGS_DIR_NAME],
    ['notch-clip-history', 'imagePath', CLIP_IMAGES_DIR_NAME],
  ];
  for (const [storageKey, property, directory] of normalizers) {
    try {
      const rows = JSON.parse(portable[storageKey]);
      if (!Array.isArray(rows)) continue;
      portable[storageKey] = JSON.stringify(rows.map((row) => {
        if (!row || typeof row !== 'object' || !row[property]) return row;
        const basename = path.basename(String(row[property]));
        return { ...row, [property]: path.join(directory, basename) };
      }));
    } catch (error) {}
  }
  return portable;
}

ipcMain.handle('workspace:save-data', (event, storage) => {
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return false;
  const portableStorage = normalizePortableStorage(storage);
  const serialized = JSON.stringify(portableStorage);
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) return false;
  const destination = workspacePath(WORKSPACE_DATA_FILE);
  if (!workspacePersistenceGate.shouldWrite(portableStorage, destination)) return true;
  const written = writeJsonFile(destination, {
    version: 1,
    updatedAt: Date.now(),
    localStorage: portableStorage,
  });
  if (written) workspacePersistenceGate.markWritten(portableStorage, destination);
  return written;
});
ipcMain.handle('workspace:open', () => shell.openPath(workspaceRoot()));
ipcMain.handle('workspace:choose', () => chooseWorkspaceFolder());

require('./project-drawer-electron').installProjectDrawer({
  app, ipcMain, shell, powerMonitor,
  isSender: (event) => isIslandSender(event, false),
  chooseDirectory: showOwnedOpenDialog,
  onChange: (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('projects:changed', snapshot);
  },
});

function getLayoutMetrics(display) {
  const d = display || getWindowDisplay();
  return {
    stripHeight: getCollapsedHeight(d), // 侧翼与原刘海等高，没有信息下沿。
    previewHeight: getNotchPreviewHeight(d),
    collapsedWidth: getCollapsedWidth(d),
    notchCenterWidth: COLLAPSED_CENTER_WIDTH,
    notchWingWidth: (getCollapsedWidth(d) - COLLAPSED_CENTER_WIDTH) / 2,
    menuBarHeight: getMenuBarHeight(d), // 折叠态菜单栏带高（折叠条上半部分被其拦截）
    safeAreaTop: getMenuBarHeight(d),
    chromeY: getMenuBarHeight(d) + EXPANDED_CHROME_Y,
    tabSizes: Object.fromEntries(Object.entries(TAB_SIZES).map(([id, size]) => [id, { ...size, width: windowSizeSettings.getSnapshot().width }])),
  };
}

ipcMain.handle('window:metrics', () => {
  return getLayoutMetrics();
});

// Tab 仅改变内容；固定展开尺寸下不再触发原生窗口 resize。
ipcMain.handle('window:set-tab', (event, tab) => {
  currentTab = Object.prototype.hasOwnProperty.call(TAB_SIZES, tab) ? tab : 'home';
});

// macOS 渲染层 getUserMedia 不会自动弹 TCC 授权，必须由主进程申请摄像头权限
ipcMain.handle('media:camera', async (event) => {
  if (!isIslandSender(event)) return false;
  if (process.platform !== 'darwin') return true;
  if (systemPreferences.getMediaAccessStatus('camera') === 'granted') return true;
  mediaPermissionRequests++;
  try {
    return await systemPreferences.askForMediaAccess('camera');
  } finally {
    mediaPermissionRequests = Math.max(0, mediaPermissionRequests - 1);
    if (quickIslandCameraDeferred && mediaPermissionRequests === 0) {
      quickIslandCameraDeferred = false;
      const quick = quickIslandWindow;
      // The system permission sheet momentarily takes key focus. Restore only
      // the still-open island that the user explicitly used to request a mirror.
      if (quick && !quick.isDestroyed() && quick.isVisible() && quickIslandInteractive) quick.focus();
    }
    if (mediaPermissionRequests === 0 && cameraBlurDeferred) {
      cameraBlurDeferred = false;
      const targetWindow = mainWindow;
      setTimeout(() => {
        if (
          mainWindow === targetWindow &&
          targetWindow &&
          !targetWindow.isDestroyed() &&
          !targetWindow.isFocused()
        ) {
          requestRendererCollapse();
        }
      }, 200);
    }
  }
});

ipcMain.handle('media:microphone', async () => {
  if (process.platform !== 'darwin') return true;
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
  mediaPermissionRequests++;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } finally {
    mediaPermissionRequests = Math.max(0, mediaPermissionRequests - 1);
    if (mediaPermissionRequests === 0 && cameraBlurDeferred) {
      cameraBlurDeferred = false;
    }
  }
});

ipcMain.handle('tasks:recent', () => taskCompletionHistory);

// 快捷链接：URL 走外部浏览器（仅 http/https），本地路径走系统打开（仅绝对路径）
ipcMain.handle('shell:openExternal', (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return shell.openExternal(url);
  }
});

ipcMain.handle('shell:openPath', (event, p) => {
  if (typeof p === 'string' && path.isAbsolute(p)) {
    return shell.openPath(p);
  }
});

// 只放行固定的几个隐私面板，渲染层传来的值只能当作枚举的键来查，
// 绝不能拼进 URL：x-apple.systempreferences: 能打开任意设置面板。
const PRIVACY_SETTINGS_PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
};

ipcMain.handle('shell:open-privacy-settings', async (event, pane) => {
  const target = PRIVACY_SETTINGS_PANES[String(pane || '')];
  if (!target) return false;
  try {
    await shell.openExternal(target);
    return true;
  } catch (error) {
    return false;
  }
});

// ============ 启动时的权限自检 ============
// DMG 装的是全新二进制，TCC 授权不会从开发版继承，而这几项缺失时的表现都是「静默失效」：
// 缺「屏幕录制」→ CGWindowList 照样返回窗口但标题全空，当前窗口看起来像真的没窗口；
// 缺「辅助功能」→ 无法聚焦其他应用窗口。
// 系统对前者根本不弹提示，所以只能由应用自己说，否则用户完全无从下手。
const PERMISSION_PROMPT_SKIP_FILE = 'permission-prompt-skipped';

// 先尊重系统的明确状态，尤其不能在 not-determined 时调用 desktopCapturer，
// 否则启动自检本身就会抢先弹出系统录屏框。只有系统报告 granted 时才通过
// 无缩略图的窗口标题做二次确认；未知状态 fail-open，等用户实际使用时再申请。
async function hasScreenRecordingAccess() {
  const policy = screenRecordingProbePolicy(systemPreferences.getMediaAccessStatus('screen'));
  if (!policy.inspectWindowTitles) return policy.hasAccess;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    if (sources.length === 0) return true; // 拿不到源无法判定，不误报
    return sources.some((source) => String(source.name || '').trim().length > 0);
  } catch (error) {
    return true; // 探测本身失败时不打扰用户
  }
}

async function promptForMissingPermissions() {
  if (process.platform !== 'darwin') return;
  const skipFlag = path.join(app.getPath('userData'), PERMISSION_PROMPT_SKIP_FILE);
  if (fs.existsSync(skipFlag)) return;

  const missing = [];
  // 传 false 只查询不弹系统框：先把缺失项攒齐一次性告知，避免连弹两个系统对话框。
  if (!systemPreferences.isTrustedAccessibilityClient(false)) missing.push('accessibility');
  if (!await hasScreenRecordingAccess()) missing.push('screen-recording');
  if (missing.length === 0) return;

  const names = missing.map((key) => (key === 'accessibility' ? '辅助功能' : '屏幕录制'));
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'info',
    message: `悬浮岛需要「${names.join('」和「')}」权限`,
    detail: [
      '缺少这些权限时，「当前窗口」可能无法读取标题或切换窗口。Codex 额度模块无需这些权限。',
      '',
      '授权后需要重新启动悬浮岛才会生效。',
      '临时签名在更新后可能需要重新授权；系统设置中的旧开关不代表当前版本已获授权。',
    ].join('\n'),
    buttons: ['打开系统设置', '以后再说'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: '不再提示',
    checkboxChecked: false,
  });

  if (checkboxChecked) {
    try { fs.writeFileSync(skipFlag, new Date().toISOString()); } catch (error) {}
  }
  if (response !== 0) return;

  // 顺带用 true 触发一次系统的辅助功能提示：这一步会把应用登记进系统设置的列表里，
  // 否则用户打开设置面板可能找不到悬浮岛这一项、只能手动拖进去。
  if (missing.includes('accessibility')) systemPreferences.isTrustedAccessibilityClient(true);
  shell.openExternal(PRIVACY_SETTINGS_PANES[missing[0]]);
}

async function validatePublicHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) return null;
  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    return null;
  }
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) return null;
  return url;
}

async function readResponseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LINK_FETCH_MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchFaviconDataUrl(pageUrl, html) {
  let candidate;
  try {
    const href = extractFaviconHref(html) || '/favicon.ico';
    candidate = await validatePublicHttpUrl(new URL(href, pageUrl).toString());
  } catch (error) {
    candidate = null;
  }
  if (!candidate) return '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(candidate, { signal: controller.signal, redirect: 'error' });
    const type = String(response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
    if (!response.ok || !type.startsWith('image/')) return '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 160 * 1024) return '';
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch (error) {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichLinkMetadata(url, title) {
  const config = resolveLlmConfig();
  if (!config.apiKey || !config.model) return { title, category: '' };
  const endpoint = config.baseUrl.endsWith('/chat/completions')
    ? config.baseUrl
    : `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const safeEndpoint = await validatePublicHttpUrl(endpoint);
  if (!safeEndpoint) return { title, category: '' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINK_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(safeEndpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DynamicPanel/0.3 (+local bookmark organizer)',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        ...(config.baseUrl.includes('deepseek.com') ? { thinking: { type: 'disabled' } } : {}),
        messages: [
          {
            role: 'system',
            content: '你是网址收藏夹整理器。只返回 JSON：{"title":"简洁中文名称","category":"短分类"}。分类应稳定、可复用，不超过 14 个字。',
          },
          { role: 'user', content: `URL: ${url}\n网页标题: ${title}` },
        ],
      }),
    });
    if (!response.ok) return { title, category: '' };
    const payload = await response.json();
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    const parsed = parseSmartLinkMetadata(content);
    if (!parsed) return { title, category: '' };
    return { title: parsed.title || title, category: parsed.category };
  } catch (error) {
    return { title, category: '' };
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectLink(rawUrl) {
  let current = await validatePublicHttpUrl(rawUrl);
  if (!current) return { ok: false, error: 'invalid_or_private_url' };
  for (let redirectCount = 0; redirectCount <= LINK_FETCH_MAX_REDIRECTS; redirectCount++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LINK_FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2',
          'User-Agent': 'DynamicPanel/0.3 (+local bookmark metadata)',
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      // URL 已经过公网与协议校验；正文不可读不应阻止收藏，仍尝试抓站点根图标。
      const icon = await fetchFaviconDataUrl(current.toString(), '');
      return {
        ok: true,
        url: current.toString(),
        title: '未命名',
        category: '',
        icon,
        warning: error && error.name === 'AbortError' ? 'timeout' : 'fetch_failed',
      };
    }
    clearTimeout(timeout);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirectCount >= LINK_FETCH_MAX_REDIRECTS) {
        return { ok: false, error: 'too_many_redirects' };
      }
      current = await validatePublicHttpUrl(new URL(location, current).toString());
      if (!current) return { ok: false, error: 'unsafe_redirect' };
      continue;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const fallback = current.hostname.replace(/^www\./, '');
    if (!response.ok || (!contentType.includes('text/html') && !contentType.includes('xhtml'))) {
      const [smart, icon] = await Promise.all([
        enrichLinkMetadata(current.toString(), fallback),
        fetchFaviconDataUrl(current.toString(), ''),
      ]);
      return { ok: true, url: current.toString(), title: smart.title || '未命名', category: smart.category, icon };
    }
    const html = await readResponseText(response);
    const pageTitle = extractPageTitle(html, fallback);
    const [smart, icon] = await Promise.all([
      enrichLinkMetadata(current.toString(), pageTitle),
      fetchFaviconDataUrl(current.toString(), html),
    ]);
    return { ok: true, url: current.toString(), title: smart.title, category: smart.category, icon };
  }
  return { ok: false, error: 'too_many_redirects' };
}

ipcMain.handle('links:inspect', (event, url) => inspectLink(url));

ipcMain.handle('smart:organize-material', async (event, payload) => {
  const config = resolveLlmConfig();
  const kind = payload && payload.kind === 'note' ? 'note' : 'material';
  const transcript = String(payload && payload.text || '').trim().slice(0, 8000);
  if (!transcript) return { ok: false, error: 'empty_text' };
  if (!config.apiKey || !config.model) return { ok: false, error: 'not_configured' };
  const endpoint = config.baseUrl.endsWith('/chat/completions')
    ? config.baseUrl
    : `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const safeEndpoint = await validatePublicHttpUrl(endpoint);
  if (!safeEndpoint) return { ok: false, error: 'invalid_endpoint' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(safeEndpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        ...(config.baseUrl.includes('deepseek.com') ? { thinking: { type: 'disabled' } } : {}),
        messages: [
          {
            role: 'system',
            content: kind === 'note'
              ? '你是中文笔记命名助手。理解整篇笔记后概括主题，禁止把正文首句直接当标题。只返回 JSON：{"title":"8到18字的具体标题","category":"2到8字的稳定分类"}。'
              : '你是中文个人资料库整理器。根据内容概括，不要照抄首句。只返回 JSON：{"title":"8到18字的具体名称","category":"2到8字的稳定分类"}。',
          },
          { role: 'user', content: kind === 'note' ? `请为以下笔记命名：\n\n${transcript}` : transcript },
        ],
      }),
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const result = await response.json();
    const content = result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
    const metadata = parseSmartMaterialMetadata(content);
    return metadata && metadata.title ? { ok: true, ...metadata } : { ok: false, error: 'invalid_response' };
  } catch (error) {
    return { ok: false, error: error && error.name === 'AbortError' ? 'timeout' : 'request_failed' };
  } finally {
    clearTimeout(timeout);
  }
});

const WINDOWS_LIST_JXA = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function run(argv) {
  const ownPid = Number(argv[0]);
  const rows = [];
  let candidates = 0;
  let titled = 0;
  const options = $.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements;
  const windowList = ObjC.castRefToObject(
    $.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID)
  );
  const appPaths = {};
  for (let index = 0; index < Number(windowList.count); index++) {
    const info = windowList.objectAtIndex(index);
    const get = (key) => ObjC.unwrap(info.objectForKey($(key)));
    const layer = Number(get('kCGWindowLayer'));
    const pid = Number(get('kCGWindowOwnerPID'));
    const appName = String(get('kCGWindowOwnerName') || '').trim();
    const title = String(get('kCGWindowName') || '').replace(/\\s+/g, ' ').trim();
    const windowNumber = Number(get('kCGWindowNumber'));
    if (layer !== 0 || !pid || pid === ownPid || !appName || !windowNumber) continue;
    if (!Object.prototype.hasOwnProperty.call(appPaths, pid)) {
      const meta = { appPath: '', policy: -1 };
      try {
        const runningApp = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        if (runningApp && !runningApp.isNil()) {
          meta.policy = Number(runningApp.activationPolicy);
          if (runningApp.bundleURL && !runningApp.bundleURL.isNil()) {
            meta.appPath = String(ObjC.unwrap(runningApp.bundleURL.path) || '');
          }
        }
      } catch (error) {}
      appPaths[pid] = meta;
    }
    const appMeta = appPaths[pid];
    // activationPolicy 2 = NSApplicationActivationPolicyProhibited：XPC 与系统辅助进程
    // （如 AuthenticationServicesHelper，bundle 是 .xpc 不是 .app）。它们在系统层面就
    // 不能被激活，列出来点了也不会有任何反应，属于纯粹的假窗口。
    // 注意不能用 kCGWindowIsOnscreen 过滤：真实窗口在其他 Space 或被遮挡时该字段也是
    // nil，实测微信 / Arc / Chrome / 飞书都会被误删。
    if (appMeta.policy === 2) continue;
    // 只统计其他可激活应用，避免自身或系统辅助窗口造成空标题误判。
    candidates += 1;
    if (title) titled += 1;
    if (!title) continue;
    rows.push({ pid, appName, appPath: appMeta.appPath, title, windowIndex: index, windowNumber });
  }
  // 标题全空只是读取异常的线索；由主进程结合系统明确的权限状态解释。
  return JSON.stringify({ rows: rows, candidates: candidates, titled: titled });
}`;

const WINDOW_FOCUS_JXA = `
function run(argv) {
  function reply(value) { return JSON.stringify(value); }
  function normalizeTitle(value) { return String(value || '').replace(/\\s+/g, ' ').trim(); }
  const pid = Number(argv[0]);
  const wantedTitle = normalizeTitle(argv[1]);
  const se = Application('System Events');
  const matches = se.applicationProcesses.whose({ unixId: pid })();
  if (!matches.length || !wantedTitle) return reply({ ok: false, error: 'window_unavailable' });
  const process = matches[0];
  const windows = process.windows();
  let target = null;
  for (let i = 0; i < windows.length; i++) {
    try {
      if (normalizeTitle(windows[i].name()) === wantedTitle) { target = windows[i]; break; }
    } catch (error) {}
  }
  let raised = false;
  let actionError = null;
  if (target) {
    try {
      process.frontmost = true;
      delay(0.08);
      target.actions.byName('AXRaise').perform();
      raised = true;
    } catch (error) { actionError = error; }
  }
  try {
    const bars = process.menuBars();
    const menuBarItems = bars.length ? bars[0].menuBarItems() : [];
    let windowMenu = null;
    for (let i = 0; i < menuBarItems.length; i++) {
      const name = String(menuBarItems[i].name());
      if (name === 'Window' || name === '窗口') { windowMenu = menuBarItems[i]; break; }
    }
    if (windowMenu) {
      const items = windowMenu.menus[0].menuItems();
      for (let i = 0; i < items.length; i++) {
        if (normalizeTitle(items[i].name()) === wantedTitle && items[i].enabled()) {
          process.frontmost = true;
          items[i].click();
          return reply({ ok: true });
        }
      }
    }
  } catch (error) { actionError = error; }
  if (raised) return reply({ ok: true });
  if (actionError) throw actionError;
  return reply({ ok: false, error: target ? 'window_focus_failed' : 'window_unavailable' });
}`;

function runJxa(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, '--', ...args.map(String)],
      { timeout: 6000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
        } else {
          resolve(String(stdout || '').trim());
        }
      }
    );
  });
}

async function scanCurrentWindows() {
  if (process.platform !== 'darwin') return { items: [], error: 'unsupported' };
  try {
    const mediaStatus = systemPreferences.getMediaAccessStatus('screen');
    const accessError = windowScanStatusError(mediaStatus);
    if (accessError) {
      windowScanCache = new Map();
      return { items: [], error: accessError };
    }
    const raw = await runJxa(WINDOWS_LIST_JXA, [process.pid]);
    const parsed = JSON.parse(raw || '{}');
    // 兼容旧格式（裸数组），新格式是 { rows, candidates, titled }。
    const payload = Array.isArray(parsed)
      ? { rows: parsed, candidates: parsed.length, titled: parsed.length }
      : parsed;
    const rows = normalizeWindowRows(payload.rows || []).filter((item) => item.pid !== process.pid);
    const scanError = rows.length === 0 ? windowScanStatusError(mediaStatus, payload) : null;
    if (scanError) {
      windowScanCache = new Map();
      return { items: [], error: scanError };
    }
    const appPaths = [...new Set(rows.map((item) => item.appPath).filter(Boolean))];
    await Promise.all(appPaths.map(async (appPath) => {
      if (windowIconCache.has(appPath)) return;
      const icon = await withTimeout(readWindowAppIcon(appPath), 3500, null);
      windowIconCache.set(appPath, icon);
    }));
    rows.forEach((item) => {
      item.icon = item.appPath ? windowIconCache.get(item.appPath) || null : null;
    });
    windowScanCache = new Map(rows.map((item) => [item.id, item]));
    return { items: rows, error: null };
  } catch (error) {
    windowScanCache = new Map();
    return { items: [], error: 'window_scan_failed' };
  }
}

ipcMain.handle('windows:list', async () => {
  return scanCurrentWindows();
});

async function focusCurrentWindow(windowId) {
  const target = windowScanCache.get(windowId);
  if (!target || process.platform !== 'darwin') return { ok: false, error: 'window_unavailable' };
  try {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      return { ok: false, error: 'accessibility_permission_required' };
    }
    const result = JSON.parse(await runJxa(WINDOW_FOCUS_JXA, [target.pid, target.focusTitle || target.title]));
    if (result?.ok === true) return { ok: true };
    return { ok: false, error: result?.error === 'window_unavailable' ? 'window_unavailable' : 'window_focus_failed' };
  } catch (error) {
    return { ok: false, error: windowFocusError(error) };
  }
}

ipcMain.handle('windows:focus', (event, windowId) => focusCurrentWindow(windowId));

function taskWindowMatchScore(notification, target) {
  const project = String(notification && notification.project || '').trim().toLocaleLowerCase();
  const title = String(target && target.title || '').trim().toLocaleLowerCase();
  const appName = String(target && target.appName || '').trim().toLocaleLowerCase();
  if (!project || !title) return 0;
  if (title === project) return 100;
  if (title.startsWith(`${project} `) || title.startsWith(`${project} —`) || title.startsWith(`${project} -`)) return 90;
  if (title.includes(project)) return 75;
  if (project.includes(appName) && appName) return 25;
  return 0;
}

async function activateActiveTaskNotification(eventId = null) {
  const notification = activeTaskNotification;
  if (!notification || (eventId && notification.eventId !== eventId) || notification.source === 'todo') return false;
  if (notification.source === 'codex' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(notification.threadId || '')) {
    try {
      await shell.openExternal(`codex://threads/${notification.threadId}`);
      if (activeTaskNotification !== notification) return false;
      beginTaskNotificationDismiss();
      return true;
    } catch (_) { return false; }
  }
  const result = await scanCurrentWindows();
  if (activeTaskNotification !== notification) return false;
  const target = (result.items || [])
    .map((item) => ({ item, score: taskWindowMatchScore(notification, item) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.item;
  if (!target) return false;
  try {
    const result = await focusCurrentWindow(target.id);
    if (activeTaskNotification !== notification) return false;
    if (result.ok) beginTaskNotificationDismiss();
    return result.ok;
  } catch (error) {
    return false;
  }
}

ipcMain.handle('task-notification:activate', async (event, eventId) => {
  if (!notificationWindow || notificationWindow.isDestroyed() || event.sender !== notificationWindow.webContents) return false;
  return activateActiveTaskNotification(eventId);
});

// 当前窗口模块仍需要安全读取本机应用图标。
// 优先直接从 .icns 提取内嵌 PNG；失败时通过独立 JXA 进程向 NSWorkspace 取系统图标。
// 不直接调用 app.getFileIcon：它曾在部分 .app 上触发 Electron 内部 FATAL Check，
// 独立进程即使失败也不会带崩主进程。
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// icns 内 PNG 块按"贴近 48px 网格展示"优先：128 → 256 → 64@2x …
const ICNS_PREF = ['ic07', 'ic12', 'ic08', 'ic11', 'ic13', 'ic09', 'ic14', 'ic05', 'ic04'];

function extractPngFromIcns(buf) {
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'icns') return null;
  const candidates = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) break;
    const data = buf.subarray(off + 8, off + len);
    if (data.length > 8 && data.subarray(0, 4).equals(PNG_SIG)) {
      candidates.push({ type, data });
    }
    off += len;
  }
  if (!candidates.length) return null; // 老式 RLE 图标 → 交给渲染层首字母兜底
  candidates.sort((a, b) => {
    const ia = ICNS_PREF.indexOf(a.type);
    const ib = ICNS_PREF.indexOf(b.type);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return candidates[0].data;
}

async function readEmbeddedAppIcon(appPath) {
  try {
    const resDir = path.join(appPath, 'Contents', 'Resources');
    const files = await fs.promises.readdir(resDir);
    const icns = files.filter((f) => f.toLowerCase().endsWith('.icns'));
    if (!icns.length) return null;
    // 优先 AppIcon.icns，其次名字含 app/icon 的，避免选中文档类型图标
    const score = (n) => {
      const s = n.toLowerCase();
      if (s === 'appicon.icns') return 0;
      if (s.includes('app')) return 1;
      if (s.includes('icon')) return 2;
      return 3;
    };
    icns.sort((a, b) => score(a) - score(b) || a.length - b.length);
    const buf = await fs.promises.readFile(path.join(resDir, icns[0]));
    const png = extractPngFromIcns(buf);
    return png ? `data:image/png;base64,${png.toString('base64')}` : null;
  } catch (e) {
    return null; // 单个应用读不到图标不影响整体
  }
}

const SYSTEM_ICON_JXA = `
ObjC.import('AppKit');
function run(argv) {
  const size = 96;
  const source = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(size, size));
  image.lockFocus;
  source.drawInRectFromRectOperationFraction(
    $.NSMakeRect(0, 0, size, size),
    $.NSZeroRect,
    $.NSCompositingOperationSourceOver,
    1
  );
  image.unlockFocus;
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`;

function readSystemAppIconNow(appPath) {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', SYSTEM_ICON_JXA, appPath],
      { timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        const base64 = typeof stdout === 'string' ? stdout.trim() : '';
        if (error || !base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
          resolve(null);
          return;
        }
        resolve(`data:image/png;base64,${base64}`);
      }
    );
  });
}

const SYSTEM_ICON_CONCURRENCY = 2;
const SYSTEM_ICON_QUEUE_TIMEOUT_MS = 10000;
let systemIconActive = 0;
const systemIconQueue = [];

function pumpSystemIconQueue() {
  while (systemIconActive < SYSTEM_ICON_CONCURRENCY && systemIconQueue.length) {
    const job = systemIconQueue.shift();
    if (job.cancelled) continue;
    systemIconActive++;
    readSystemAppIconNow(job.appPath)
      .then(job.finish, () => job.finish(null))
      .finally(() => {
        systemIconActive--;
        pumpSystemIconQueue();
      });
  }
}

function readSystemAppIcon(appPath) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    const job = {
      appPath,
      cancelled: false,
      settled: false,
      timer: null,
      finish(value) {
        if (job.settled) return;
        job.settled = true;
        if (job.timer) clearTimeout(job.timer);
        resolve(value);
      },
    };
    job.timer = setTimeout(() => {
      job.cancelled = true;
      job.finish(null);
    }, SYSTEM_ICON_QUEUE_TIMEOUT_MS);
    systemIconQueue.push(job);
    pumpSystemIconQueue();
  });
}

async function readWindowAppIcon(appPath) {
  const systemIcon = await withTimeout(readSystemAppIcon(appPath), 2800, null);
  return systemIcon || readEmbeddedAppIcon(appPath);
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const FRONTMOST_APP_JXA = `
ObjC.import('AppKit');
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app) return '{}';
  return JSON.stringify({
    name: ObjC.unwrap(app.localizedName) || '',
    bundleId: ObjC.unwrap(app.bundleIdentifier) || '',
    path: app.bundleURL ? (ObjC.unwrap(app.bundleURL.path) || '') : ''
  });
}`;

const PASTE_TO_APP_JXA = `
ObjC.import('AppKit');
function run(argv) {
  const bundleId = String(argv[0] || '');
  if (!bundleId) return 'missing';
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  if (!apps || apps.count === 0) return 'missing';
  apps.objectAtIndex(0).activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
  delay(0.18);
  Application('System Events').keystroke('v', { using: 'command down' });
  return 'ok';
}`;

function readFrontmostApp() {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FRONTMOST_APP_JXA], { timeout: 2200 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const value = JSON.parse(String(stdout || '').trim());
        resolve(value && value.path ? value : null);
      } catch (parseError) {
        resolve(null);
      }
    });
  });
}

async function rememberPasteTarget() {
  const current = await readFrontmostApp();
  if (current && !['com.github.Electron', 'com.vibecoding.notch-todo', 'com.dynamicpanel.app'].includes(current.bundleId)) {
    previousPasteTarget = current;
  }
  return previousPasteTarget;
}

ipcMain.handle('mirror:get-image', () => mirrorImageDataUrl());
ipcMain.handle('mirror:choose-image', () => chooseMirrorImage());

function getCredentialsVaultPath() {
  return path.join(app.getPath('userData'), CREDENTIALS_VAULT_FILE);
}

function readCredentialsVault() {
  if (!safeStorage.isEncryptionAvailable()) return [];
  try {
    const envelope = JSON.parse(fs.readFileSync(getCredentialsVaultPath(), 'utf8'));
    const decoded = safeStorage.decryptString(Buffer.from(String(envelope.payload || ''), 'base64'));
    const rows = JSON.parse(decoded);
    return Array.isArray(rows) ? rows.map((item) => normalizeCredentialInput(item, item && item.id, item && item.createdAt)).filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function writeCredentialsVault(rows) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const payload = safeStorage.encryptString(JSON.stringify(rows)).toString('base64');
  const vaultPath = getCredentialsVaultPath();
  const temporaryPath = `${vaultPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, payload }), { mode: 0o600 });
    fs.renameSync(temporaryPath, vaultPath);
    return true;
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (unlinkError) {}
    return false;
  }
}

function publicCredential(item) {
  return {
    id: item.id,
    service: item.service,
    account: item.account,
    passwordMask: '**********',
    createdAt: item.createdAt,
  };
}

ipcMain.handle('credentials:list', () => ({
  ok: safeStorage.isEncryptionAvailable(),
  secureStorage: safeStorage.isEncryptionAvailable(),
  items: readCredentialsVault().map(publicCredential),
}));

ipcMain.handle('credentials:get', (event, id) => {
  const item = readCredentialsVault().find((row) => row.id === String(id || ''));
  return item ? { ok: true, item: { ...item } } : { ok: false, error: 'not_found' };
});

ipcMain.handle('credentials:save', (event, payload) => {
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'secure_storage_unavailable' };
  const rows = readCredentialsVault();
  const existing = payload && payload.id ? rows.find((item) => item.id === payload.id) : null;
  const normalized = normalizeCredentialInput(
    existing && !String(payload && payload.password || '') ? { ...payload, password: existing.password } : payload,
    existing ? existing.id : crypto.randomUUID(),
    existing ? existing.createdAt : Date.now()
  );
  if (!normalized) return { ok: false, error: 'invalid_credential' };
  const next = existing
    ? rows.map((item) => item.id === existing.id ? normalized : item)
    : [normalized, ...rows];
  return writeCredentialsVault(next)
    ? { ok: true, item: publicCredential(normalized) }
    : { ok: false, error: 'save_failed' };
});

ipcMain.handle('credentials:delete-many', (event, ids) => {
  const targets = new Set(Array.isArray(ids) ? ids.map(String) : []);
  if (!targets.size) return { ok: true, deleted: 0 };
  const rows = readCredentialsVault();
  const next = rows.filter((item) => !targets.has(item.id));
  if (!writeCredentialsVault(next)) return { ok: false, error: 'save_failed' };
  return { ok: true, deleted: rows.length - next.length };
});

ipcMain.handle('credentials:copy', async (event, payload) => {
  const id = String(payload && payload.id || '');
  const field = payload && payload.field === 'password' ? 'password' : payload && payload.field === 'account' ? 'account' : '';
  if (!id || !field) return false;
  const item = readCredentialsVault().find((row) => row.id === id);
  if (!item) return false;
  const value = item[field];
  await clipboard.writeText(value);
  if (field === 'password') {
    setTimeout(() => {
      void clipboard.readText()
        .then((currentValue) => {
          if (currentValue === value) return clipboard.clear();
          return undefined;
        })
        .catch(() => {});
    }, 60_000).unref?.();
  }
  return true;
});

// AI tool choices are shared by the workspace, quick island and collapsed island.
const aiTools = require('./ai-tools').createAIToolsService({ settingsPath: getJsonSettingsPath('ai-tools.json') });
aiCodeRuntime = require('./ai-code-runtime').createAICodeRuntime({
  codex: codexFloat,
  connectors: require('./ai-code-connectors').createCodeConnectors({ userData: app.getPath('userData') }),
  onTaskComplete: enqueueCodeTaskNotification,
  onStatus: (snapshot) => {
    broadcastIsland('ai-code:status', snapshot);
    const attention = snapshot.providerId === 'codex' && hasCodexAttention(snapshot);
    if (codexAttentionActive !== attention) {
      codexAttentionActive = attention;
      if (statusIsland) void statusIsland.sync();
    }
  },
});
ipcMain.handle('ai-code:get', (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return aiCodeRuntime.getStatus();
});
ipcMain.handle('ai-code:refresh', (event, id) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return aiCodeRuntime.refresh(id);
});
ipcMain.handle('ai-code:connect', (event, id) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return aiCodeRuntime.connect(id);
});
ipcMain.handle('ai-tools:get', (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return aiTools.getSnapshot();
});
ipcMain.handle('ai-tools:update', (event, request) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  const result = aiTools.update(request);
  if (result.ok) {
    broadcastIsland('ai-tools:changed', result);
    void aiCodeRuntime.select(result);
  }
  return result;
});
ipcMain.handle('ai-tools:website', async (event, id) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  const url = aiTools.website(id);
  if (!url) return { ok: false, error: 'invalid_tool' };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (_) { return { ok: false, error: 'open_failed' }; }
});

ipcMain.handle('codex-float:get', (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return aiCodeRuntime.isSelected('codex') ? aiCodeRuntime.getStatus() : { connection: 'unselected', windows: [], threads: [] };
});

ipcMain.handle('computer:status', async (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  try {
    const snapshot = await computerStatus.getSnapshot();
    broadcastIsland('computer:status-changed', snapshot);
    return snapshot;
  } catch (_) { return { ok: false, error: 'status_unavailable' }; }
});

const quickLaunch = require('./quick-launch').createQuickLaunchService({
  settingsPath: getJsonSettingsPath('quick-launch.json'),
  readIcon: async (appPath) => {
    // The combined ChatGPT client embeds a separate Codex icon. Keep that
    // identity here, and resolve system-app aliases before asking for icons.
    const codexIcon = fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'codex'))
      ? await readEmbeddedAppIcon(appPath) : null;
    const iconPath = await fs.promises.realpath(appPath).catch(() => appPath);
    return codexIcon || await readSystemAppIcon(iconPath) || await readEmbeddedAppIcon(appPath);
  },
});

ipcMain.handle('quick-launch:list', async (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  try { return await quickLaunch.list(); }
  catch (_) { return { ok: false, error: 'settings_unavailable' }; }
});
ipcMain.handle('quick-launch:choose', (event, id) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  const owner = BrowserWindow.fromWebContents(event.sender);
  return quickLaunch.replace(id, async () => {
    if (!owner || owner.isDestroyed()) throw new Error('owner_unavailable');
    if (owner === quickIslandWindow) {
      const shown = await showQuickIsland({ focus: true });
      if (!shown.ok) throw new Error('island_unavailable');
    }
    try {
      return await showOwnedOpenDialog({
        title: '更换常用应用',
        message: '选择一个应用，替换当前图标',
        buttonLabel: '选择应用',
        defaultPath: '/Applications',
        properties: ['openFile'],
        filters: [{ name: '应用程序', extensions: ['app'] }],
      }, owner);
    } finally {
      if (owner === quickIslandWindow && !owner.isDestroyed() && owner.isVisible() && quickIslandInteractive) owner.focus();
    }
  });
});
ipcMain.handle('quick-launch:open', async (event, id) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  const result = await quickLaunch.launch(id, (appPath) => shell.openPath(appPath));
  if (result.ok) hideQuickIsland(true);
  return result;
});
ipcMain.handle('quick-launch:weather', async (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  try {
    const weatherPath = '/System/Applications/Weather.app';
    if (!fs.existsSync(weatherPath)) return { ok: false, error: 'weather_unavailable' };
    if (await shell.openPath(weatherPath)) return { ok: false, error: 'open_failed' };
    hideQuickIsland(true);
    return { ok: true };
  } catch (_) { return { ok: false, error: 'open_failed' }; }
});
ipcMain.handle('weather:get', (event, city) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return weatherService.getWeather(city);
});
const pendingPomodoroControls = new Map();
ipcMain.on('pomodoro:controlled', (event, requestId) => {
  if (!isIslandSender(event, false) || typeof requestId !== 'string') return;
  pendingPomodoroControls.get(requestId)?.({ ok: true, timer: islandActivities.timer });
});
ipcMain.handle('pomodoro:control', (event, payload) => {
  if (!isIslandSender(event) || !mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'unauthorized' };
  if (!payload || !['toggle', 'reset', 'set-duration'].includes(payload.action)) return { ok: false, error: 'invalid_action' };
  if (payload.action === 'set-duration' && (!Number.isInteger(payload.seconds) || payload.seconds < 1 || payload.seconds > 3660)) return { ok: false, error: 'invalid_duration' };
  if (pendingPomodoroControls.size >= 4) return { ok: false, error: 'busy' };
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => finish({ ok: false, error: 'timer_unavailable' }), 2000);
    const finish = (result) => { clearTimeout(timeout); pendingPomodoroControls.delete(requestId); resolve(result); };
    pendingPomodoroControls.set(requestId, finish);
    mainWindow.webContents.send('pomodoro:control', { requestId, action: payload.action, seconds: payload.seconds });
  });
});

ipcMain.handle('codex-float:refresh', (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  return aiCodeRuntime.refresh('codex');
});

ipcMain.handle('codex-float:open-app', async (event) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  if (!aiCodeRuntime.isSelected('codex')) return { ok: false, error: 'confirmation_required' };
  const candidates = ['Codex.app', 'ChatGPT.app'].flatMap((name) => [
    path.join('/Applications', name), path.join(app.getPath('home'), 'Applications', name),
  ]);
  const target = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'codex')));
  if (!target) return { ok: false, error: 'codex_not_installed' };
  try {
    const error = await shell.openPath(target);
    if (error) return { ok: false, error: 'open_failed' };
    hideQuickIsland(true);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'open_failed' };
  }
});

ipcMain.handle('codex-float:open-thread', async (event, id) => {
  if (!isIslandSender(event)) return { ok: false, error: 'unauthorized' };
  if (!aiCodeRuntime.isSelected('codex')) return { ok: false, error: 'confirmation_required' };
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || !codexFloat.hasThread(id)) {
    return { ok: false, error: 'invalid_thread' };
  }
  try {
    await shell.openExternal(`codex://threads/${id}`);
    hideQuickIsland(true);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'open_failed' };
  }
});

// ============ 百炼实时语音转写 ============
function getTranscriptionSettingsPath() {
  return path.join(app.getPath('userData'), TRANSCRIPTION_SETTINGS_FILE);
}

function readStoredTranscriptionSettings() {
  const currentPath = getTranscriptionSettingsPath();
  const legacyPath = path.join(app.getPath('appData'), 'notch-todo', TRANSCRIPTION_SETTINGS_FILE);
  const readSettings = (settingsPath) => {
    try {
      const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      return {};
    }
  };
  const current = readSettings(currentPath);
  const legacy = currentPath === legacyPath ? {} : readSettings(legacyPath);
  const selected = selectTranscriptionSettings(current, legacy);
  if (!Object.keys(current).length && Object.keys(selected).length && currentPath !== legacyPath) {
    try {
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      fs.writeFileSync(currentPath, JSON.stringify(selected), { mode: 0o600 });
    } catch (error) {
      // 迁移失败时仍从旧目录读取，避免已有密钥突然失效。
    }
  }
  return selected;
}

function decryptStoredApiKey(settings) {
  const environmentKey = String(process.env.DASHSCOPE_API_KEY || '').trim();
  if (environmentKey) return environmentKey;
  return decryptStoredSecret(settings.encryptedApiKey).trim();
}

function decryptStoredSecret(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(String(value), 'base64'));
  } catch (error) {
    return '';
  }
}

function resolveLlmConfig() {
  const settings = readStoredTranscriptionSettings();
  return {
    apiKey: String(process.env.NOTCH_LLM_API_KEY || decryptStoredSecret(settings.encryptedLlmApiKey)).trim(),
    baseUrl: String(settings.llmBaseUrl || 'https://api.deepseek.com').trim(),
    model: String(settings.llmModel || 'deepseek-v4-flash').trim(),
  };
}

function resolveTranscriptionConfig() {
  const settings = readStoredTranscriptionSettings();
  const environmentWorkspace = String(process.env.DASHSCOPE_WORKSPACE_ID || process.env.DASHSCOPE_WORKSPACE || '').trim();
  const environmentRegion = String(process.env.DASHSCOPE_REGION || '').trim().toLowerCase();
  const region = ['beijing', 'singapore'].includes(environmentRegion)
    ? environmentRegion
    : ['beijing', 'singapore'].includes(settings.region) ? settings.region : 'beijing';
  const workspaceId = (environmentWorkspace || String(settings.workspaceId || '').trim()).slice(0, 128);
  return {
    apiKey: decryptStoredApiKey(settings),
    workspaceId: /^[A-Za-z0-9_-]{0,128}$/.test(workspaceId) ? workspaceId : '',
    region,
  };
}

function publicTranscriptionConfig() {
  return publicTranscriptionMetadata(readStoredTranscriptionSettings(), process.env);
}

function transcriptionUrl(config) {
  const host = config.workspaceId
    ? config.region === 'singapore'
      ? `${config.workspaceId}.ap-southeast-1.maas.aliyuncs.com`
      : `${config.workspaceId}.cn-beijing.maas.aliyuncs.com`
    : config.region === 'singapore'
      ? 'dashscope-intl.aliyuncs.com'
      : 'dashscope.aliyuncs.com';
  return `wss://${host}/api-ws/v1/realtime?model=${TRANSCRIPTION_MODEL}&heartbeat=true`;
}

function transcriptionEventId() {
  return `event_${crypto.randomUUID().replace(/-/g, '')}`;
}

function emitTranscription(session, payload) {
  if (session.sender && !session.sender.isDestroyed()) {
    session.sender.send('transcription:event', payload);
  }
}

function sessionTranscript(session) {
  return [...session.finalSegments, session.interim].filter(Boolean).join(' ').trim();
}

function closeTranscriptionSession(session, result = {}) {
  if (!session || session.closed) return;
  session.closed = true;
  clearTimeout(session.connectTimer);
  clearTimeout(session.finishTimer);
  transcriptionSessions.delete(session.senderId);
  try { session.socket.close(); } catch (error) {}
  if (session.finishResolve) {
    session.finishResolve({
      ok: result.ok !== false,
      transcript: sessionTranscript(session),
      error: result.error || null,
    });
    session.finishResolve = null;
  }
}

function handleTranscriptionMessage(session, raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch (error) { return; }
  if (message.type === 'session.created' || message.type === 'session.updated') {
    emitTranscription(session, { type: 'status', status: 'connected' });
    return;
  }
  if (message.type === 'conversation.item.input_audio_transcription.text') {
    session.interim = `${String(message.text || '').trim()}${String(message.stash || '').trim()}`;
    emitTranscription(session, {
      type: 'transcript',
      final: session.finalSegments.join(' ').trim(),
      interim: session.interim,
    });
    return;
  }
  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = String(message.transcript || '').trim();
    if (transcript && session.finalSegments[session.finalSegments.length - 1] !== transcript) {
      session.finalSegments.push(transcript);
    }
    session.interim = '';
    emitTranscription(session, {
      type: 'transcript',
      final: session.finalSegments.join(' ').trim(),
      interim: '',
    });
    return;
  }
  if (message.type === 'error' || message.type === 'conversation.item.input_audio_transcription.failed') {
    const details = message.error && message.error.message || '实时转写服务返回错误';
    emitTranscription(session, { type: 'error', message: details });
    session.lastError = details;
    return;
  }
  if (message.type === 'session.finished') {
    closeTranscriptionSession(session, { ok: !session.lastError, error: session.lastError });
  }
}

ipcMain.handle('transcription:get-config', () => publicTranscriptionConfig());

ipcMain.handle('transcription:set-config', (event, payload) => {
  const previous = readStoredTranscriptionSettings();
  const region = payload && payload.region === 'singapore' ? 'singapore' : 'beijing';
  const workspaceId = String(payload && payload.workspaceId || '').trim();
  const apiKey = String(payload && payload.apiKey || '').trim();
  const llmApiKey = String(payload && payload.llmApiKey || '').trim();
  const llmBaseUrl = String(payload && payload.llmBaseUrl || previous.llmBaseUrl || 'https://api.deepseek.com').trim();
  const llmModel = String(payload && payload.llmModel || previous.llmModel || 'deepseek-v4-flash').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (workspaceId && !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    return { ok: false, error: 'invalid_workspace' };
  }
  let parsedLlmUrl;
  try { parsedLlmUrl = new URL(llmBaseUrl); } catch (error) { parsedLlmUrl = null; }
  if (!parsedLlmUrl || parsedLlmUrl.protocol !== 'https:' || parsedLlmUrl.username || parsedLlmUrl.password) {
    return { ok: false, error: 'invalid_llm_url' };
  }
  if ((apiKey || llmApiKey) && !safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'secure_storage_unavailable' };
  }
  const next = {
    region,
    workspaceId,
    encryptedApiKey: apiKey
      ? safeStorage.encryptString(apiKey).toString('base64')
      : String(previous.encryptedApiKey || ''),
    llmBaseUrl: parsedLlmUrl.toString().replace(/\/$/, ''),
    llmModel,
    encryptedLlmApiKey: llmApiKey
      ? safeStorage.encryptString(llmApiKey).toString('base64')
      : String(previous.encryptedLlmApiKey || ''),
  };
  try {
    fs.writeFileSync(getTranscriptionSettingsPath(), JSON.stringify(next), { mode: 0o600 });
    return { ok: true, ...publicTranscriptionConfig() };
  } catch (error) {
    return { ok: false, error: 'save_failed' };
  }
});

ipcMain.handle('transcription:start', (event) => {
  const config = resolveTranscriptionConfig();
  if (!config.apiKey) return { ok: false, error: 'not_configured' };
  const existing = transcriptionSessions.get(event.sender.id);
  if (existing) closeTranscriptionSession(existing, { ok: false, error: 'replaced' });
  return new Promise((resolve) => {
    const headers = {
      Authorization: `Bearer ${config.apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
      'User-Agent': 'DynamicPanel/0.3',
    };
    if (config.workspaceId) headers['X-DashScope-WorkSpace'] = config.workspaceId;
    const socket = new WebSocket(transcriptionUrl(config), { headers });
    const session = {
      sender: event.sender,
      senderId: event.sender.id,
      socket,
      finalSegments: [],
      interim: '',
      ready: false,
      closed: false,
      startSettled: false,
      finishResolve: null,
      connectTimer: null,
      finishTimer: null,
      lastError: '',
    };
    transcriptionSessions.set(event.sender.id, session);
    const settleStart = (result) => {
      if (session.startSettled) return;
      session.startSettled = true;
      clearTimeout(session.connectTimer);
      resolve(result);
    };
    session.connectTimer = setTimeout(() => {
      settleStart({ ok: false, error: 'connect_timeout' });
      closeTranscriptionSession(session, { ok: false, error: 'connect_timeout' });
    }, 8000);
    socket.on('open', () => {
      session.ready = true;
      socket.send(JSON.stringify({
        event_id: transcriptionEventId(),
        type: 'session.update',
        session: {
          input_audio_format: 'pcm',
          sample_rate: TRANSCRIPTION_SAMPLE_RATE,
          input_audio_transcription: { language: 'zh' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0,
            silence_duration_ms: 400,
          },
        },
      }));
      settleStart({ ok: true });
    });
    socket.on('message', (data) => handleTranscriptionMessage(session, data));
    socket.on('error', (error) => {
      const message = String(error && error.message || 'connection_failed');
      emitTranscription(session, { type: 'error', message });
      settleStart({ ok: false, error: 'connection_failed' });
      closeTranscriptionSession(session, { ok: false, error: message });
    });
    socket.on('close', () => {
      settleStart({ ok: false, error: 'connection_closed' });
      closeTranscriptionSession(session, { ok: !session.lastError, error: session.lastError || null });
    });
  });
});

ipcMain.on('transcription:audio', (event, bytes) => {
  const session = transcriptionSessions.get(event.sender.id);
  if (!session || !session.ready || session.closed || session.socket.readyState !== WebSocket.OPEN) return;
  const buffer = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes || []);
  if (!buffer.length || buffer.length > 512 * 1024) return;
  session.socket.send(JSON.stringify({
    event_id: transcriptionEventId(),
    type: 'input_audio_buffer.append',
    audio: buffer.toString('base64'),
  }));
});

ipcMain.handle('transcription:finish', (event) => {
  const session = transcriptionSessions.get(event.sender.id);
  if (!session || session.closed) return { ok: false, error: 'not_active', transcript: '' };
  if (session.finishResolve) return { ok: false, error: 'already_finishing', transcript: sessionTranscript(session) };
  return new Promise((resolve) => {
    session.finishResolve = resolve;
    session.finishTimer = setTimeout(() => {
      closeTranscriptionSession(session, { ok: false, error: 'finish_timeout' });
    }, TRANSCRIPTION_FINISH_TIMEOUT_MS);
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ event_id: transcriptionEventId(), type: 'session.finish' }));
    } else {
      closeTranscriptionSession(session, { ok: false, error: 'connection_closed' });
    }
  });
});

function closeAllTranscriptionSessions() {
  for (const session of transcriptionSessions.values()) {
    closeTranscriptionSession(session, { ok: false, error: 'app_quit' });
  }
}

// ============ 录音资料库 ============
function getRecordingsDir() {
  return workspacePath(RECORDINGS_DIR_NAME);
}

function ensureRecordingsDir() {
  try {
    fs.mkdirSync(getRecordingsDir(), { recursive: true });
  } catch (error) {
    // 目录不可用时由保存 IPC 返回失败。
  }
}

function getSafeRecordingPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const directory = path.resolve(getRecordingsDir());
  const resolvedPath = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(workspaceRoot(), value);
  if (path.dirname(resolvedPath) !== directory) return null;
  if (!/^recording-[a-z0-9-]+\.(webm|m4a|ogg|wav)$/i.test(path.basename(resolvedPath))) {
    return null;
  }
  try {
    const directoryStat = fs.lstatSync(directory);
    const fileStat = fs.lstatSync(resolvedPath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    return resolvedPath;
  } catch (error) {
    return null;
  }
}

ipcMain.handle('recordings:save', async (event, payload) => {
  if (!payload || !payload.bytes) return { ok: false, error: 'empty_audio' };
  let buffer;
  try {
    buffer = Buffer.from(payload.bytes);
  } catch (error) {
    return { ok: false, error: 'invalid_audio' };
  }
  if (!buffer.length || buffer.length > RECORDING_MAX_BYTES) {
    return { ok: false, error: buffer.length ? 'audio_too_large' : 'empty_audio' };
  }
  ensureRecordingsDir();
  const mimeType = String(payload.mimeType || 'audio/webm').slice(0, 80);
  const extension = recordingExtension(mimeType);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const audioPath = path.join(getRecordingsDir(), `recording-${id}.${extension}`);
  try {
    await fs.promises.writeFile(audioPath, buffer, { flag: 'wx' });
    return { ok: true, audioPath: path.join(RECORDINGS_DIR_NAME, path.basename(audioPath)), mimeType };
  } catch (error) {
    return { ok: false, error: 'write_failed' };
  }
});

ipcMain.handle('recordings:read', async (event, audioPath) => {
  const safePath = getSafeRecordingPath(audioPath);
  if (!safePath) return null;
  try {
    const bytes = await fs.promises.readFile(safePath);
    const extension = path.extname(safePath).slice(1).toLowerCase();
    const mimeType = extension === 'm4a' ? 'audio/mp4' : `audio/${extension || 'webm'}`;
    return { bytes, mimeType };
  } catch (error) {
    return null;
  }
});

ipcMain.handle('recordings:delete', async (event, audioPath) => {
  const safePath = getSafeRecordingPath(audioPath);
  if (!safePath) return false;
  try {
    await fs.promises.unlink(safePath);
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('recordings:reveal', (event, audioPath) => {
  const safePath = getSafeRecordingPath(audioPath);
  if (!safePath) return false;
  shell.showItemInFolder(safePath);
  return true;
});

// ============ 剪贴板历史 ============

function getClipImagesDir() {
  return workspacePath(CLIP_IMAGES_DIR_NAME);
}

// 图片记录使用扁平目录和固定文件名。拒绝子目录、符号链接和非普通文件，
// 避免 localStorage 被篡改后通过 ../ 或 symlink 读写目录外文件。
function getSafeClipImagePath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const dir = path.resolve(getClipImagesDir());
  const resolvedPath = path.isAbsolute(p)
    ? path.resolve(p)
    : path.resolve(workspaceRoot(), p);
  if (path.dirname(resolvedPath) !== dir) return null;
  if (!/^clip-[a-z0-9]+\.png$/i.test(path.basename(resolvedPath))) return null;
  try {
    const dirStat = fs.lstatSync(dir);
    const fileStat = fs.lstatSync(resolvedPath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    return resolvedPath;
  } catch (e) {
    return null;
  }
}

function ensureClipImagesDir() {
  try {
    fs.mkdirSync(getClipImagesDir(), { recursive: true });
  } catch (e) {
    // 目录已存在或无权限，静默
  }
}

async function readSystemClipboard(includeImage = false) {
  try {
    const items = await clipboard.read();
    const observation = await readClipboardObservation(items, { includeImage });
    let image = null;
    if (observation.image?.buffer) {
      const native = nativeImage.createFromBuffer(observation.image.buffer);
      if (!native.isEmpty()) {
        const size = native.getSize();
        image = prepareClipboardImagePayload(
          observation.image.mimeType,
          observation.image.buffer,
          size
        );
      }
    }
    return { concealed: observation.concealed, text: observation.text, image };
  } catch (error) {
    return { concealed: false, text: '', image: null };
  }
}

async function baselineCurrentClipboard(generation) {
  try {
    const observation = await readSystemClipboard(true);
    if (!clipPollingEnabled || generation !== clipPollingGeneration) return;
    if (observation.concealed) {
      clipObservationState = reduceClipboardObservation(
        {},
        { concealed: true },
        { baseline: true }
      ).state;
      return;
    }
    clipObservationState = reduceClipboardObservation(
      {},
      { text: observation.text, imageFingerprint: observation.image?.fingerprint || null },
      { baseline: true }
    ).state;
    lastClipImageProbeAt = Date.now();
  } catch (error) {
    clipObservationState = { textFingerprint: null, imageFingerprint: null };
  }
}

async function pollClipboard() {
  if (!clipPollingEnabled || !mainWindow) return;
  if (clipPolling) return;
  clipPolling = true;
  try {
    const now = Date.now();
    const includeImage = now - lastClipImageProbeAt >= CLIP_IMAGE_POLL_INTERVAL_MS;
    const observation = await readSystemClipboard(includeImage);
    if (!clipPollingEnabled) return;
    // 密码管理器写入的敏感内容：跳过不记录、不更新指纹
    if (observation.concealed) return;

    // 优先读文字
    const text = observation.text;
    if (text) {
      const decision = reduceClipboardObservation(clipObservationState, { text });
      clipObservationState = decision.state;
      if (decision.record && clipPollingEnabled) {
        const type = /^https?:\/\//i.test(text.trim()) ? 'url' : 'text';
        mainWindow.webContents.send('clipboard:new-entry', { type, text, imagePath: null });
      }
      return;
    }

    // 文字为空再读图片
    if (!text && includeImage) {
      lastClipImageProbeAt = now;
      const result = observation.image;
      const decision = reduceClipboardObservation(clipObservationState, {
        text: '',
        imageFingerprint: result?.fingerprint || null,
      });
      clipObservationState = decision.state;
      if (result && decision.record && clipPollingEnabled) {
        const pngBuf = result.pngBuffer
          || nativeImage.createFromBuffer(result.sourceBuffer).toPNG();
        if (!pngBuf.length) return;
        ensureClipImagesDir();
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const fileName = 'clip-' + id + '.png';
        const imagePath = path.join(getClipImagesDir(), fileName);
        try {
          await fs.promises.writeFile(imagePath, pngBuf);
        } catch (e) {
          return; // 写盘失败不记录
        }
        if (!clipPollingEnabled) {
          try { await fs.promises.unlink(imagePath); } catch (error) {}
          return;
        }
        mainWindow.webContents.send('clipboard:new-entry', {
          type: 'image',
          text: null,
          imagePath,
        });
      }
    }
  } catch (e) {
    // 轮询任何异常不能崩主进程，静默
  } finally {
    clipPolling = false;
  }
}

function startClipboardPolling() {
  // Electron 没有 NSPasteboard.changeCount，只能内容轮询：靠文本本身与
  // 图片 PNG 内容哈希指纹去重（见 pollClipboard）。
  if (clipPollingEnabled) return;
  clipPollingEnabled = true;
  const generation = ++clipPollingGeneration;
  // 首次开启只建立当前系统剪贴板基线，不把开启前的内容写入历史。
  clipBaselineTimer = setTimeout(() => {
    clipBaselineTimer = null;
    if (!clipPollingEnabled) return;
    void baselineCurrentClipboard(generation).finally(() => {
      if (clipPollingEnabled && generation === clipPollingGeneration && !clipPollTimer) {
        clipPollTimer = setInterval(pollClipboard, CLIP_POLL_INTERVAL_MS);
      }
    });
  }, 0);
}

function stopClipboardPolling() {
  clipPollingEnabled = false;
  clipPollingGeneration += 1;
  if (clipBaselineTimer) {
    clearTimeout(clipBaselineTimer);
    clipBaselineTimer = null;
  }
  if (clipPollTimer) {
    clearInterval(clipPollTimer);
    clipPollTimer = null;
  }
  clipObservationState = { textFingerprint: null, imageFingerprint: null };
  lastClipImageProbeAt = 0;
}

function setHoverSpaceShortcut(enabled) {
  if (enabled === spaceShortcutRegistered) return;
  if (!enabled) {
    if (globalShortcut.isRegistered('Space')) globalShortcut.unregister('Space');
    spaceShortcutRegistered = false;
    return;
  }
  try {
    const ok = globalShortcut.register('Space', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      // 展开动作后的极短窗口内，全局 Space 还未来得及注销；这时也要把第二次
      // Space 作为收起处理，避免快速连按被吞掉。
      if (currentMode === 'expanded') {
        mainWindow.webContents.send('shortcut:toggle-panel');
        return;
      }
      await rememberPasteTarget();
      hideWhenCollapsed = false;
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('shortcut:toggle-panel');
    });
    spaceShortcutRegistered = ok && globalShortcut.isRegistered('Space');
  } catch (error) {
    spaceShortcutRegistered = false;
  }
}

function startHoverSpaceShortcut() {
  const policy = hoverSpacePollingPolicy({
    shortcut: configuredShortcut,
    visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    mode: currentMode,
  });
  if (!policy.enabled) return;
  if (spaceShortcutTimer) return;
  spaceShortcutTimer = setInterval(() => {
    const currentPolicy = hoverSpacePollingPolicy({
      shortcut: configuredShortcut,
      visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      mode: currentMode,
    });
    if (!currentPolicy.enabled) {
      stopHoverSpaceShortcut();
      return;
    }
    const point = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const hovering = point.x >= bounds.x && point.x < bounds.x + bounds.width
      && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    setHoverSpaceShortcut(hovering);
  }, policy.intervalMs);
}

function stopHoverSpaceShortcut() {
  if (spaceShortcutTimer) clearInterval(spaceShortcutTimer);
  spaceShortcutTimer = null;
  setHoverSpaceShortcut(false);
}

function syncHoverSpacePolling() {
  const policy = hoverSpacePollingPolicy({
    shortcut: configuredShortcut,
    visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    mode: currentMode,
  });
  if (policy.enabled) startHoverSpaceShortcut();
  else stopHoverSpaceShortcut();
}

ipcMain.handle('shortcut:hover-space-status', () => ({
  registered: spaceShortcutRegistered && globalShortcut.isRegistered('Space'),
  mode: currentMode,
  cursor: screen.getCursorScreenPoint(),
  bounds: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null,
}));

// 渲染层请求把图片文件读成 dataURL 回显（contextIsolation 下 file:// 受限，走 IPC 读盘）
ipcMain.handle('clipboard:readImage', async (event, imagePath) => {
  const safePath = getSafeClipImagePath(imagePath);
  if (!safePath) return null; // 只允许读自己的图片目录
  try {
    const buf = await fs.promises.readFile(safePath);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
});

// FIFO 淘汰 / 删除 / 清空时，连带删除本地图片文件（文件 I/O 归主进程）
ipcMain.handle('clipboard:deleteImages', async (event, paths) => {
  if (!Array.isArray(paths)) return;
  for (const p of paths) {
    const safePath = getSafeClipImagePath(p);
    if (safePath) {
      try {
        await fs.promises.unlink(safePath);
      } catch (e) {
        // 文件已不存在等，静默
      }
    }
  }
});

async function writeClipboardEntry(entry) {
  if (!entry) return false;
  try {
    const safeImagePath =
      entry.type === 'image' ? getSafeClipImagePath(entry.imagePath) : null;
    if (safeImagePath) {
      const buf = fs.readFileSync(safeImagePath);
      const image = nativeImage.createFromBuffer(buf);
      if (image.isEmpty()) return false;
      const pngBuf = image.toPNG();
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([pngBuf], { type: 'image/png' }),
        }),
      ]);
      const size = image.getSize();
      const fingerprint = createClipboardImageFingerprint(size.width, size.height, pngBuf);
      if (fingerprint) {
        clipObservationState = reduceClipboardObservation(
          clipObservationState,
          { imageFingerprint: fingerprint },
          { baseline: true }
        ).state;
      }
    } else if (entry.text) {
      await clipboard.writeText(entry.text);
      clipObservationState = reduceClipboardObservation(
        clipObservationState,
        { text: entry.text },
        { baseline: true }
      ).state;
    } else {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function waitForCollapsedPanel(timeoutMs = 950) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (currentMode !== 'expanded' || Date.now() >= deadline) return resolve(currentMode !== 'expanded');
      setTimeout(check, 32);
    };
    check();
  });
}

function pasteToPreviousApp(target) {
  return new Promise((resolve) => {
    const bundleId = String(target?.bundleId || '');
    if (!bundleId) return resolve(false);
    execFile('/usr/bin/osascript', [
      '-l', 'JavaScript', '-e', PASTE_TO_APP_JXA, bundleId,
    ], { timeout: 3000 }, (error, stdout) => {
      resolve(!error && String(stdout || '').trim() === 'ok');
    });
  });
}

ipcMain.handle('clipboard:write', (event, entry) => writeClipboardEntry(entry));

// 点击历史项后先收起灵动岛，再回到打开面板前的应用执行粘贴。
// 若系统尚未授予辅助功能权限，内容仍保留在系统剪贴板作为可靠降级。
ipcMain.handle('clipboard:paste', async (event, entry) => {
  if (!await writeClipboardEntry(entry)) return { ok: false, pasted: false };
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
    return { ok: true, pasted: false, permissionRequired: true };
  }
  const target = previousPasteTarget;
  requestRendererCollapse();
  await waitForCollapsedPanel();
  const pasted = await pasteToPreviousApp(target);
  return { ok: true, pasted };
});

function ensureFirstRunAutoLaunch() {
  // 首次运行时默认开启开机自启；之后尊重用户在托盘菜单的选择
  if (process.platform !== 'darwin') return;
  const marker = path.join(app.getPath('userData'), '.first-run-done');
  if (fs.existsSync(marker)) return;
  try {
    setAutoLaunch(true);
    fs.writeFileSync(marker, String(Date.now()));
  } catch (e) {
    // ignore
  }
}

function watchDisplayChanges() {
  // 接/拔外接屏、改变屏幕排列、改分辨率 → 自动重新定位到当前活跃屏顶部居中
  // 加 100ms 防抖：插拔屏时系统会连续触发多次事件
  let timer = null;
  const reposition = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!mainWindow) return;
      repositionWindow();
      if (!mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('window:metrics-changed', getLayoutMetrics());
      }
      if (notificationWindow && !notificationWindow.isDestroyed() && notificationWindow.isVisible()) {
        notificationWindow.setBounds(getTaskNotificationBounds());
        if (activeTaskNotification && !taskNotificationLeaving) {
          notificationWindow.webContents.send('task-notification:show', {
            ...activeTaskNotification,
            ...getTaskNotificationPresentation(),
            pendingCount: getPendingTaskNotificationCount(),
          });
        }
      }
      systemUIGuard.refresh();
    }, 100);
  };
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  screen.on('display-metrics-changed', reposition);
}

function syncSystemUIAvoidance() {
  if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  if (currentMode === 'collapsed' && !notchPreviewActive) {
    const desired = getBoundsForMode('collapsed');
    const actual = mainWindow.getBounds();
    if (actual.width !== desired.width || actual.x !== desired.x) {
      mainWindow.setBounds(desired, false);
      mainWindow.webContents.send('window:metrics-changed', getLayoutMetrics());
    }
  }
  const blocked = systemUIBlocks(getBoundsForMode('collapsed'));
  if (notchPreviewActive && systemUIBlocks(getBoundsForMode('preview'))) dismissNotchPreviewSurface();
  if (blocked) {
    dismissNotchPreviewSurface();
    if (quickIslandWindow && !quickIslandWindow.isDestroyed() && !quickIslandInteractive) hideQuickIsland(true);
  }
  const quickVisible = quickIslandWindow && !quickIslandWindow.isDestroyed() && quickIslandWindow.isVisible();
  setCollapsedIslandCovered(Boolean(quickVisible));
  const status = statusIsland.getWindow();
  if (status && !status.isDestroyed() && status.isVisible() && systemUIBlocks(status.getBounds())) statusIsland.hide(true);
  const notificationBlocked = systemUIBlocks(getTaskNotificationBounds())
    || (activeTaskNotification && !taskNotificationPaused && notificationWindow
      && !notificationWindow.isDestroyed() && systemUIBlocks(notificationWindow.getBounds()));
  if (activeTaskNotification && !taskNotificationLeaving && notificationWindow && !notificationWindow.isDestroyed()) {
    if (notificationBlocked && !taskNotificationPaused) {
      taskNotificationRemainingMs = Math.max(0, taskNotificationRemainingMs - (Date.now() - taskNotificationTimerStartedAt));
      taskNotificationPaused = true;
      clearTaskNotificationTimers();
      appearanceNative.clear(notificationWindow);
      notificationWindow.hide();
    } else if (!notificationBlocked && taskNotificationPaused) {
      taskNotificationPaused = false;
      notificationWindow.setBounds(getTaskNotificationBounds());
      notificationWindow.showInactive();
      notificationWindow.webContents.send('task-notification:show', {
        ...activeTaskNotification, ...getTaskNotificationPresentation(), pendingCount: getPendingTaskNotificationCount(),
      });
      scheduleTaskNotificationDismiss();
    }
  } else if (!notificationBlocked) showNextTaskNotification();
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  ensureFirstRunAutoLaunch();
  systemUIGuard.refresh();
  createWindow();
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: '工作台', iconPath: path.join(__dirname, 'renderer', 'assets', 'xuanfudao-icon.png') });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '工作台', submenu: [
        { role: 'about', label: '关于工作台' },
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide', label: '隐藏工作台' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit', label: '退出工作台' },
      ] },
      { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
  }
  statusIsland.start();
  systemStatus.start().then((result) => {
    if (result?.snapshot) { lastIslandSystemSnapshot = result.snapshot; broadcastIsland('island:system-status', result.snapshot); }
  }).catch(() => {});
  islandActivityTimer = setInterval(updateIslandActivities, 1000);
  islandActivityTimer.unref?.();
  void aiCodeRuntime.select(aiTools.getSnapshot()).catch(() => {});
  powerMonitor.on('lock-screen', () => {
    systemSessionLocked = true;
    requestRendererCollapse({ immediate: true });
    hideQuickIsland(true);
    syncSystemUIAvoidance();
  });
  powerMonitor.on('unlock-screen', () => { systemSessionLocked = false; systemUIGuard.refresh(); });
  powerMonitor.on('suspend', () => { systemSleeping = true; syncSystemUIAvoidance(); aiCodeRuntime.stop(); });
  powerMonitor.on('resume', () => {
    systemSleeping = false;
    systemUIGuard.refresh();
    if (!isQuitting) void aiCodeRuntime.select(aiTools.getSnapshot()).catch(() => {});
  });
  createTray();
  watchDisplayChanges();
  systemUIGuard.start();
  ensureClipImagesDir();
  ensureRecordingsDir();
  applyAppSettings();
  startTaskNotificationServer();
  if (aiTools.getSnapshot().needsSetup) {
    const chooseCode = () => { if (!isQuitting) void openIslandWorkspace('codes'); };
    if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', chooseCode);
    else chooseCode();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 常驻菜单栏应用：所有窗口暂时关闭时仍保持后台运行。
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  systemUIGuard.stop();
  appearanceNative.dispose();
  isQuitting = true;
  hideWhenCollapsed = false;
  hideQuickIsland(true);
  statusIsland.destroy();
  systemStatus.stop();
  aiCodeRuntime.stop();
  clearInterval(islandActivityTimer);
});

app.on('will-quit', () => {
  hideQuickIsland(true);
  if (quickIslandWindow && !quickIslandWindow.isDestroyed()) quickIslandWindow.destroy();
  cancelCollapseWatchdog();
  clearTodoReminderTimer();
  stopHoverSpaceShortcut();
  clearTaskNotificationTimers();
  stopTaskNotificationServer();
  closeAllTranscriptionSessions();
  globalShortcut.unregisterAll();
  stopClipboardPolling();
});
