import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

const title = 'NearCast — 本地优先的微信数据与分析工作台'

test('BRAND-01 login shows the primary name and exact tagline', async () => {
  const fixture = await launchTestApp({ mode: 'disconnected' })
  try {
    await expect(fixture.page).toHaveTitle(title)
    await expect(fixture.page.getByRole('heading', { name: 'NearCast', exact: true })).toBeVisible()
    const logo = fixture.page.locator('.database-login-logo img')
    await expect(logo).toBeVisible()
    expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 512)).toBe(true)
    await expect(
      fixture.page.getByText('本地优先的微信数据与分析工作台', { exact: true })
    ).toBeVisible()
    await fixture.page.screenshot({ path: 'test-results/nearcast-login.png' })
  } finally {
    await fixture.close()
  }
})

test('BRAND-02 application rail omits the logo and About shows the name and tagline', async () => {
  const fixture = await launchTestApp()
  const { page } = fixture
  try {
    await expect(page).toHaveTitle(title)
    await expect(page.locator('.app-primary-rail .app-brand')).toHaveCount(0)
    await page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置', exact: true })
      .click()
    await page
      .locator('.settings-sidebar')
      .getByRole('button', { name: '关于', exact: true })
      .click()
    await expect(
      page.locator('.about-identity-card').getByText('NearCast', { exact: true })
    ).toBeVisible()
    await expect(page.getByText(title, { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/nearcast-about.png' })
  } finally {
    await fixture.close()
  }
})
