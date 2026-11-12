import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { launchTestApp } from './support/electron'

const destinations = [
  '狗头军师', '问问微信', '日报', '退群监控', '自动化', 'Agent', '导出', 'API', '设置'
]

for (const theme of ['light', 'dark'] as const) {
  test(`RAIL-01 ${theme} logo-free navigation keeps every destination and keyboard path`, async () => {
    test.setTimeout(120_000)
    const fixture = await launchTestApp({ appearanceTheme: theme })
    const { page } = fixture
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const rail = page.locator('.app-primary-rail')
      const nav = page.getByRole('navigation', { name: '一级导航' })
      await expect(rail.locator('.app-brand')).toHaveCount(0)
      await expect(nav.getByRole('button')).toHaveCount(destinations.length)
      for (const [width, height] of [[960, 640], [1280, 720], [1440, 900], [1920, 1080]]) {
        await page.setViewportSize({ width, height })
        for (const name of destinations) {
          const button = nav.getByRole('button', { name, exact: true })
          await expect(button.locator('svg')).toHaveCount(1)
          await button.click()
          await expect(button).toHaveAttribute('aria-current', 'page')
          await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
          await expect(page.getByRole('main', { name, exact: true })).toBeVisible()
        }
        const fits = await nav.evaluate(element => element.scrollHeight <= element.clientHeight + 1)
        expect(fits, `navigation fits ${width}×${height}`).toBe(true)
        await expect(page.getByRole('button', { name: '新手引导', exact: true })).toBeInViewport()
        await expect(rail.getByRole('button', { name: /打开账号设置/ })).toBeInViewport()
        await page.screenshot({ path: `test-results/sidebar-${theme}-${width}.png` })
      }
      await page.setViewportSize({ width: 960, height: 640 })
      // 使用真实键盘输入切换输入模式，避免把鼠标后的程序化焦点误判为焦点环缺失。
      await page.keyboard.press('Tab')
      await nav.getByRole('button', { name: destinations[0], exact: true }).focus()
      for (const name of destinations) {
        const button = nav.getByRole('button', { name, exact: true })
        await expect(button).toBeFocused()
        await expect(button).toHaveCSS('outline-style', 'solid')
        await expect(button).toBeInViewport()
        await page.keyboard.press('Tab')
      }
      await expect(page.getByRole('button', { name: '新手引导', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      const welcome = page.getByRole('dialog', { name: '开始探索你的微信' })
      await expect(welcome).toBeVisible()
      await welcome.getByRole('button', { name: '关闭', exact: true }).click()
      await rail.getByRole('button', { name: /打开账号设置/ }).click()
      await page.locator('.settings-sidebar').getByRole('button', { name: '外观与行为', exact: true }).click()
      await page.getByRole('switch', { name: '紧凑布局' }).click()
      await expect(page.locator('.app-shell')).toHaveClass(/is-compact/)
      await expect(nav.getByRole('button', { name: '退群监控', exact: true })).toBeInViewport()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(nav.getByRole('button').first()).toHaveCSS('transition-duration', '0s')
      const audit = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .include('.app-primary-rail')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
      expect(audit.violations).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await fixture.close()
    }
  })
}
