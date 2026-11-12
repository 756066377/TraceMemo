import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import {
  DEFAULT_RELATIONSHIP_PROFILE,
  isDefaultRelationshipProfile,
  normalizeRelationshipProfile,
  type RelationshipProfile,
  type RelationshipProfileInput
} from '../../shared/relationship-profile'

interface RelationshipFile {
  version: 1
  profiles: Record<string, Omit<RelationshipProfile, 'userMd5'>>
}

/**
 * 关系档案存储。
 *
 * - 文件：`{userData}/relationship-profiles.json`，version 1，按 md5 索引。
 * - 损坏文件不抛错：退回空档案，避免一个坏 JSON 让整个聊天窗口打不开。
 * - 写入用「临时文件 + rename」原子替换，避免应用崩溃留下半截文件。
 * - 等于默认值的档案直接删除，不给每个联系人都留一条空记录。
 */
export class RelationshipProfileService {
  get(userMd5: string): RelationshipProfile {
    const key = normalizeKey(userMd5)
    if (!key) return emptyProfile('')
    const stored = this.read().profiles[key]
    if (!stored) return emptyProfile(key)
    return normalizeRelationshipProfile({ ...stored, userMd5: key })
  }

  list(): RelationshipProfile[] {
    const data = this.read()
    return Object.entries(data.profiles).map(([userMd5, row]) =>
      normalizeRelationshipProfile({ ...row, userMd5 })
    )
  }

  save(input: RelationshipProfileInput): {
    success: boolean
    profile?: RelationshipProfile
    error?: string
  } {
    const key = normalizeKey(input?.userMd5)
    if (!key) return { success: false, error: '缺少联系人标识' }
    const profile = normalizeRelationshipProfile({ ...input, userMd5: key })
    const data = this.read()
    if (isDefaultRelationshipProfile(profile)) {
      delete data.profiles[key]
    } else {
      data.profiles[key] = {
        type: profile.type,
        stage: profile.stage,
        goal: profile.goal,
        note: profile.note,
        updatedAt: profile.updatedAt
      }
    }
    if (!this.write(data)) return { success: false, error: '关系档案写入失败' }
    return { success: true, profile }
  }

  remove(userMd5: string): { success: boolean; error?: string } {
    const key = normalizeKey(userMd5)
    if (!key) return { success: false, error: '缺少联系人标识' }
    const data = this.read()
    if (!data.profiles[key]) return { success: true }
    delete data.profiles[key]
    return this.write(data) ? { success: true } : { success: false, error: '关系档案写入失败' }
  }

  private read(): RelationshipFile {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, profiles: {} }
      const raw = fs.readJsonSync(this.filePath) as Partial<RelationshipFile>
      if (!raw || raw.version !== 1 || typeof raw.profiles !== 'object' || !raw.profiles) {
        return { version: 1, profiles: {} }
      }
      return { version: 1, profiles: { ...raw.profiles } }
    } catch {
      return { version: 1, profiles: {} }
    }
  }

  private write(data: RelationshipFile): boolean {
    try {
      fs.ensureDirSync(path.dirname(this.filePath))
      const temporary = `${this.filePath}.tmp`
      fs.writeJsonSync(temporary, data, { spaces: 2 })
      fs.moveSync(temporary, this.filePath, { overwrite: true })
      return true
    } catch {
      return false
    }
  }

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'relationship-profiles.json')
  }
}

function normalizeKey(value: unknown): string {
  return String(value || '').trim()
}

function emptyProfile(userMd5: string): RelationshipProfile {
  return { ...DEFAULT_RELATIONSHIP_PROFILE, userMd5, updatedAt: 0 }
}

export const relationshipProfileService = new RelationshipProfileService()
