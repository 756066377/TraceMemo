import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { launchTestApp } from './support/electron'

test('NIGHT-04 long message scrolling, resizing and glass cost', async () => {
  test.setTimeout(90_000)
  const fixture = await launchTestApp({ appearanceTheme: 'dark', largeMessages: 1500 })
  const { page } = fixture
  try {
    await page.getByText('产品测试群', { exact: true }).click()
    const list = page.locator('.wechat-message-list')
    await expect(list).toBeVisible()
    // Exercise the real history-loading path, including the existing 250ms scroll guard.
    for (let index = 0; index < 4; index += 1) {
      await list.evaluate((element) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
      await page.waitForTimeout(350)
    }
    expect(await list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(6000)
    expect(await page.locator('.virtual-message-group').count()).toBeLessThan(100)
    expect(
      await page
        .locator('.message-bubble')
        .first()
        .evaluate((element) => getComputedStyle(element).backdropFilter)
    ).toBe('none')
    const results: { blur: boolean; medianMs: number; p95Ms: number }[] = []
    for (const blur of [false, true, true, false]) {
      await page.evaluate((enabled) => {
        document.getElementById('perf-disable-blur')?.remove()
        if (!enabled) {
          const style = document.createElement('style')
          style.id = 'perf-disable-blur'
          style.textContent =
            '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'
          document.head.append(style)
        }
      }, blur)
      const samples = await list.evaluate(
        (element) =>
          new Promise<number[]>((resolve) => {
            const frames: number[] = []
            let last = performance.now()
            const tick = (now: number): void => {
              frames.push(now - last)
              last = now
              element.scrollTop =
                60 +
                ((frames.length * 73) %
                  Math.max(1, element.scrollHeight - element.clientHeight - 120))
              if (frames.length < 120) requestAnimationFrame(tick)
              else resolve(frames.slice(5).sort((first, second) => first - second))
            }
            requestAnimationFrame(tick)
          })
      )
      results.push({
        blur,
        medianMs: samples[Math.floor(samples.length / 2)],
        p95Ms: samples[Math.floor(samples.length * 0.95)]
      })
    }
    await page.locator('#perf-disable-blur').evaluate((element) => element.remove())
    for (const width of [960, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      )
    }
    await page.getByRole('button', { name: '分析并起草', exact: true }).click()
    await expect(page.locator('.reply-panel')).toBeVisible()
    const report = { sourceMessages: 1503, softwareRendering: true, results }
    writeFileSync('test-results/nightflight-performance.json', JSON.stringify(report, null, 2))
    await test.info().attach('scroll-performance', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })
  } finally {
    await fixture.close()
  }
})
