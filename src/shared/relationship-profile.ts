/**
 * 关系档案：按联系人保存「关系类型 + 关系阶段 + 本轮聊天目标」。
 *
 * 选项集参考 goutou `app/settings.py` 的 STAGES / GOALS，并按 TraceMemo 的会话维度
 * 增加「关系类型」。这里只放纯数据与纯函数：不读写文件、不联网，主进程与渲染层共用。
 *
 * 设计要点：
 * - 选项是封闭集合，避免自由文本把提示词带偏；用户仍可写一句补充说明（≤200 字）。
 * - 存储键用联系人 md5（TraceMemo 的会话标识），不是可改的昵称。
 * - 缺省值不写入文件；只有用户显式选择后才落盘，避免给每个联系人都造一条空记录。
 */

export const RELATIONSHIP_TYPES = [
  '朋友',
  '同事',
  '同学',
  '客户',
  '家人',
  '暧昧对象',
  '恋人',
  '前任',
  '网友',
  '群友',
  '其他'
] as const

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

/** 与 goutou 的 STAGES 对齐；「未填写」表示没有显式设置。 */
export const RELATIONSHIP_STAGES = [
  '未填写',
  '初识',
  '了解中',
  '暧昧',
  '约会中',
  '伴侣',
  '关系结束'
] as const

export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number]

/** 与 goutou 的 GOALS 对齐：本轮想达成什么，直接决定策略倾向。 */
export const RELATIONSHIP_GOALS = [
  '自然接话',
  '主动邀约',
  '澄清关系',
  '修复冲突',
  '减少投入',
  '结束联系'
] as const

export type RelationshipGoal = (typeof RELATIONSHIP_GOALS)[number]

export const RELATIONSHIP_NOTE_MAX_LENGTH = 200

export interface RelationshipProfile {
  /** 联系人 md5（TraceMemo 会话标识）。 */
  userMd5: string
  type: RelationshipType
  stage: RelationshipStage
  goal: RelationshipGoal
  note: string
  updatedAt: number
}

export interface RelationshipProfileInput {
  userMd5: string
  type?: string
  stage?: string
  goal?: string
  note?: string
}

export const DEFAULT_RELATIONSHIP_PROFILE: Omit<RelationshipProfile, 'userMd5' | 'updatedAt'> = {
  type: '朋友',
  stage: '未填写',
  goal: '自然接话',
  note: ''
}

export function isRelationshipType(value: unknown): value is RelationshipType {
  return typeof value === 'string' && (RELATIONSHIP_TYPES as readonly string[]).includes(value)
}

export function isRelationshipStage(value: unknown): value is RelationshipStage {
  return typeof value === 'string' && (RELATIONSHIP_STAGES as readonly string[]).includes(value)
}

export function isRelationshipGoal(value: unknown): value is RelationshipGoal {
  return typeof value === 'string' && (RELATIONSHIP_GOALS as readonly string[]).includes(value)
}

export function normalizeRelationshipNote(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RELATIONSHIP_NOTE_MAX_LENGTH)
}

/** 把任意输入收敛成合法档案；非法值回落到默认值，不抛错（配置损坏不能阻断聊天）。 */
export function normalizeRelationshipProfile(input: RelationshipProfileInput): RelationshipProfile {
  return {
    userMd5: String(input.userMd5 || '').trim(),
    type: isRelationshipType(input.type) ? input.type : DEFAULT_RELATIONSHIP_PROFILE.type,
    stage: isRelationshipStage(input.stage) ? input.stage : DEFAULT_RELATIONSHIP_PROFILE.stage,
    goal: isRelationshipGoal(input.goal) ? input.goal : DEFAULT_RELATIONSHIP_PROFILE.goal,
    note: normalizeRelationshipNote(input.note),
    updatedAt: Date.now()
  }
}

/** 当前档案是否等于默认值（用来决定是否值得落盘）。 */
export function isDefaultRelationshipProfile(profile: RelationshipProfile): boolean {
  return (
    profile.type === DEFAULT_RELATIONSHIP_PROFILE.type &&
    profile.stage === DEFAULT_RELATIONSHIP_PROFILE.stage &&
    profile.goal === DEFAULT_RELATIONSHIP_PROFILE.goal &&
    !profile.note
  )
}

/**
 * 生成给模型的关系上下文。
 *
 * 顺序固定：类型 → 阶段 → 目标 → 补充说明，便于模型稳定识别；
 * 阶段为「未填写」时不写「关系阶段」，避免提示词里出现空字段。
 */
export function buildRelationshipContext(
  profile: Pick<RelationshipProfile, 'type' | 'stage' | 'goal' | 'note'> | null | undefined
): string {
  if (!profile) return ''
  const parts: string[] = []
  if (profile.type) parts.push(`关系类型：${profile.type}`)
  if (profile.stage && profile.stage !== '未填写') parts.push(`关系阶段：${profile.stage}`)
  if (profile.goal) parts.push(`本轮目标：${profile.goal}`)
  const note = normalizeRelationshipNote(profile.note)
  if (note) parts.push(`补充说明：${note}`)
  return parts.join('；')
}

/**
 * 目标 → 策略倾向，只作为模型的先验提示，不覆盖证据判断。
 * 例如「减少投入」「结束联系」必须倾向收线，而不是继续推进。
 */
export function goalStrategyHint(goal: RelationshipGoal): string {
  switch (goal) {
    case '主动邀约':
      return '目标是推进到具体邀约：只在有可信时间或活动契机时轻推，被拒就收。'
    case '澄清关系':
      return '目标是澄清：先确认一个关键事实，不要连续追问。'
    case '修复冲突':
      return '目标是修复：先承接情绪、承认具体行为，不急着解释自己。'
    case '减少投入':
      return '目标是减少投入：短、礼貌、不主动开启新话题。'
    case '结束联系':
      return '目标是结束联系：明确、干净地收线，不留下模糊期待。'
    case '自然接话':
    default:
      return '目标是自然接话：接住对方刚说的事，不额外推进。'
  }
}
