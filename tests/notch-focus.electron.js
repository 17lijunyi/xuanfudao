const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'to-do-panel-electron-test-'));
app.setPath('userData', isolatedUserData);
app.once('will-quit', () => fs.rmSync(isolatedUserData, { recursive: true, force: true }));

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 256,
    height: 38,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      // 与生产主窗口一致，避免 macOS 将重复运行的测试窗口判为遮挡后暂停 rAF。
      backgroundThrottling: false,
    },
  });

  try {
    await window.loadURL('about:blank');
    await window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.notchAPI = {
        getAITools: async () => ({ ok: true, revision: 0, catalog: ${JSON.stringify(require('../ai-tools').CATALOG)},
          state: { selected: 'codex', confirmed: true }, needsSetup: false }),
        getAICodeStatus: async () => ({ providerId: 'codex', selectionRevision: 0,
          connection: 'unavailable', windows: [], threads: [] }),
      };`,
    });
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    assert.equal(await window.webContents.executeJavaScript('window.AITools.currentTool().id'), 'codex');
    await window.webContents.executeJavaScript(`
      window.notchAPI = {
        ...(window.notchAPI || {}),
        setMode: async (mode) => ({ ok: true, mode }),
        beginCollapse: async () => ({ ok: true }),
      };
      void 0;
    `);
    const freshProfileClipboardState = await window.webContents.executeJavaScript(`
      (() => ({
        history: localStorage.getItem('notch-clip-history'),
        favorites: localStorage.getItem('notch-clip-favorites'),
        imageRows: document.querySelectorAll('#clip-list [data-type="image"]').length,
      }))()
    `);
    assert.deepEqual(freshProfileClipboardState, {
      history: null,
      favorites: null,
      imageRows: 0,
    }, '全新用户目录不得预置任何剪贴板文本、收藏或图片记录');

    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    window.show();
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    const focusStyle = await window.webContents.executeJavaScript(`
      (async () => {
        const notch = document.getElementById('notch');
        const deadline = performance.now() + 5000;
        let result;
        do {
          const notchStyle = getComputedStyle(notch);
          const quotaFocusStyle = getComputedStyle(notch.querySelector('.codex-notch-quota'), '::after');
          const tasksFocusStyle = getComputedStyle(notch.querySelector('.codex-notch-tasks'), '::after');
          result = {
            active: document.activeElement === notch,
            focusVisible: notch.matches(':focus-visible'),
            outlineStyle: notchStyle.outlineStyle,
            outlineWidth: notchStyle.outlineWidth,
            contentOutline: getComputedStyle(notch.querySelector('.codex-notch')).outlineStyle,
            quotaFocus: quotaFocusStyle.borderTopStyle,
            tasksFocus: tasksFocusStyle.borderTopStyle,
          };
          if (result.active && result.focusVisible) return result;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (performance.now() < deadline);
        return result;
      })()
    `);

    assert.equal(focusStyle.active, true, '折叠条应能通过键盘获得焦点');
    assert.equal(focusStyle.focusVisible, true, '键盘焦点应保持可见提示');
    assert.equal(
      focusStyle.outlineStyle,
      'none',
      `折叠外壳不能画焦点描边，当前为 ${focusStyle.outlineWidth} ${focusStyle.outlineStyle}`
    );
    assert.equal(focusStyle.contentOutline, 'none', '焦点外框不得穿过中央物理刘海');
    assert.equal(focusStyle.quotaFocus, 'none', '左翼保持无额外描边，键盘操作仍可用');
    assert.equal(focusStyle.tasksFocus, 'none', '右翼保持无额外描边，键盘操作仍可用');

    const collapsedPanelLayers = await window.webContents.executeJavaScript(`
      (() => {
        const panel = document.querySelector('.panel');
        return {
          contentClipPath: getComputedStyle(panel).clipPath,
          shellClipPath: getComputedStyle(panel, '::before').clipPath,
        };
      })()
    `);
    assert.equal(
      collapsedPanelLayers.contentClipPath,
      'none',
      '折叠动效不得裁剪承载全部组件的内容层'
    );
    assert.notEqual(
      collapsedPanelLayers.shellClipPath,
      'none',
      '折叠轮廓应由独立背景外壳承担'
    );

    window.setSize(1240, 616);
    const topbarBlankToggle = await window.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitForClass = async (name) => {
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            if (document.getElementById('app').classList.contains(name)) {
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              return true;
            }
            await sleep(10);
          }
          return false;
        };
        // 生产默认开启超过四个 Tab，会进入左右分栏并让容器横跨整条顶栏。
        document.getElementById('tabs').classList.add('is-split');
        document.getElementById('notch').click();
        const opened = await waitForClass('expanded');
        const topbar = document.querySelector('.topbar').getBoundingClientRect();
        const x = topbar.left + topbar.width / 2;
        const y = topbar.top + topbar.height / 2;
        const hitTarget = document.elementFromPoint(x, y);
        const interceptedByTabs = Boolean(hitTarget?.closest('.tabs'));
        hitTarget?.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }));
        const collapsed = await waitForClass('collapsed');
        return {
          opened,
          collapsed,
          interceptedByTabs,
          hitTarget: hitTarget?.id || hitTarget?.className || hitTarget?.tagName || '',
          appClass: document.getElementById('app').className,
          panelAriaHidden: document.querySelector('.panel').getAttribute('aria-hidden'),
        };
      })()
    `);
    assert.equal(topbarBlankToggle.opened, true, '折叠岛点击后必须展开');
    assert.equal(
      topbarBlankToggle.interceptedByTabs,
      false,
      `顶部中央空白不得被 Tab 容器截获，当前命中 ${topbarBlankToggle.hitTarget}`
    );
    assert.equal(
      topbarBlankToggle.collapsed,
      true,
      `展开后点击顶部中央空白必须收起；最终状态 ${topbarBlankToggle.appClass} / aria-hidden=${topbarBlankToggle.panelAriaHidden}`
    );

    const topbarTabAndSpaceToggle = await window.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitForClass = async (name) => {
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            if (document.getElementById('app').classList.contains(name)) {
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              return true;
            }
            await sleep(10);
          }
          return false;
        };
        document.getElementById('notch').click();
        const opened = await waitForClass('expanded');
        const todoButton = document.getElementById('tab-button-todo');
        const rect = todoButton.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        hitTarget?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(30);
        const todoActivated = document.getElementById('tab-todo').classList.contains('active');
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }));
        const collapsedBySpace = await waitForClass('collapsed');
        return {
          opened,
          todoActivated,
          tabHit: Boolean(hitTarget?.closest('#tab-button-todo')),
          collapsedBySpace,
        };
      })()
    `);
    assert.equal(topbarTabAndSpaceToggle.opened, true);
    assert.equal(topbarTabAndSpaceToggle.tabHit, true, '空白穿透不得破坏真实 Tab 的点击命中');
    assert.equal(topbarTabAndSpaceToggle.todoActivated, true, '真实 Tab 点击必须继续切换页面');
    assert.equal(topbarTabAndSpaceToggle.collapsedBySpace, true, '展开后 Space 必须继续收起');

    window.setSize(1240, 616);
    const settingsSurface = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const appSurface = document.getElementById('app');
        appSurface.classList.remove('collapsed');
        appSurface.classList.add('expanded');
        document.getElementById('tab-button-settings').click();
        setTimeout(() => {
          const page = document.getElementById('settings-page');
          const panel = document.querySelector('.panel');
          const shellClipPath = getComputedStyle(panel, '::before').clipPath;
          resolve({
            contentClipPath: getComputedStyle(panel).clipPath,
            shellOwnsExpandedOutline: shellClipPath !== 'none' && !shellClipPath.includes('calc'),
            rightmostTab: document.querySelector('.tab[data-tab]:last-of-type')?.dataset.tab,
            activePanel: document.getElementById('tab-settings')?.classList.contains('active'),
            display: getComputedStyle(page).display,
            columns: getComputedStyle(page).gridTemplateColumns.split(' ').filter(Boolean).length,
            api: Boolean(document.getElementById('settings-api-configure')),
            mirror: Boolean(document.getElementById('settings-mirror-choose')),
            features: document.querySelectorAll('[data-settings-feature]').length,
            homeModules: document.querySelectorAll('[data-settings-home-module]').length,
            shortcut: Boolean(document.getElementById('settings-shortcut-change')),
            workspace: Boolean(document.getElementById('settings-workspace-choose')),
            autoLaunch: Boolean(document.getElementById('settings-auto-launch')),
          });
        }, 80);
      })
    `);

    assert.deepEqual(settingsSurface, {
      contentClipPath: 'none',
      shellOwnsExpandedOutline: true,
      rightmostTab: 'settings',
      activePanel: true,
      display: 'grid',
      columns: 2,
      api: true,
      mirror: true,
      features: 7,
      homeModules: 7,
      shortcut: true,
      workspace: true,
      autoLaunch: true,
    });

    const credentialSelectionAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const originalApi = window.notchAPI;
        const item = {
          id: 'credential-selection-test',
          service: 'Example',
          account: 'me@example.com',
          password: 'secret',
          passwordMask: '**********',
        };
        window.notchAPI = {
          saveCredential: async () => ({ ok: true }),
          listCredentials: async () => ({ items: [item], secureStorage: true }),
          getCredential: async () => ({ ok: true, item }),
          deleteCredentials: async () => ({ ok: true }),
          copyCredential: async () => true,
        };
        document.getElementById('tab-button-credentials').click();
        document.getElementById('credential-service').value = item.service;
        document.getElementById('credential-account').value = item.account;
        document.getElementById('credential-password').value = item.password;
        document.getElementById('credential-save').click();
        const deadline = performance.now() + 2000;
        while (!document.querySelector('.credential-item[data-id="credential-selection-test"]')
          && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        let row = document.querySelector('.credential-item[data-id="credential-selection-test"]');
        row.querySelector('.credential-copy').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const bulkDelete = document.getElementById('credential-bulk-delete');
        const selected = document.querySelector('.credential-item[data-id="credential-selection-test"]');
        const searchRect = document.getElementById('credential-search').getBoundingClientRect();
        const deleteRect = bulkDelete.getBoundingClientRect();
        const selectedState = {
          card: selected.classList.contains('multi-selected'),
          deleteVisible: !bulkDelete.hidden && getComputedStyle(bulkDelete).display !== 'none',
          actionsShareOneRow: Math.abs(
            (searchRect.top + searchRect.bottom) / 2 - (deleteRect.top + deleteRect.bottom) / 2
          ) < 2 && deleteRect.left >= searchRect.right,
        };
        selected.querySelector('.credential-copy').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        row = document.querySelector('.credential-item[data-id="credential-selection-test"]');
        const clearedState = {
          card: row.classList.contains('multi-selected'),
          deleteHidden: bulkDelete.hidden && getComputedStyle(bulkDelete).display === 'none',
          editing: row.classList.contains('editing'),
        };
        window.notchAPI = originalApi;
        return { selectedState, clearedState };
      })()
    `);
    assert.deepEqual(credentialSelectionAudit, {
      selectedState: { card: true, deleteVisible: true, actionsShareOneRow: true },
      clearedState: { card: false, deleteHidden: true, editing: false },
    }, '密钥批量删除应与搜索框同行，并在取消选中后隐藏');

    const todoCalendarNavigation = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        document.getElementById('tab-button-todo').click();
        const trigger = document.querySelector('.todo-deadline-trigger[data-deadline-priority="P0"]');
        trigger.click();
        const previous = document.getElementById('todo-calendar-previous');
        const next = document.getElementById('todo-calendar-next');
        if (!previous || !next) {
          resolve({ controls: false });
          return;
        }
        const base = new Date();
        const popover = document.getElementById('todo-date-popover');
        const previousRect = previous.getBoundingClientRect();
        const nextRect = next.getBoundingClientRect();
        const clicksToJanuary = 12 - base.getMonth();
        for (let index = 0; index < clicksToJanuary; index += 1) next.click();
        const expectedYear = base.getFullYear() + 1;
        const januaryLabel = document.getElementById('todo-editor-month').textContent.trim();
        const day = [...document.querySelectorAll('#todo-calendar-grid [data-day]')]
          .find((button) => button.dataset.day === '2');
        day.click();
        const selected = new Date(trigger.dataset.deadline);
        previous.click();
        resolve({
          controls: true,
          popoverVisible: !popover.hidden && getComputedStyle(popover).display !== 'none',
          controlsUsable: [previousRect.width, previousRect.height, nextRect.width, nextRect.height]
            .every((size) => size >= 18),
          januaryLabel,
          decemberLabel: document.getElementById('todo-editor-month').textContent.trim(),
          selected: [selected.getFullYear(), selected.getMonth(), selected.getDate()],
          expectedYear,
        });
      })
    `);

    assert.deepEqual(todoCalendarNavigation, {
      controls: true,
      popoverVisible: true,
      controlsUsable: true,
      januaryLabel: `${new Date().getFullYear() + 1}年 1月`,
      decemberLabel: `${new Date().getFullYear()}年 12月`,
      selected: [new Date().getFullYear() + 1, 0, 2],
      expectedYear: new Date().getFullYear() + 1,
    });

    await window.webContents.executeJavaScript(`
      (async () => {
        window.notchAPI = {
          ...window.notchAPI,
          getCodexFloatStatus: async () => ({ providerId: 'codex', connection: 'connected', updatedAt: Date.now(),
            windows: [
              { id: 'primary', label: '5 小时', remainingPercent: 68, resetsAt: Date.now() + 3600000 },
              { id: 'weekly', label: '本周', remainingPercent: 21, resetsAt: Date.now() + 86400000 },
            ], resets: { available: 2 },
            threads: [
              { id: 'one', title: '整理页面组件', status: 'running' },
              { id: 'two', title: '检查应用安装', status: 'idle' },
              { id: 'three', title: '完成项目说明', status: 'completed' },
            ],
          }),
        };
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: false } }));
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      })()
    `);

    const codexResponsiveAudit = [];
    const codexViewportCases = [
      [1240, 616], [1000, 576], [800, 576],
      [1240, 400], [1000, 400], [800, 400],
    ];
    for (const [width, height] of codexViewportCases) {
      window.setSize(width, height);
      const measurements = await window.webContents.executeJavaScript(`
        (async () => {
          const originalApi = window.notchAPI;
          const sleepFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const snapshot = {
            providerId: 'codex',
            connection: 'connected',
            updatedAt: Date.now(),
            windows: [{ id: 'primary', label: '5 小时', remainingPercent: 68 }],
            resets: { available: 2 },
            threads: [
              { id: 'attention-task', title: '需要授权的项目', status: 'attention', attentionKind: 'permission' },
              { id: 'running-task', title: '正在运行的项目', status: 'running' },
              { id: 'completed-task', title: '已完成的项目', status: 'completed' },
            ],
            attentionTasks: [{ id: 'attention-task', title: '需要授权的项目', status: 'attention', attentionKind: 'permission' }],
            recentIssueTasks: [],
            runningTasks: [{ id: 'running-task', title: '正在运行的项目', status: 'running' }],
            recentCompletedTasks: [{ id: 'completed-task', title: '已完成的项目', status: 'completed' }],
          };
          let refreshCalls = 0;
          window.notchAPI = {
            ...originalApi,
            getCodexFloatStatus: async () => snapshot,
            refreshCodexFloat: async () => { refreshCalls += 1; return snapshot; },
          };

          const appSurface = document.getElementById('app');
          const panel = document.getElementById('panel');
          appSurface.classList.remove('collapsed', 'closing', 'opening');
          appSurface.classList.add('expanded');
          panel.inert = false;
          panel.setAttribute('aria-hidden', 'false');
          document.getElementById('tab-button-home').click();
          document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: false } }));
          document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
          await sleepFrame();

          const tiles = [...document.querySelectorAll('#home-bento > [data-home-module]')];
          const savedTiles = tiles.map((tile) => ({
            tile,
            hidden: tile.hidden,
            ariaHidden: tile.getAttribute('aria-hidden'),
            style: tile.getAttribute('style'),
            layoutVariant: tile.getAttribute('data-layout-variant'),
            layoutColumn: tile.getAttribute('data-layout-column'),
            layoutRow: tile.getAttribute('data-layout-row'),
            layoutWidth: tile.getAttribute('data-layout-width'),
            layoutHeight: tile.getAttribute('data-layout-height'),
          }));
          const codexTile = document.getElementById('home-codex');
          const variants = {
            mini: { width: 2, height: 1 },
            compact: { width: 2, height: 2 },
            wide: { width: 6, height: 2 },
            tall: { width: 4, height: 4 },
            full: { width: 12, height: 4 },
          };
          const results = [];

          const visibleGeometry = (element) => {
            const rect = element.getBoundingClientRect();
            const visible = {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            };
            const clippingAncestors = [];
            for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor);
              const ancestorRect = ancestor.getBoundingClientRect();
              const clipsX = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
              const clipsY = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
              if (clipsX || clipsY) {
                if (clipsX) {
                  visible.left = Math.max(visible.left, ancestorRect.left);
                  visible.right = Math.min(visible.right, ancestorRect.right);
                }
                if (clipsY) {
                  visible.top = Math.max(visible.top, ancestorRect.top);
                  visible.bottom = Math.min(visible.bottom, ancestorRect.bottom);
                }
                clippingAncestors.push(ancestor.id || ancestor.className || ancestor.tagName);
              }
            }
            visible.left = Math.max(0, visible.left);
            visible.top = Math.max(0, visible.top);
            visible.right = Math.min(innerWidth, visible.right);
            visible.bottom = Math.min(innerHeight, visible.bottom);
            return {
              rect: {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              },
              visibleWidth: Math.max(0, visible.right - visible.left),
              visibleHeight: Math.max(0, visible.bottom - visible.top),
              clippingAncestors,
            };
          };

          const hitAudit = (element) => {
            const rect = element.getBoundingClientRect();
            const inset = Math.min(4, rect.width / 4, rect.height / 4);
            const points = [
              [rect.left + rect.width / 2, rect.top + rect.height / 2],
              [rect.left + inset, rect.top + inset],
              [rect.right - inset, rect.top + inset],
              [rect.left + inset, rect.bottom - inset],
              [rect.right - inset, rect.bottom - inset],
            ];
            return {
              points,
              results: points.map(([x, y]) => {
                const target = document.elementFromPoint(x, y);
                return {
                  hit: target?.closest?.('button') === element,
                  target: target?.id || target?.className || target?.tagName || '',
                };
              }),
            };
          };

          for (const [variant, placement] of Object.entries(variants)) {
            tiles.forEach((tile) => { tile.hidden = tile !== codexTile; });
            codexTile.hidden = false;
            codexTile.dataset.layoutVariant = variant;
            codexTile.dataset.layoutWidth = String(placement.width);
            codexTile.dataset.layoutHeight = String(placement.height);
            codexTile.style.gridColumn = '1 / span ' + placement.width;
            codexTile.style.gridRow = '1 / span ' + placement.height;
            await sleepFrame();

            const refresh = codexTile.querySelector('[data-codex-action="refresh"]');
            const refreshGeometry = visibleGeometry(refresh);
            const refreshHitAudit = hitAudit(refresh);
            const primary = codexTile.querySelector('.codex-task-group[data-primary="true"]');
            const primaryTask = primary?.querySelector('.codex-thread');
            const primaryGeometry = primaryTask ? visibleGeometry(primaryTask) : null;
            const primaryVisible = Boolean(primaryGeometry
              && primaryGeometry.rect.width > 0
              && primaryGeometry.rect.height > 0
              && Math.abs(primaryGeometry.visibleWidth - primaryGeometry.rect.width) < 1
              && Math.abs(primaryGeometry.visibleHeight - primaryGeometry.rect.height) < 1);
            const controlAudits = [...codexTile.querySelectorAll('.codex-float button')]
              .filter((control) => {
                const rect = control.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && getComputedStyle(control).visibility === 'visible';
              })
              .map((control) => {
                const geometry = visibleGeometry(control);
                const hits = hitAudit(control).results;
                return {
                  action: control.dataset.codexAction || '',
                  width: geometry.rect.width,
                  height: geometry.rect.height,
                  visibleWidth: geometry.visibleWidth,
                  visibleHeight: geometry.visibleHeight,
                  clippingAncestors: geometry.clippingAncestors,
                  hitResults: hits,
                };
              });
            const [centerPoint] = refreshHitAudit.points;
            const centerTarget = document.elementFromPoint(centerPoint[0], centerPoint[1]);
            centerTarget?.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              clientX: centerPoint[0],
              clientY: centerPoint[1],
            }));
            await sleepFrame();
            results.push({
              variant,
              refreshDisplay: getComputedStyle(refresh).display,
              refreshWidth: refreshGeometry.rect.width,
              refreshHeight: refreshGeometry.rect.height,
              visibleWidth: refreshGeometry.visibleWidth,
              visibleHeight: refreshGeometry.visibleHeight,
              clippingAncestors: refreshGeometry.clippingAncestors,
              hitResults: refreshHitAudit.results,
              controlAudits,
              primaryKey: primary?.dataset.taskGroup || '',
              primaryVisible,
              primaryText: primaryTask?.textContent || '',
              refreshCalls,
            });
          }

          savedTiles.forEach((saved) => {
            saved.tile.hidden = saved.hidden;
            const restore = (name, value) => value === null
              ? saved.tile.removeAttribute(name) : saved.tile.setAttribute(name, value);
            restore('aria-hidden', saved.ariaHidden);
            restore('style', saved.style);
            restore('data-layout-variant', saved.layoutVariant);
            restore('data-layout-column', saved.layoutColumn);
            restore('data-layout-row', saved.layoutRow);
            restore('data-layout-width', saved.layoutWidth);
            restore('data-layout-height', saved.layoutHeight);
          });
          window.notchAPI = originalApi;
          return results;
        })()
      `);
      codexResponsiveAudit.push({ width, height, measurements });
    }

    codexResponsiveAudit.forEach(({ width, height, measurements }) => {
      assert.deepEqual(measurements.map((item) => item.variant), ['mini', 'compact', 'wide', 'tall', 'full']);
      measurements.forEach((item, index) => {
        assert.equal(item.refreshDisplay, 'grid', `${width}×${height} ${item.variant}: 刷新按钮不得被布局隐藏`);
        assert.ok(item.refreshWidth >= 23 && item.refreshHeight >= 23,
          `${width}×${height} ${item.variant}: 刷新按钮必须保留完整点击尺寸`);
        assert.ok(Math.abs(item.visibleWidth - item.refreshWidth) < 1
          && Math.abs(item.visibleHeight - item.refreshHeight) < 1,
        `${width}×${height} ${item.variant}: 刷新按钮被祖先容器裁切：${JSON.stringify(item.clippingAncestors)}`);
        assert.ok(item.hitResults.every((result) => result.hit),
          `${width}×${height} ${item.variant}: 刷新按钮点击区被遮挡：${JSON.stringify(item.hitResults)}`);
        item.controlAudits.forEach((control) => {
          assert.ok(Math.abs(control.visibleWidth - control.width) < 1
            && Math.abs(control.visibleHeight - control.height) < 1,
          `${width}×${height} ${item.variant}: ${control.action} 被祖先容器裁切：${JSON.stringify(control.clippingAncestors)}`);
          assert.ok(control.hitResults.every((result) => result.hit),
            `${width}×${height} ${item.variant}: ${control.action} 点击区被遮挡：${JSON.stringify(control.hitResults)}`);
        });
        assert.ok(item.controlAudits.some((control) => control.action === 'details'),
          `${width}×${height} ${item.variant}: 详情入口必须可见可点`);
        assert.equal(item.primaryKey, 'attention', `${width}×${height} ${item.variant}: 应优先显示需处理任务`);
        assert.equal(item.primaryVisible, true, `${width}×${height} ${item.variant}: 最高优先级状态必须完整可见`);
        assert.match(item.primaryText, /需要授权的项目/);
        assert.equal(item.refreshCalls, index + 1, `${width}×${height} ${item.variant}: 真实点击必须触发一次刷新`);
      });
    });

    await window.webContents.executeJavaScript(`
      window.__measureHomepage = function measureHomepage() {
        const surface = document.getElementById('home-bento').getBoundingClientRect();
        const protectedSelectors = {
          music: ['.codex-head', '.codex-quotas', '.codex-footer'],
          pomodoro: ['.pomodoro-readout', '.pomodoro-toggle', '.pomodoro-reset:not([hidden])'],
          recorder: ['.recorder-head', '.home-transcript:not([hidden])', '.recorder-controls'],
          windows: ['.tile-head', '.computer-summary'],
          mirror: ['.mirror-stage'],
          note: ['.note-toolbar', '.note-body'],
          commands: ['.tile-head', '.command-add', '.command-list'],
        };
        const tiles = [...document.querySelectorAll('#home-bento [data-home-module]')]
          .filter((tile) => !tile.hidden)
          .map((tile) => {
            const rect = tile.getBoundingClientRect();
            const regions = (protectedSelectors[tile.dataset.homeModule] || [])
              .map((selector) => tile.querySelector(selector))
              .filter(Boolean)
              .map((node) => {
                const region = node.getBoundingClientRect();
                return { left: region.left, top: region.top, right: region.right, bottom: region.bottom };
              })
              .filter((region) => region.right > region.left && region.bottom > region.top);
            const outsideControls = [...tile.querySelectorAll('button:not([hidden]), input:not([hidden]), textarea:not([hidden])')]
              .filter((control) => {
                const child = control.getBoundingClientRect();
                return child.width > 0 && child.height > 0 && !(
                  child.left >= rect.left - 1 && child.right <= rect.right + 1
                  && child.top >= rect.top - 1 && child.bottom <= rect.bottom + 1
                );
              })
              .map((control) => {
                const controlRect = control.getBoundingClientRect();
                return {
                  name: control.id || control.className || control.tagName,
                  rect: { left: controlRect.left, top: controlRect.top, right: controlRect.right, bottom: controlRect.bottom },
                };
              });
            return {
              id: tile.dataset.homeModule,
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              controlsInside: outsideControls.length === 0,
              outsideControls,
              variant: tile.dataset.layoutVariant,
              area: Number(tile.dataset.layoutWidth) * Number(tile.dataset.layoutHeight),
              regions,
            };
          });
        return {
          surface: { left: surface.left, top: surface.top, right: surface.right, bottom: surface.bottom },
          tiles,
          sizeControls: [...document.querySelectorAll('#home-bento [data-widget-size-cycle]')].map((control) => ({
            hidden: control.hidden,
            disabled: control.disabled,
            tabIndex: control.tabIndex,
            size: control.dataset.currentSize,
          })),
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          ghostCount: document.querySelectorAll('.home-layout-ghost').length,
          animations: document.getElementById('home-bento').getAnimations().map((animation) => ({
            name: animation.animationName || '',
            playState: animation.playState,
            target: animation.effect?.target?.className || '',
            duration: animation.effect?.getTiming?.().duration,
          })),
        };
      };
      void 0;
    `);

    function assertHomepageMeasurement(measurement, visibleCount) {
      assert.equal(measurement.tiles.length, visibleCount);
      assert.equal(measurement.tiles.reduce((total, tile) => total + tile.area, 0), 48);
      const outside = measurement.tiles.filter((tile) => !tile.controlsInside)
        .map((tile) => `${tile.id}(${tile.variant}): ${JSON.stringify(tile.outsideControls)} tile=${JSON.stringify(tile.rect)}`);
      assert.deepEqual(outside, [], `组件控件必须保持在各自卡片内：${outside.join('; ')}`);
      assert.equal(measurement.reducedMotion, true);
      assert.equal(measurement.ghostCount, 0, '减弱动态效果时不得创建 Auto Layout ghost');
      assert.ok(
        measurement.animations.every((animation) => Number(animation.duration) <= 0.01),
        `减弱动态效果时不得创建有感布局动画：${JSON.stringify(measurement.animations)}`
      );
      measurement.tiles.forEach((tile) => {
        assert.ok(tile.rect.left >= measurement.surface.left - 1, `${tile.id} 越过首页左边界`);
        assert.ok(tile.rect.right <= measurement.surface.right + 1, `${tile.id} 越过首页右边界`);
        assert.ok(tile.rect.top >= measurement.surface.top - 1, `${tile.id} 越过首页上边界`);
        assert.ok(tile.rect.bottom <= measurement.surface.bottom + 1, `${tile.id} 越过首页下边界`);
        assert.ok(['mini', 'compact', 'wide', 'tall', 'full'].includes(tile.variant));
        for (let left = 0; left < tile.regions.length; left += 1) {
          for (let right = left + 1; right < tile.regions.length; right += 1) {
            const a = tile.regions[left];
            const b = tile.regions[right];
            const overlaps = a.left < b.right - 1 && a.right > b.left + 1
              && a.top < b.bottom - 1 && a.bottom > b.top + 1;
            assert.equal(overlaps, false, `${tile.id}(${tile.variant}) 的关键内容区域发生重叠：${JSON.stringify([a, b])}`);
          }
        }
      });
      for (let left = 0; left < measurement.tiles.length; left += 1) {
        for (let right = left + 1; right < measurement.tiles.length; right += 1) {
          const a = measurement.tiles[left].rect;
          const b = measurement.tiles[right].rect;
          const overlaps = a.left < b.right - 1 && a.right > b.left + 1
            && a.top < b.bottom - 1 && a.bottom > b.top + 1;
          assert.equal(overlaps, false, '首页组件矩形不得重叠');
        }
      }
      if (visibleCount < 7) {
        assert.ok(measurement.sizeControls.every((control) => control.hidden && control.disabled && control.tabIndex === -1));
      } else {
        assert.ok(measurement.sizeControls.every((control) => !control.hidden && !control.disabled && control.tabIndex === 0));
      }
    }

    for (const [width, height] of [[1240, 616], [1000, 576]]) {
      window.setSize(width, height);
      const matrix = await window.webContents.executeJavaScript(`
        (async () => {
          const ids = ['music', 'pomodoro', 'recorder', 'windows', 'mirror', 'note', 'commands'];
          ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
          const results = [];
          for (let count = 7; count >= 1; count -= 1) {
            document.getElementById('tab-button-home').click();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            results.push(window.__measureHomepage());
            if (count > 1) {
              document.getElementById('tab-button-settings').click();
              const input = document.querySelector('[data-settings-home-module="' + ids[7 - count] + '"]');
              input.checked = false;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          return results;
        })()
      `);
      matrix.forEach((measurement, index) => assertHomepageMeasurement(measurement, 7 - index));

      const finalWidgetGuard = await window.webContents.executeJavaScript(`
        (async () => {
          document.getElementById('tab-button-settings').click();
          const enabled = [...document.querySelectorAll('[data-settings-home-module]')].find((input) => input.checked);
          enabled.checked = false;
          enabled.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            checked: enabled.checked,
            visibleCount: window.NotchHome.getVisibility().visibleIds.length,
            storedCount: JSON.parse(localStorage.getItem('notch-home-hidden-modules-v1')).length,
            message: document.getElementById('status-toast-message').textContent,
          };
        })()
      `);
      assert.equal(finalWidgetGuard.checked, true);
      assert.equal(finalWidgetGuard.visibleCount, 1);
      assert.equal(finalWidgetGuard.storedCount, 6);
      assert.match(finalWidgetGuard.message, /至少保留一个/);
    }

    const transactionAudit = await window.webContents.executeJavaScript(`
      (() => {
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'mirror', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const first = window.NotchHome.setModuleVisible('mirror', false);
        const second = window.NotchHome.setModuleVisible('note', false);
        const rapidHidden = [...window.NotchHome.getVisibility().hiddenIds];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        window.NotchHome.setModuleVisible('commands', false);
        window.NotchHome.setModuleVisible('commands', true);
        window.NotchHome.setModuleVisible('commands', false);
        let eventCount = 0;
        const onChange = () => { eventCount += 1; };
        document.addEventListener('notch:home-modules-changed', onChange);
        const storageBeforeNoop = localStorage.getItem('notch-home-hidden-modules-v1');
        const noop = window.NotchHome.setModuleVisible('commands', false);
        const noOpStorageStable = storageBeforeNoop === localStorage.getItem('notch-home-hidden-modules-v1');
        document.removeEventListener('notch:home-modules-changed', onChange);
        const beforeRollback = {
          hidden: JSON.stringify(window.NotchHome.getVisibility().hiddenIds),
          stored: localStorage.getItem('notch-home-hidden-modules-v1'),
          visible: [...document.querySelectorAll('[data-home-module]')].filter((tile) => !tile.hidden).map((tile) => tile.dataset.homeModule).join(','),
          styles: [...document.querySelectorAll('[data-home-module]')].map((tile) => tile.getAttribute('style')).join('|'),
        };
        const originalResolver = window.NotchDomain.resolveHomeWidgetLayout;
        window.NotchDomain.resolveHomeWidgetLayout = () => null;
        const rollback = window.NotchHome.setModuleVisible('music', false);
        window.NotchDomain.resolveHomeWidgetLayout = originalResolver;
        const afterRollback = {
          hidden: JSON.stringify(window.NotchHome.getVisibility().hiddenIds),
          stored: localStorage.getItem('notch-home-hidden-modules-v1'),
          visible: [...document.querySelectorAll('[data-home-module]')].filter((tile) => !tile.hidden).map((tile) => tile.dataset.homeModule).join(','),
          styles: [...document.querySelectorAll('[data-home-module]')].map((tile) => tile.getAttribute('style')).join('|'),
        };
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const originalWorkspace = window.NotchWorkspace;
        window.NotchWorkspace = { ...originalWorkspace, isRecordingActive: () => true };
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: true } }));
        const recordingGuard = window.NotchHome.setModuleVisible('recorder', false);
        window.NotchWorkspace = originalWorkspace;
        const durations = [];
        for (let index = 0; index < 100; index += 1) {
          const start = performance.now();
          window.NotchHome.setModuleVisible('note', index % 2 === 0 ? false : true);
          durations.push(performance.now() - start);
        }
        durations.sort((a, b) => a - b);
        return {
          first, second, rapidHidden, noop, eventCount,
          noOpStorageStable,
          rollback, rollbackStable: JSON.stringify(beforeRollback) === JSON.stringify(afterRollback),
          recordingGuard,
          p95: durations[Math.floor(durations.length * .95)],
          maximum: durations[durations.length - 1],
          animationCount: document.getElementById('home-bento').getAnimations().length,
        };
      })()
    `);
    assert.equal(transactionAudit.first.ok, true);
    assert.equal(transactionAudit.second.ok, true);
    assert.deepEqual(transactionAudit.rapidHidden, ['mirror', 'note']);
    assert.equal(transactionAudit.noop.changed, false);
    assert.equal(transactionAudit.eventCount, 0);
    assert.equal(transactionAudit.noOpStorageStable, true);
    assert.equal(transactionAudit.rollback.error, 'layout_invalid');
    assert.equal(transactionAudit.rollbackStable, true);
    assert.equal(transactionAudit.recordingGuard.error, 'recording_active');
    assert.ok(transactionAudit.p95 < 16, `显隐事务 p95 ${transactionAudit.p95.toFixed(2)}ms 超过 16ms`);
    assert.ok(transactionAudit.maximum < 50, `显隐事务最长 ${transactionAudit.maximum.toFixed(2)}ms 超过 50ms`);
    assert.ok(transactionAudit.animationCount <= 1);

    const persistenceAndRecorderAudit = await window.webContents.executeJavaScript(`
      (() => {
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'mirror', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const originalSetItem = Storage.prototype.setItem;
        const storedBefore = localStorage.getItem('notch-home-hidden-modules-v1');
        Storage.prototype.setItem = function setItem(key, value) {
          if (key === 'notch-home-hidden-modules-v1') throw new Error('simulated quota failure');
          return originalSetItem.call(this, key, value);
        };
        const degraded = window.NotchHome.setModuleVisible('mirror', false);
        const degradedState = window.NotchHome.getVisibility();
        const degradedStatus = document.getElementById('settings-home-module-status').textContent;
        const degradedStorageStable = storedBefore === localStorage.getItem('notch-home-hidden-modules-v1');
        ['music', 'pomodoro', 'recorder', 'windows', 'note'].forEach((id) => {
          window.NotchHome.setModuleVisible(id, false);
        });
        const rejectedWhileDirty = window.NotchHome.setModuleVisible('commands', false);
        Storage.prototype.setItem = originalSetItem;
        const recovered = window.NotchHome.setModuleVisible('music', true);
        const recoveredState = window.NotchHome.getVisibility();
        const recoveredStored = JSON.parse(localStorage.getItem('notch-home-hidden-modules-v1'));

        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        const recorderHidden = window.NotchHome.setModuleVisible('recorder', false);
        const originalWorkspace = window.NotchWorkspace;
        window.NotchWorkspace = { ...originalWorkspace, isRecordingActive: () => true };
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: true } }));
        const recorderSwitch = document.querySelector('[data-settings-home-module="recorder"]');
        const hiddenSwitchEnabled = !recorderSwitch.disabled && !recorderSwitch.checked;
        const recorderRestored = window.NotchHome.setModuleVisible('recorder', true);
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: true } }));
        const visibleSwitchLocked = recorderSwitch.disabled && recorderSwitch.checked;
        const recordingsActionAvailable = !document.getElementById('recording-new').disabled;
        window.NotchWorkspace = originalWorkspace;
        document.dispatchEvent(new CustomEvent('notch:recording-state-changed', { detail: { active: false } }));

        const noteInput = document.getElementById('home-note');
        noteInput.focus();
        const noteTile = noteInput.closest('[data-home-module]');
        window.NotchHome.setModuleVisible('note', false);
        const focusReleased = !noteTile.contains(document.activeElement)
          && noteTile.hidden
          && noteTile.querySelector('[data-widget-size-cycle]').tabIndex === -1;
        window.NotchHome.setModuleVisible('note', true);
        return {
          degraded,
          degradedPersisted: degradedState.persisted,
          degradedStorageStable,
          degradedStatus,
          rejectedWhileDirty,
          recovered,
          recoveredPersisted: recoveredState.persisted,
          recoveredStored,
          recorderHidden,
          hiddenSwitchEnabled,
          recorderRestored,
          visibleSwitchLocked,
          recordingsActionAvailable,
          focusReleased,
        };
      })()
    `);
    assert.equal(persistenceAndRecorderAudit.degraded.ok, true);
    assert.equal(persistenceAndRecorderAudit.degraded.persisted, false);
    assert.equal(persistenceAndRecorderAudit.degradedPersisted, false);
    assert.equal(persistenceAndRecorderAudit.degradedStorageStable, true);
    assert.match(persistenceAndRecorderAudit.degradedStatus, /仅当前会话/);
    assert.equal(persistenceAndRecorderAudit.rejectedWhileDirty.ok, false);
    assert.equal(persistenceAndRecorderAudit.rejectedWhileDirty.persisted, false);
    assert.equal(persistenceAndRecorderAudit.recovered.ok, true);
    assert.equal(persistenceAndRecorderAudit.recovered.persisted, true);
    assert.equal(persistenceAndRecorderAudit.recoveredPersisted, true);
    assert.ok(Array.isArray(persistenceAndRecorderAudit.recoveredStored));
    assert.equal(persistenceAndRecorderAudit.recorderHidden.ok, true);
    assert.equal(persistenceAndRecorderAudit.hiddenSwitchEnabled, true);
    assert.equal(persistenceAndRecorderAudit.recorderRestored.ok, true);
    assert.equal(persistenceAndRecorderAudit.visibleSwitchLocked, true);
    assert.equal(persistenceAndRecorderAudit.recordingsActionAvailable, true);
    assert.equal(persistenceAndRecorderAudit.focusReleased, true);

    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    const panelMotionAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const appSurface = document.getElementById('app');
        appSurface.classList.remove('expanded', 'opening', 'closing');
        appSurface.classList.add('collapsed');
        const waitForClass = async (name) => {
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            if (appSurface.classList.contains(name)) return true;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return false;
        };
        document.getElementById('notch').click();
        const opened = await waitForClass('expanded');
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const tileEntranceAnimations = [...document.querySelectorAll('#home-bento [data-home-module]')]
          .flatMap((tile) => tile.getAnimations())
          .filter((animation) => animation.animationName === 'bento-masonry-in').length;
        const contentLayerHasScale = [
          document.querySelector('.panel > .topbar'),
          document.querySelector('.panel > .panels'),
        ].filter(Boolean).some((layer) => layer.getAnimations().some((animation) => (
          animation.effect?.getKeyframes?.().some((frame) => {
            if (!frame.transform || frame.transform === 'none') return false;
            const matrix = new DOMMatrixReadOnly(frame.transform);
            const scaleX = Math.hypot(matrix.a, matrix.b);
            const scaleY = Math.hypot(matrix.c, matrix.d);
            return Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001;
          })
        )));
        const masonryReveal = document.getElementById('home-bento').classList.contains('masonry-reveal');
        document.getElementById('notch').click();
        const collapsed = await waitForClass('collapsed');
        return { opened, collapsed, tileEntranceAnimations, contentLayerHasScale, masonryReveal };
      })()
    `);
    assert.equal(panelMotionAudit.opened, true);
    assert.equal(panelMotionAudit.collapsed, true);
    assert.equal(panelMotionAudit.tileEntranceAnimations, 0, '展开时不得再同时启动七张卡片的错峰缩放入场');
    assert.equal(panelMotionAudit.masonryReveal, false, '首页卡片不应在每次展开时重播入场');
    assert.equal(panelMotionAudit.contentLayerHasScale, false, '展开/收起不应缩放整个大面积内容层');

    const lifecycleAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'mirror', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        document.getElementById('tab-button-home').click();
        document.getElementById('app').classList.remove('collapsed', 'closing', 'opening');
        document.getElementById('app').classList.add('expanded');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        let windowScans = 0;
        let codexReads = 0;
        window.notchAPI = {
          getCodexFloatStatus: async () => { codexReads += 1; return { providerId: 'codex', connection: 'connected', windows: [], threads: [] }; },
          getComputerStatus: async () => { windowScans += 1; return { updatedAt: Date.now(), cpu: {percent: 21}, memory: {percent: 60} }; },
        };
        await new Promise((resolve) => setTimeout(resolve, 30));
        windowScans = 0;
        window.NotchHome.setModuleVisible('windows', false);
        await window.ComputerStatusView.refresh(true);
        await window.ComputerStatusView.refresh(true);
        const scansWhileHidden = windowScans;
        window.NotchHome.setModuleVisible('windows', true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const scansAfterRestore = windowScans;

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.NotchHome.setModuleVisible('music', false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const codexHidden = document.getElementById('home-codex-card').dataset.active === 'false';
        codexReads = 0;
        document.getElementById('home-codex-card').querySelector('[data-codex-action="refresh"]').click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const codexReadsWhileHidden = codexReads;
        window.NotchHome.setModuleVisible('music', true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const codexRestored = document.getElementById('home-codex-card').dataset.active === 'true';
        const codexReadsAfterRestore = codexReads;

        const minutes = document.getElementById('pomodoro-minutes');
        const seconds = document.getElementById('pomodoro-seconds');
        minutes.value = '00';
        seconds.value = '10';
        seconds.dispatchEvent(new Event('blur'));
        document.getElementById('pomodoro-toggle').click();
        const before = Number(minutes.value) * 60 + Number(seconds.value);
        window.NotchHome.setModuleVisible('pomodoro', false);
        await new Promise((resolve) => setTimeout(resolve, 1150));
        const whileHidden = Number(minutes.value) * 60 + Number(seconds.value);
        window.NotchHome.setModuleVisible('pomodoro', true);
        const after = Number(minutes.value) * 60 + Number(seconds.value);
        document.getElementById('pomodoro-reset').click();
        return {
          scansWhileHidden,
          scansAfterRestore,
          codexHidden,
          codexReadsWhileHidden,
          codexRestored,
          codexReadsAfterRestore,
          before,
          whileHidden,
          after,
        };
      })()
    `);
    assert.equal(lifecycleAudit.scansWhileHidden, 0);
    assert.equal(lifecycleAudit.scansAfterRestore, 1);
    assert.equal(lifecycleAudit.codexHidden, true);
    assert.equal(lifecycleAudit.codexReadsWhileHidden, 0);
    assert.equal(lifecycleAudit.codexRestored, true);
    assert.equal(lifecycleAudit.codexReadsAfterRestore, 1);
    assert.ok(lifecycleAudit.whileHidden < lifecycleAudit.before, '番茄钟隐藏后应继续计时');
    assert.equal(lifecycleAudit.after, lifecycleAudit.whileHidden);

    const idlePerformanceAudit = await window.webContents.executeJavaScript(`
      (async () => {
        const appSurface = document.getElementById('app');
        const codex = document.getElementById('home-codex-card');
        document.getElementById('tab-button-home').click();
        appSurface.classList.remove('collapsed');
        appSurface.classList.add('expanded');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const stoppedWhileExpandedIdle = codex.getAnimations({ subtree: true }).filter((item) => item.playState === 'running').length === 0;
        const hasInfinitePanelEffect = document.getElementById('panel').getAnimations({ subtree: true })
          .some((animation) => animation.animationName === 'bento-border-breathe'
            && animation.effect?.getTiming?.().iterations === Infinity);
        const panelBackdropFilter = getComputedStyle(document.getElementById('panel'), '::before').backdropFilter;
        const foregroundFilter = getComputedStyle(codex).filter;
        const glassAppearance = document.documentElement.dataset.appearance === 'system-glass-blurred';
        appSurface.classList.remove('expanded');
        appSurface.classList.add('collapsed');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: false } }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const stoppedWhileCollapsed = codex.dataset.active === 'false' && !document.querySelector('#home-codex canvas');
        appSurface.classList.remove('collapsed');
        appSurface.classList.add('expanded');
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        return {
          stoppedWhileExpandedIdle,
          stoppedWhileCollapsed,
          hasInfinitePanelEffect,
          panelBackdropFilter,
          foregroundFilter,
          glassAppearance,
        };
      })()
    `);
    assert.equal(idlePerformanceAudit.stoppedWhileExpandedIdle, true, '首页静置时 Codex 卡片不得空转动画');
    assert.equal(idlePerformanceAudit.stoppedWhileCollapsed, true, '收起后 Codex 卡片必须停用，且已移除音乐 WebGL');
    assert.equal(idlePerformanceAudit.hasInfinitePanelEffect, false, '展开后不得运行大面积无限边框滤镜动画');
    // Glass uses a background-only CSS fallback when the native material is not
    // available in this fixture. The old opaque-panel assumption no longer holds.
    if (!idlePerformanceAudit.glassAppearance) assert.equal(idlePerformanceAudit.panelBackdropFilter, 'none');
    else assert.match(idlePerformanceAudit.panelBackdropFilter, /^(none|blur\([\d.]+px\))$/);
    assert.equal(idlePerformanceAudit.foregroundFilter, 'none', '玻璃模糊不得应用到前景文字');

    const autoLayoutMotionAudit = await window.webContents.executeJavaScript(`
      (async () => {
        // Earlier lifecycle fixtures only toggle classes. Restore the real open
        // state (including aria-hidden/inert) before checking visible geometry.
        window.notchAPI.setMode = async (mode) => ({ ok: true, mode });
        collapseImmediately();
        await setMode(true);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const ids = ['music', 'pomodoro', 'recorder', 'windows', 'mirror', 'note', 'commands'];
        ids.forEach((id) => window.NotchHome.setModuleVisible(id, true));
        document.getElementById('tab-button-home').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await window.cardReflow.whenIdle();
        const sizeButton = document.querySelector('[data-widget-size-cycle="music"]');
        const beforeSize = sizeButton.dataset.currentSize;
        sizeButton.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const ghosts = [...document.querySelectorAll('.home-layout-ghost')];
        const tileAnimations = [...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .flatMap((tile) => tile.getAnimations());
        const tileDurations = tileAnimations
          .map((animation) => {
            const timing = animation.effect?.getTiming?.() || {};
            return (Number(timing.duration) || 0) + (Number(timing.delay) || 0);
          })
          .filter((duration) => duration > 0);
        const animatedOpacities = tileAnimations.flatMap((animation) => (
          animation.effect?.getKeyframes?.().map((frame) => Number(frame.opacity)).filter(Number.isFinite) || []
        ));
        const minimumTileOpacity = animatedOpacities.length ? Math.min(...animatedOpacities) : 1;
        const realTileHasScale = [...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .some((tile) => tile.getAnimations().some((animation) => (
            animation.effect?.getKeyframes?.().some((frame) => /scale/.test(String(frame.transform || '')))
          )));
        const realTileChangesSize = tileAnimations.some((animation) => {
          const frames = animation.effect?.getKeyframes?.() || [];
          return frames.length > 1 && ['width', 'height'].some((property) => (
            frames[0][property] != null && frames[0][property] !== frames.at(-1)[property]
          ));
        });
        const during = {
          beforeSize,
          afterSize: sizeButton.dataset.currentSize,
          ghostCount: ghosts.length,
          tileDurations,
          minimumTileOpacity,
          realTileHasScale,
          realTileChangesSize,
        };
        await new Promise((resolve) => setTimeout(resolve, 700));
        const ghostsAfter = document.querySelectorAll('.home-layout-ghost').length;
        const tileAnimationsAfter = [...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .reduce((count, tile) => count + tile.getAnimations().length, 0);
        sizeButton.click();
        sizeButton.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const rapidGhostIds = [...document.querySelectorAll('.home-layout-ghost')]
          .map((ghost) => ghost.dataset.homeLayoutGhost);
        const rapidDuplicateGhosts = new Set(rapidGhostIds).size !== rapidGhostIds.length;
        const rapidMaxTileAnimations = Math.max(...[...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')]
          .map((tile) => tile.getAnimations().length));
        await new Promise((resolve) => setTimeout(resolve, 700));
        return {
          ...during,
          ghostsAfter,
          tileAnimationsAfter,
          rapidDuplicateGhosts,
          rapidMaxTileAnimations,
          rapidGhostsAfter: document.querySelectorAll('.home-layout-ghost').length,
        };
      })()
    `);
    assert.notEqual(autoLayoutMotionAudit.afterSize, autoLayoutMotionAudit.beforeSize);
    assert.equal(autoLayoutMotionAudit.ghostCount, 0, '尺寸切换不得用空外壳遮成黑块');
    assert.ok(
      autoLayoutMotionAudit.tileDurations.length > 0
        && autoLayoutMotionAudit.tileDurations.every((duration) => duration >= 440 && duration <= 480),
      '卡片尺寸切换与页面重排应在约 460ms 内完成: ' + JSON.stringify(autoLayoutMotionAudit)
    );
    assert.ok(autoLayoutMotionAudit.minimumTileOpacity >= 0.72, '重排期间真实卡片不得熄灭成黑块');
    assert.equal(autoLayoutMotionAudit.realTileHasScale, false, '尺寸重排不得缩放文字与控件');
    assert.equal(autoLayoutMotionAudit.realTileChangesSize, true, '真实卡片的尺寸必须连续过渡');
    assert.equal(autoLayoutMotionAudit.ghostsAfter, 0, 'Auto Layout ghost 必须在动画后清理');
    assert.equal(autoLayoutMotionAudit.tileAnimationsAfter, 0, '重排动画结束后不得残留组件动画');
    assert.equal(autoLayoutMotionAudit.rapidDuplicateGhosts, false, '连续切换必须先清理上一轮 Auto Layout ghost');
    assert.ok(autoLayoutMotionAudit.rapidMaxTileAnimations <= 1, '连续切换不得叠加多轮组件动画');
    assert.equal(autoLayoutMotionAudit.rapidGhostsAfter, 0, '连续切换结束后不得残留 Auto Layout ghost');

    const codexInteraction = await window.webContents.executeJavaScript(`
      (async () => {
        const originalApi = window.notchAPI;
        const actions = [];
        const snapshot = { providerId: 'codex', connection: 'connected', updatedAt: Date.now(),
          windows: [{ id: 'primary', label: '5 小时', usedPercent: 32, resetsAt: Date.now() + 3600000 }],
          resets: { available: null },
          threads: [{ id: 'task-id', title: '<img src=x onerror=alert(1)>', status: 'running' }],
        };
        let finish;
        window.notchAPI = {
          ...originalApi,
          getCodexFloatStatus: async () => snapshot,
          refreshCodexFloat: () => { actions.push('refresh'); return new Promise((resolve) => { finish = resolve; }); },
          openCodexApp: async () => { actions.push('open'); return { ok: true }; },
          openCodexThread: async (id) => { actions.push(id); return { ok: true }; },
        };
        const card = document.getElementById('home-codex-card');
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: false } }));
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: true } }));
        await tick();
        card.querySelector('[data-codex-action="details"]').click();
        document.querySelector('.codex-dialog [data-codex-action="open"]').click();
        await tick();
        document.querySelector('.codex-dialog [data-codex-action="close"]').click();
        card.querySelector('[data-codex-action="thread"]').click();
        await tick();
        const refresh = card.querySelector('[data-codex-action="refresh"]');
        refresh.click(); refresh.click();
        const busy = card.getAttribute('aria-busy') === 'true' && refresh.disabled;
        finish(snapshot);
        await tick();
        card.querySelector('[data-codex-action="details"]').click();
        const dialog = document.querySelector('.codex-dialog');
        const opened = dialog.open;
        const safe = card.querySelectorAll('img').length === 0 && dialog.querySelectorAll('img').length === 0;
        const value = card.querySelector('[role="meter"]').getAttribute('aria-valuenow');
        const unknownResets = card.querySelector('.codex-reset-summary').textContent;
        const countdown = card.querySelector('.codex-countdown').textContent;
        document.dispatchEvent(new CustomEvent('notch:modechange', { detail: { expanded: false } }));
        const closedOnHide = !dialog.open;
        window.notchAPI = originalApi;
        return { actions, busy, opened, safe, value, unknownResets, countdown, closedOnHide };
      })()
    `);
    assert.deepEqual(codexInteraction.actions, ['open', 'task-id', 'refresh'], '打开应用、跳转任务、手动刷新分别调用对应桥接，不消耗 Reset');
    assert.equal(codexInteraction.busy, true, '刷新期间必须防止重复提交');
    assert.equal(codexInteraction.opened, true);
    assert.equal(codexInteraction.safe, true, '本机任务标题必须按文本呈现');
    assert.equal(codexInteraction.value, '68');
    assert.equal(codexInteraction.unknownResets, 'Reset · 未知');
    assert.match(codexInteraction.countdown, /后重置/);
    assert.equal(codexInteraction.closedOnHide, true, '收起工作台必须关闭详情');

    const computerFeedback = await window.webContents.executeJavaScript(`
      (async () => {
        let forbidden = 0;
        const originalApi = window.notchAPI;
        let response = { ok: false, error: 'status_unavailable' };
        window.notchAPI = { ...originalApi,
          getComputerStatus: async () => response,
          listWindows: async () => { forbidden++; return {items: []}; },
          openPrivacySettings: async () => { forbidden++; },
        };
        document.getElementById('app').classList.remove('collapsed', 'closing', 'opening');
        document.getElementById('app').classList.add('expanded');
        document.dispatchEvent(new CustomEvent('notch:modechange', {detail: {expanded: true}}));
        document.getElementById('tab-button-recordings').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        await window.ComputerStatusView.refresh();
        const failed = document.getElementById('computer-status-view').textContent;
        response = { updatedAt: Date.now(), cpu: {percent: 26.5}, memory: {total: 1000, used: 600, available: 400, percent: 60}, disk: {total: 2000, used: 400, available: 1600, percent: 20}, network: {connected: true, downloadBytesPerSecond: 1024, uploadBytesPerSecond: 2048}, battery: {present: true, percent: 83, charging: false, onBattery: true}, uptimeSeconds: 3661, platform: 'darwin', model: 'Apple Test'};
        await window.ComputerStatusView.refresh();
        const actual = [...document.querySelectorAll('#computer-status-view [data-computer-value]')].map(el => el.textContent).join(' ');
        document.getElementById('computer-open-recordings').click();
        const library = !document.getElementById('recording-library-view').hidden;
        document.getElementById('computer-back-status').click();
        const statusRestored = !document.getElementById('computer-status-view').hidden;
        window.notchAPI = originalApi;
        return {failed, actual, forbidden, library, statusRestored};
      })()
    `);
    assert.doesNotMatch(computerFeedback.failed, /屏幕录制.*权限|辅助功能.*权限/);
    assert.match(computerFeedback.actual, /27%/);
    assert.match(computerFeedback.actual, /83%/);
    assert.match(computerFeedback.actual, /1.0 KB/);
    assert.equal(computerFeedback.forbidden, 0, '电脑状态不应访问其他窗口或请求录屏权限');
    assert.equal(computerFeedback.library, true, '原录音资料必须仍可访问');
    assert.equal(computerFeedback.statusRestored, true);

  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
  }
}

main().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
