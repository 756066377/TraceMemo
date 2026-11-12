import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (relativePath: string): string => readFileSync(resolve(root, relativePath), 'utf8')

const implementedFiles = [
  'src/shared/reply-assistant.ts',
  'src/shared/relationship-profile.ts',
  'src/main/services/reply-assistant-service.ts',
  'src/main/services/relationship-profile-service.ts',
  'src/main/reply-assistant-ipc.ts',
  'src/renderer/src/components/chat/ReplyAssistantPanel.tsx',
  'src/renderer/src/components/chat/ChatHeader.tsx',
  'src/renderer/src/components/ChatWindow.tsx'
]

const forbiddenPatterns = [
  /GOUTOU_[A-Z_]+/,
  /RapidOCR/,
  /cloud_ocr/,
  /windows_capture/,
  /jev_(mac|ios|android)/,
  /integrations\/jev_windows\/app/,
  /from\s+['"][^'"]*(capture|ocr|worker|fill)['"]/
]

describe('reply-assistant 集成边界', () => {
  it('新增实现不包含上游截图、屏幕采集、Qt 悬浮窗或其他平台入口', () => {
    for (const relativePath of implementedFiles) {
      const source = read(relativePath)
      for (const pattern of forbiddenPatterns) {
        expect(source, `${relativePath} 命中 ${String(pattern)}`).not.toMatch(pattern)
      }
    }
  })

  it('主进程入口仅在 win32 注册，且不允许渲染层提供聊天消息数组', () => {
    const ipc = read('src/main/reply-assistant-ipc.ts')
    const contract = read('src/shared/reply-assistant.ts')
    expect(ipc).toMatch(/process\.platform !== 'win32'/)
    expect(ipc).toMatch(/listMessagesAsync/)
    expect(ipc).toMatch(/reply-assistant:analyze/)
    const requestBlock =
      contract.match(/export interface ReplyAssistantRequest \{[\s\S]*?\n\}/)?.[0] || ''
    expect(requestBlock).toMatch(/userMd5: string/)
    expect(requestBlock).not.toMatch(/\bmessages\s*\??:/)
  })

  it('外部源仓库不进入 Windows 打包、lint 与提交', () => {
    expect(read('electron-builder.win.yml')).toContain('!goutoujunshi-jev-chat/**')
    expect(read('eslint.config.mjs')).toContain('goutoujunshi-jev-chat/**')
    expect(read('.gitignore')).toContain('/goutoujunshi-jev-chat/')
    expect(read('.prettierignore')).toContain('goutoujunshi-jev-chat')
  })
})
