import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ReplyAssistantKnowledge,
  ReplyAssistantRequest,
  ReplyAssistantTranscriptMessage
} from '../../shared/reply-assistant'

export const REPLY_KNOWLEDGE_VERSION = '12ee1d6-tracememo.1'
export const REPLY_KNOWLEDGE_BUDGET = 10_000

const SECTIONS = {
  core: { file: 'SKILL.md', title: '事实、边界与行动原则' },
  reply: { file: 'reply.md', title: '自然口吻与一句话回复' },
  conflict: { file: 'conflict.md', title: '冲突与修复' },
  invitation: { file: 'invitation.md', title: '主动联系与低压力邀约' },
  withdrawal: { file: 'withdrawal.md', title: '互惠判断与退出' }
} as const

type Topic = keyof typeof SECTIONS

export interface ReplyKnowledgeBundle {
  metadata: ReplyAssistantKnowledge
  sections: Array<{ id: string; title: string; content: string }>
}

export function selectReplyKnowledgeTopics(
  request: ReplyAssistantRequest,
  messages: readonly ReplyAssistantTranscriptMessage[]
): Topic[] {
  const topics: Topic[] = ['core', 'reply']
  const goalTopic: Partial<Record<string, Topic>> = {
    修复冲突: 'conflict',
    主动邀约: 'invitation',
    减少投入: 'withdrawal',
    结束联系: 'withdrawal'
  }
  const goal = goalTopic[request.relationshipGoal || '']
  if (goal) topics.push(goal)
  // 只从固定主题中选择；聊天里的文件名和加载指令不能变成文件路径。
  const recent = messages
    .slice(-4)
    .map((message) => message.text)
    .join('\n')
  if (/对不起|道歉|误会|吵架|失约|生气|冷静/.test(recent)) topics.push('conflict')
  if (/别再联系|不要再联系|结束联系|分手|不想继续/.test(recent)) topics.push('withdrawal')
  return [...new Set(topics)].slice(0, 4)
}

export class ReplyAssistantKnowledgeService {
  private readonly cache = new Map<Topic, string>()

  constructor(private readonly root: string | null) {}

  async load(
    request: ReplyAssistantRequest,
    messages: readonly ReplyAssistantTranscriptMessage[]
  ): Promise<ReplyKnowledgeBundle> {
    const topics = selectReplyKnowledgeTopics(request, messages)
    const bundle: ReplyKnowledgeBundle = {
      metadata: {
        version: REPLY_KNOWLEDGE_VERSION,
        status: 'unavailable',
        sources: [],
        missingTopics: []
      },
      sections: []
    }
    let remaining = REPLY_KNOWLEDGE_BUDGET
    for (const topic of topics) {
      const section = SECTIONS[topic]
      try {
        if (!this.root) throw new Error('missing resource root')
        let content = this.cache.get(topic)
        if (content === undefined) {
          content = (await readFile(join(this.root, section.file), 'utf8')).trim()
          if (!content || content.length > REPLY_KNOWLEDGE_BUDGET) {
            throw new Error('invalid knowledge section')
          }
          this.cache.set(topic, content)
        }
        // 保留完整章节，不把截断的规则当成完整知识。
        if (content.length > remaining) throw new Error('knowledge budget exceeded')
        remaining -= content.length
        bundle.sections.push({ id: topic, title: section.title, content })
        bundle.metadata.sources.push({
          id: topic,
          title: section.title,
          digest: createHash('sha256').update(content).digest('hex')
        })
      } catch {
        bundle.metadata.missingTopics.push(topic)
      }
    }
    bundle.metadata.status = !bundle.sections.length
      ? 'unavailable'
      : bundle.metadata.missingTopics.length
        ? 'partial'
        : 'loaded'
    return bundle
  }
}
