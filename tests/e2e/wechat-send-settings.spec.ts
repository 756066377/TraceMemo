import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { launchTestApp } from './support/electron'

for (const theme of ['light', 'dark'] as const) {
  test(`WECHAT-UI ${theme} responsive settings and connection lifecycle`, async () => {
    test.skip(process.platform !== 'win32', 'Windows 端口设置仅在 Windows 显示')
    const fixture = await launchTestApp({ appearanceTheme: theme })
    const { page, app } = fixture
    try {
      // Isolated Electron fixture: no real service scanning, file changes, or injection.
      await app.evaluate(({ ipcMain }) => {
        for (const channel of [
          'wechat-hook:getStatus',
          'wechat-hook:start',
          'wechat-personal:checkStatus',
          'wechat-personal:scanEndpoint'
        ]) {
          ipcMain.removeHandler(channel)
        }
        ipcMain.handle('wechat-hook:getStatus', () => ({
          platform: 'win32',
          wechat: {
            detected: true,
            version: '4.1.15.56',
            running: false,
            installDir: 'C:\\Program Files\\Tencent\\Weixin'
          },
          installed: false,
          dll: {
            path: 'C:\\TraceMemo\\resources\\wechat-hook\\version-4.1.15.56.dll',
            source: 'bundled',
            machine: 'x64',
            size: 457216,
            sha256: 'fixture',
            wechatVersions: ['4.1.15.56']
          },
          installedMatchesComponent: false,
          backupExists: false,
          supportedVersions: ['4.1.15.56'],
          versionSupported: true,
          canInject: false,
          reasons: []
        }))
        ipcMain.handle('wechat-hook:start', () => ({
          success: true,
          port: '30001',
          loggedIn: false,
          steps: ['接口已连接，请在微信中登录']
        }))
        ipcMain.handle('wechat-personal:checkStatus', () => ({
          state: 'online',
          platform: 'win32',
          endpointReady: true,
          canSend: true,
          canSendText: true,
          canSendImage: false,
          canSendVoice: false,
          message: '本机发送服务已连接'
        }))
        ipcMain.handle('wechat-personal:scanEndpoint', () => ({
          success: true,
          scanned: 12,
          candidates: [{ port: '30001', matched: true, protocolLabel: 'TraceMemo Hook' }],
          bestPort: '30001'
        }))
      })
      await page
        .getByRole('navigation', { name: '一级导航' })
        .getByRole('button', { name: '设置', exact: true })
        .click()
      await page
        .locator('.settings-sidebar')
        .getByRole('button', { name: '微信发送', exact: true })
        .click()
      const panel = page.locator('.personal-wechat-send-page')
      await expect(panel.getByText('当前微信版本匹配', { exact: true })).toBeVisible()
      const content = panel.locator('.settings-page-content')
      for (const [width, height] of [
        [960, 640],
        [1280, 720],
        [1440, 900],
        [1920, 1080]
      ]) {
        await page.setViewportSize({ width, height })
        await panel.locator('.settings-page-scroll').evaluate((element) => {
          element.scrollTop = 0
        })
        expect(
          await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
        ).toBe(true)
        const connection = panel.getByRole('group', { name: '端口与连接', exact: true })
        const capabilities = panel.getByRole('group', { name: '可用能力', exact: true })
        const connectionBox = await connection.boundingBox()
        const capabilityBox = await capabilities.boundingBox()
        expect(connectionBox).not.toBeNull()
        expect(capabilityBox).not.toBeNull()
        if (width >= 1440) {
          expect(capabilityBox!.x).toBeGreaterThan(connectionBox!.x + connectionBox!.width)
        } else if (width === 960) {
          expect(capabilityBox!.y).toBeGreaterThan(connectionBox!.y + connectionBox!.height)
        }
        await page.screenshot({
          path: `output/wechat-hook-validation/wechat-send-${theme}-${width}.png`
        })
      }
      await panel
        .getByRole('heading', { name: 'Hook 组件', exact: true })
        .evaluate((element) => element.scrollIntoView({ block: 'start' }))
      await page.screenshot({
        path: `output/wechat-hook-validation/wechat-send-${theme}-component.png`
      })
      await page.setViewportSize({ width: 960, height: 640 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await panel.getByRole('button', { name: '启动微信并连接', exact: true }).click()
      await expect(panel.getByText('接口已连接，请在微信中登录', { exact: true })).toBeVisible()
      await expect(panel.getByLabel('微信发送能力端口')).toHaveValue('30001')
      await panel.getByRole('button', { name: '扫描本机端口', exact: true }).click()
      await expect(panel.getByLabel('微信发送能力端口')).toHaveValue('30001')
      await expect(panel.locator('.wechat-send-header-actions')).toContainText('待保存')
      await panel.getByRole('button', { name: '保存', exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.api.getSettings()).settings.windowsWechatPort)
        )
        .toBe('30001')
      await expect(panel.locator('.wechat-send-header-actions')).toContainText('已就绪')
      await panel.getByRole('button', { name: '清除端口', exact: true }).click()
      await expect(panel.getByLabel('微信发送能力端口')).toHaveValue('')
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.api.getSettings()).settings.windowsWechatPort)
        )
        .toBe('')
      await app.evaluate(({ ipcMain }) => {
        const status = {
          state: 'hook_not_ready',
          platform: 'win32',
          endpointReady: true,
          canSend: false,
          canSendText: false,
          canSendImage: false,
          canSendVoice: false,
          message: '已连接微信发送接口，组件尚未确认登录',
          error: '端口连接正常，但组件返回 IsLogin=0'
        }
        for (const channel of ['wechat-personal:checkStatus', 'wechat-personal:getStatus']) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, () => status)
        }
      })
      await panel.getByLabel('微信发送能力端口').fill('30001')
      await panel.getByRole('button', { name: '检测', exact: true }).click()
      await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
      await panel.getByRole('button', { name: '保存', exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.api.getSettings()).settings.windowsWechatPort)
        )
        .toBe('30001')
      await expect(panel.locator('.wechat-send-header-actions')).toContainText('登录未确认')
      await expect(panel.locator('.wechat-send-header-actions')).not.toContainText('已就绪')
      await page.screenshot({
        path: `output/wechat-hook-validation/wechat-send-${theme}-login-unconfirmed.png`
      })
      await app.evaluate(({ ipcMain }) => {
        const status = {
          state: 'hook_not_ready',
          platform: 'win32',
          endpointReady: true,
          canSend: false,
          canSendText: false,
          canSendImage: false,
          canSendVoice: false,
          loginState: 'logged_out',
          message: '已连接微信发送接口，微信尚未登录'
        }
        for (const channel of ['wechat-personal:checkStatus', 'wechat-personal:getStatus']) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, () => status)
        }
      })
      await panel.getByRole('button', { name: '刷新状态', exact: true }).click()
      await expect(panel.locator('.wechat-send-header-actions')).toContainText('微信未登录')
      await app.evaluate(({ ipcMain }) => {
        const status = {
          state: 'hook_not_ready',
          platform: 'win32',
          endpointReady: true,
          canSend: false,
          canSendText: false,
          canSendImage: false,
          canSendVoice: false,
          loginState: 'logged_in',
          message: '微信已登录 · 发送已暂停',
          error: '微信原生发送回调可能导致崩溃，已暂停发送'
        }
        for (const channel of ['wechat-personal:checkStatus', 'wechat-personal:getStatus']) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, () => status)
        }
      })
      // Login recovery must not enable a sender quarantined after a native crash.
      await expect(panel.locator('.wechat-send-header-actions')).toContainText('发送已暂停', {
        timeout: 6000
      })
      await expect(panel.locator('.wechat-send-header-actions')).not.toContainText('已就绪')
      const summary = panel.locator('.wechat-send-details > summary')
      await summary.focus()
      await page.keyboard.press('Enter')
      await expect(panel.locator('.wechat-send-details')).toHaveAttribute('open', '')
      await expect(summary).toBeFocused()
      const summaryBox = await summary.boundingBox()
      expect(summaryBox!.y).toBeGreaterThanOrEqual(0)
      expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(640)
      await page.screenshot({
        path: `output/wechat-hook-validation/wechat-send-${theme}-details.png`
      })
      const accessibility = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .include('.personal-wechat-send-page')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
      expect(accessibility.violations).toEqual([])
    } finally {
      await fixture.close()
    }
  })
}
