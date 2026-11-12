import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'
import AxeBuilder from '@axe-core/playwright'
import { writeFileSync } from 'node:fs'

const workspaces = [
  '狗头军师',
  '问问微信',
  '日报',
  '退群监控',
  '自动化',
  'Agent',
  '导出',
  'API',
  '设置'
]
const settings = [
  '账号与数据库',
  '数据库密钥',
  '图片解密',
  '微信发送',
  '发送日志',
  '语音转文字',
  '文字转语音',
  'AI 模型',
  '本地索引',
  '缓存与清理',
  '外观与行为',
  '高级',
  '关于'
]

for (const theme of ['light', 'dark'] as const) {
  test(`NIGHT-01 ${theme} workspaces, desktop widths and secondary panels`, async () => {
    test.setTimeout(180_000)
    const fixture = await launchTestApp({ appearanceTheme: theme })
    const { page } = fixture
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      const nav = page.getByRole('navigation', { name: '一级导航' })
      await expect(nav).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      for (const [width, height] of [
        [960, 640],
        [1280, 720],
        [1440, 900],
        [1920, 1080]
      ]) {
        await page.setViewportSize({ width, height })
        for (const label of workspaces) {
          await nav.getByRole('button', { name: label, exact: true }).click()
          await expect(nav.getByRole('button', { name: label, exact: true })).toHaveClass(/active/)
          await expect(page.locator('.tm-workspace-surface')).toBeVisible()
          const overflow = await page.evaluate(() =>
            [...document.querySelectorAll('.app-shell, .tm-workspace-surface')].some(
              (element) => element.scrollWidth > element.clientWidth + 1
            )
          )
          expect(overflow, `${label} at ${width}px`).toBe(false)
          if (width === 960) {
            const title =
              label === '问问微信'
                ? '证据与来源'
                : label === '导出'
                  ? '导出预览'
                  : label === '日报'
                    ? '报告信息'
                    : null
            if (title) {
              const trigger = page.getByRole('button', { name: title, exact: true })
              await trigger.click()
              const dialog = page.getByRole('dialog', { name: title })
              await expect(dialog).toBeVisible()
              await expect(dialog).toHaveCSS('opacity', '1')
              await page.keyboard.press('Escape')
              await expect(trigger).toBeFocused()
            }
          }
          if (width === 960 || width === 1440) {
            await page.screenshot({
              path: `test-results/nightflight-${theme}-${width}-${workspaces.indexOf(label)}.png`
            })
          }
        }
        await page.screenshot({ path: `test-results/nightflight-${theme}-${width}.png` })
      }
      for (const label of settings) {
        await page
          .locator('.settings-sidebar')
          .getByRole('button', { name: label, exact: true })
          .click()
        await expect(page.locator('.settings-page-panel.active')).toBeVisible()
      }
      await page
        .locator('.settings-sidebar')
        .getByRole('button', { name: '外观与行为', exact: true })
        .click()
      await page.getByRole('switch', { name: '紧凑布局' }).click()
      await expect(page.locator('.app-shell')).toHaveClass(/is-compact/)
      await page.setViewportSize({ width: 960, height: 640 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(
        await page
          .locator('.dui-btn')
          .first()
          .evaluate((element) => getComputedStyle(element).transitionDuration)
      ).toBe('0s')
      await page.getByRole('radio', { name: /跟随系统/ }).click()
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.emulateMedia({ colorScheme: 'light' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      expect(errors).toEqual([])
    } finally {
      await fixture.close()
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`NIGHT-03 ${theme} rasterized glass contrast and compact citation`, async () => {
    const fixture = await launchTestApp({ appearanceTheme: theme })
    const { page, app } = fixture
    try {
      await expect(page.locator('.tm-workspace-surface')).toBeVisible()
      const colors = await page.evaluate(() => {
        // Place empty swatches over the actual app background; capture includes gradients and blur.
        const host = document.createElement('div')
        host.id = 'contrast-probes'
        host.style.cssText =
          'position:fixed;left:400px;top:180px;z-index:9999;display:flex;gap:16px'
        document.body.append(host)
        return ['default', 'emphasis', 'floating'].map((tone) => {
          const panel = document.createElement('div')
          panel.className = `tm-glass-panel tm-glass-${tone}`
          panel.style.cssText = 'width:80px;height:80px'
          host.append(panel)
          const read = (variable: string): number[] => {
            const probe = document.createElement('span')
            probe.style.color = `var(${variable})`
            panel.append(probe)
            const channels = getComputedStyle(probe)
              .color.match(/[\d.]+/g)!
              .map(Number)
              .slice(0, 3)
            probe.remove()
            return channels
          }
          return {
            tone,
            foreground: read('--color-base-content'),
            muted: read('--tm-muted-text'),
            focus: read('--color-primary'),
            border: read('--tm-control-border')
          }
        })
      })
      const measurements: unknown[] = []
      const luminance = (rgb: number[]): number =>
        rgb
          .map((channel) => {
            const value = channel / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          })
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      for (const color of colors) {
        const panel = page.locator(`#contrast-probes .tm-glass-${color.tone}`)
        const box = (await panel.boundingBox())!
        const pixel = await page.screenshot({
          clip: { x: box.x + 40, y: box.y + 40, width: 1, height: 1 }
        })
        const background = await app.evaluate(({ nativeImage }, data) => {
          const bitmap = nativeImage.createFromDataURL(`data:image/png;base64,${data}`).toBitmap()
          return [bitmap[2], bitmap[1], bitmap[0]]
        }, pixel.toString('base64'))
        for (const key of ['foreground', 'muted', 'focus', 'border'] as const) {
          const first = luminance(color[key])
          const second = luminance(background)
          const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
          measurements.push({ tone: color.tone, key, background, ratio })
          expect(ratio, `${theme}/${color.tone}/${key}`).toBeGreaterThanOrEqual(
            key === 'foreground' || key === 'muted' ? 4.5 : 3
          )
        }
      }
      await test.info().attach(`contrast-${theme}`, {
        body: JSON.stringify(measurements, null, 2),
        contentType: 'application/json'
      })
      writeFileSync(`test-results/contrast-${theme}.json`, JSON.stringify(measurements, null, 2))
      await page.locator('#contrast-probes').evaluate((element) => element.remove())
      await page.setViewportSize({ width: 960, height: 640 })
      await page
        .getByRole('navigation', { name: '一级导航' })
        .getByRole('button', { name: '问问微信', exact: true })
        .click()
      await page.getByPlaceholder(/例如：技术交流群/).fill('测试群讨论了什么？')
      await page.getByRole('button', { name: '开始分析', exact: true }).click()
      await expect(page.getByText(/固定假回答：测试数据中的核心流程正常/)).toBeVisible()
      await page.getByRole('button', { name: '[E1]', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '证据与来源' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveCSS('opacity', '1')
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true
      )
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
    } finally {
      await fixture.close()
    }
  })

  test(`NIGHT-02 ${theme} accessibility and composed contrast`, async () => {
    test.setTimeout(240_000)
    const fixture = await launchTestApp({ appearanceTheme: theme })
    const { page } = fixture
    const results: { page: string; violations: unknown; incomplete: unknown }[] = []
    try {
      const nav = page.getByRole('navigation', { name: '一级导航' })
      await expect(nav).toBeVisible()
      const audit = async (name: string): Promise<void> => {
        // Electron does not implement Target.createTarget; audit its existing renderer directly.
        const result = await new AxeBuilder({ page })
          .setLegacyMode(true)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
        results.push({
          page: name,
          violations: result.violations.map(({ id, nodes }) => ({
            id,
            nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary }))
          })),
          incomplete: result.incomplete.map(({ id, nodes }) => ({
            id,
            targets: nodes.map(({ target }) => target)
          }))
        })
        expect
          .soft(
            result.violations.map(({ id, nodes }) => ({
              id,
              nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary }))
            })),
            name
          )
          .toEqual([])
      }
      for (const label of workspaces) {
        await nav.getByRole('button', { name: label, exact: true }).click()
        await expect(nav.getByRole('button', { name: label, exact: true })).toHaveClass(/active/)
        await audit(label)
      }
      for (const label of settings) {
        await page
          .locator('.settings-sidebar')
          .getByRole('button', { name: label, exact: true })
          .click()
        await audit(`设置/${label}`)
      }
    } finally {
      writeFileSync(`test-results/accessibility-${theme}.json`, JSON.stringify(results, null, 2))
      await test.info().attach(`accessibility-${theme}`, {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json'
      })
      await fixture.close()
    }
  })
}
