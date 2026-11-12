import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'
import type { ReplyAssistantResult } from '../../src/shared/reply-assistant'

const result: ReplyAssistantResult = {
  success: true,
  source: 'wechat_database',
  contextSize: 20,
  messageCount: 3,
  sourceMessageIds: ['reply-a'],
  blocked: false,
  candidates: ['你哪天方便', '时间还没定，你看哪天合适', '方便时说一声'],
  bestIndex: 0,
  scores: [0.6, 0.3, 0.1],
  scoreMethod: 'model_relative_weights',
  brief: {
    facts: ['同事甲：「明天几点见」'],
    intent: '可能想确认时间',
    intentConfidence: 0.5,
    action: '本轮主策略：澄清',
    unknown: '双方可用时间仍未知',
    nextStep: '只问一个可用时间，不替自己承诺具体安排。',
    stopCondition: '对方表示不方便时，不继续追问。',
    evidenceNote: '原文来自本地微信数据库。'
  },
  strategy: {
    strategy: '澄清',
    confidence: 0.5,
    intent: '确认时间',
    facts: [],
    unknowns: [],
    method: 'configured_ai_provider',
    evidence: [
      {
        messageId: 'reply-a',
        quote: '明天几点见',
        speaker: '同事甲',
        timestamp: 1_794_096_000_000
      }
    ]
  },
  knowledge: {
    version: '12ee1d6-tracememo.1',
    status: 'loaded',
    missingTopics: [],
    sources: [{ id: 'core', title: '事实、边界与行动原则', digest: 'fixture' }]
  },
  usage: { input: 0, output: 0, total: 0, calls: 3, estimated: true }
}

for (const theme of ['light', 'dark'] as const) {
  test(`回复助手 ${theme}：分析、依据、比较开关与边界结果`, async () => {
    test.skip(process.platform !== 'win32', '回复助手目前只在 Windows 启用')
    const fixture = await launchTestApp({ appearanceTheme: theme })
    const { page, app } = fixture
    try {
      await app.evaluate(({ ipcMain }, data) => {
        ipcMain.handle('relationship:get', (_event, userMd5) => ({
          userMd5,
          type: '同事',
          stage: '了解中',
          goal: '自然接话',
          note: '',
          updatedAt: 1
        }))
        ipcMain.handle('reply-assistant:analyze', (_event, request) => {
          if (request.style === '边界测试') {
            return {
              ...data,
              blocked: true,
              candidates: [],
              bestIndex: null,
              scores: [],
              brief: { ...data.brief, nextStep: '先停止联系，等待对方主动重启。' }
            }
          }
          return request.rankCandidates === false
            ? {
                ...data,
                bestIndex: null,
                scores: [1 / 3, 1 / 3, 1 / 3],
                scoreMethod: 'equal_weights'
              }
            : data
        })
      }, result)
      await expect(page.getByRole('navigation', { name: '一级导航' })).toBeVisible()
      await page.locator('.conversation-item').filter({ hasText: '产品测试群' }).first().click()
      await page.getByRole('button', { name: '分析并起草' }).click()
      const panel = page.getByRole('complementary', { name: '分析与回复草稿' })
      await panel.getByRole('button', { name: '开始分析' }).click()
      await expect(panel.getByText('同事甲：「明天几点见」')).toBeVisible()
      await expect(panel.getByText(result.brief.nextStep)).toBeVisible()
      await expect(panel.getByText(result.brief.stopCondition)).toBeVisible()
      await expect(panel.getByText('事实、边界与行动原则')).toBeVisible()
      await expect(panel.getByRole('button', { name: '发送候选 1 到微信' })).toBeVisible()
      await panel.getByLabel('比较候选回复').uncheck()
      await panel.getByRole('button', { name: '重新分析' }).click()
      await expect(panel.getByText('候选 · 未评出优先顺序')).toHaveCount(3)
      for (const width of [960, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(
          await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
        ).toBe(true)
        await panel.getByText('对话分析', { exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: `test-results/reply-assistant-${theme}-${width}.png` })
        await panel.getByRole('heading', { name: '回复草稿', exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({
          path: `test-results/reply-assistant-${theme}-${width}-candidates.png`
        })
      }
      await panel.getByLabel('口吻描述').fill('边界测试')
      await panel.getByRole('button', { name: '重新分析' }).click()
      await expect(panel.getByText('对方已明确要求停止联系，本轮不生成候选。')).toBeVisible()
      await expect(panel.getByRole('button', { name: '发送候选 1 到微信' })).toHaveCount(0)
    } finally {
      await fixture.close()
    }
  })
}
