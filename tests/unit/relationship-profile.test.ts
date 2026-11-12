import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'tracememo-relationship-'))

vi.mock('electron', () => ({
  app: { getPath: () => root }
}))

import {
  buildRelationshipContext,
  isDefaultRelationshipProfile,
  normalizeRelationshipProfile,
  goalStrategyHint,
  RELATIONSHIP_GOALS,
  RELATIONSHIP_STAGES,
  RELATIONSHIP_TYPES
} from '../../src/shared/relationship-profile'
import { RelationshipProfileService } from '../../src/main/services/relationship-profile-service'

describe('关系档案定义', () => {
  it('选项集覆盖 goutou 的阶段与目标', () => {
    expect([...RELATIONSHIP_STAGES]).toEqual([
      '未填写',
      '初识',
      '了解中',
      '暧昧',
      '约会中',
      '伴侣',
      '关系结束'
    ])
    expect([...RELATIONSHIP_GOALS]).toEqual([
      '自然接话',
      '主动邀约',
      '澄清关系',
      '修复冲突',
      '减少投入',
      '结束联系'
    ])
    expect([...RELATIONSHIP_TYPES]).toContain('同事')
  })

  it('非法值回落到默认值，超长说明被截断', () => {
    const profile = normalizeRelationshipProfile({
      userMd5: 'u1',
      type: '外星人' as never,
      stage: '热恋中' as never,
      goal: '随便' as never,
      note: 'x'.repeat(400)
    })
    expect(profile.type).toBe('朋友')
    expect(profile.stage).toBe('未填写')
    expect(profile.goal).toBe('自然接话')
    expect(profile.note).toHaveLength(200)
  })

  it('上下文顺序固定，未填写阶段不出现', () => {
    expect(
      buildRelationshipContext({ type: '同事', stage: '未填写', goal: '自然接话', note: '' })
    ).toBe('关系类型：同事；本轮目标：自然接话')
    expect(
      buildRelationshipContext({ type: '朋友', stage: '了解中', goal: '主动邀约', note: '同城' })
    ).toBe('关系类型：朋友；关系阶段：了解中；本轮目标：主动邀约；补充说明：同城')
    expect(buildRelationshipContext(null)).toBe('')
  })

  it('目标会给出策略倾向，且不越权判断', () => {
    expect(goalStrategyHint('减少投入')).toContain('不主动开启新话题')
    expect(goalStrategyHint('主动邀约')).toContain('被拒就收')
    expect(goalStrategyHint('自然接话')).toContain('不额外推进')
  })

  it('默认档案判定用于避免写入空记录', () => {
    expect(
      isDefaultRelationshipProfile({
        userMd5: 'u1',
        type: '朋友',
        stage: '未填写',
        goal: '自然接话',
        note: '',
        updatedAt: 1
      })
    ).toBe(true)
  })
})

describe('关系档案存储', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('按联系人保存并读回', () => {
    const service = new RelationshipProfileService()
    const saved = service.save({
      userMd5: 'md5-a',
      type: '同事',
      stage: '了解中',
      goal: '主动邀约',
      note: '同部门'
    })
    expect(saved.success).toBe(true)
    const loaded = service.get('md5-a')
    expect(loaded.type).toBe('同事')
    expect(loaded.stage).toBe('了解中')
    expect(loaded.note).toBe('同部门')
  })

  it('没有记录时返回默认档案且 updatedAt 为 0', () => {
    const service = new RelationshipProfileService()
    const empty = service.get('md5-missing')
    expect(empty.updatedAt).toBe(0)
    expect(empty.type).toBe('朋友')
  })

  it('保存默认值会删除已有记录', () => {
    const service = new RelationshipProfileService()
    service.save({ userMd5: 'md5-b', type: '恋人', stage: '伴侣', goal: '澄清关系' })
    expect(service.get('md5-b').type).toBe('恋人')
    service.save({ userMd5: 'md5-b', type: '朋友', stage: '未填写', goal: '自然接话', note: '' })
    expect(service.get('md5-b').updatedAt).toBe(0)
  })

  it('列表返回已保存的档案，文件是 version 1 的可读 JSON', () => {
    const service = new RelationshipProfileService()
    service.save({ userMd5: 'md5-c', type: '客户', stage: '初识', goal: '自然接话' })
    expect(service.list().some((item) => item.userMd5 === 'md5-c')).toBe(true)
    const file = join(root, 'relationship-profiles.json')
    expect(existsSync(file)).toBe(true)
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      profiles: Record<string, { type: string }>
    }
    expect(data.version).toBe(1)
    expect(data.profiles['md5-c'].type).toBe('客户')
  })

  it('缺少联系人标识时拒绝保存', () => {
    const service = new RelationshipProfileService()
    expect(service.save({ userMd5: '  ' }).success).toBe(false)
    expect(service.remove('').success).toBe(false)
  })
})
