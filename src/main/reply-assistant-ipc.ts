import { ipcMain } from 'electron'
import { listMessagesAsync } from './services/chat-service'
import type { AIProviderService } from './services/ai-provider-service'
import { ReplyAssistantService } from './services/reply-assistant-service'
import { relationshipProfileService } from './services/relationship-profile-service'
import { ReplyAssistantKnowledgeService } from './services/reply-assistant-knowledge-service'
import { findResource } from './resource-paths'
import { dirname } from 'node:path'
import {
  createReplyAssistantFailure,
  type ReplyAssistantRequest,
  type ReplyAssistantResult
} from '../shared/reply-assistant'
import type { RelationshipProfile, RelationshipProfileInput } from '../shared/relationship-profile'

/**
 * Windows-only IPC registration.
 * 非 Windows 平台不注册入口，也不创建读取/分析服务实例。
 */
export function registerReplyAssistantIpc(aiProviderService: AIProviderService): void {
  if (process.platform !== 'win32') return

  const skillPath = findResource('reply-assistant/SKILL.md')
  const service = new ReplyAssistantService({
    platform: process.platform,
    ai: aiProviderService,
    knowledge: new ReplyAssistantKnowledgeService(skillPath ? dirname(skillPath) : null),
    loadMessages: (userMd5, limit) =>
      listMessagesAsync(userMd5, undefined, undefined, { limit }, '', 'reply-assistant')
  })

  ipcMain.handle(
    'reply-assistant:analyze',
    async (_event, rawRequest: ReplyAssistantRequest): Promise<ReplyAssistantResult> => {
      try {
        // 渲染层可以只传 userMd5：关系档案以主进程保存的为准，避免界面没加载完就用默认值分析。
        const request = withStoredRelationship(rawRequest)
        return await service.analyze(request)
      } catch (error) {
        return createReplyAssistantFailure(
          'internal_error',
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        )
      }
    }
  )

  ipcMain.handle(
    'relationship:get',
    (_event, userMd5: string): RelationshipProfile => relationshipProfileService.get(userMd5)
  )

  ipcMain.handle('relationship:list', (): RelationshipProfile[] =>
    relationshipProfileService.list()
  )

  ipcMain.handle('relationship:save', (_event, input: RelationshipProfileInput) =>
    relationshipProfileService.save(input)
  )

  ipcMain.handle('relationship:remove', (_event, userMd5: string) =>
    relationshipProfileService.remove(userMd5)
  )
}

/**
 * 请求里没有结构化关系字段时，用主进程保存的档案补齐；
 * 显式传了结构化字段就以渲染层为准（用户正在面板里改选项）。
 */
function withStoredRelationship(request: ReplyAssistantRequest): ReplyAssistantRequest {
  if (!request || typeof request !== 'object') return request
  const hasStructured = Boolean(
    request.relationshipType ||
    request.relationshipStage ||
    request.relationshipGoal ||
    request.relationshipNote
  )
  if (hasStructured) return request
  const userMd5 = typeof request.userMd5 === 'string' ? request.userMd5.trim() : ''
  if (!userMd5) return request
  const profile = relationshipProfileService.get(userMd5)
  if (!profile.updatedAt) return request
  return {
    ...request,
    relationshipType: profile.type,
    relationshipStage: profile.stage,
    relationshipGoal: profile.goal,
    relationshipNote: profile.note
  }
}
