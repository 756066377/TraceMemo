import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ root: '', userData: '', appPath: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? paths.userData : paths.root),
    getAppPath: () => paths.appPath
  }
}))

import {
  pickBundledComponent,
  readHookManifest,
  requiresProcessInjection,
  describeWechatLoaderError,
  WechatHookComponentService
} from '../../src/main/services/wechat-hook-component-service'

/** 造一个结构合法的最小 x64 PE，用于 PE 头解析。 */
function writeFakePe(filePath: string, machine: 0x8664 | 0x014c = 0x8664): void {
  const buffer = Buffer.alloc(0x100)
  buffer.writeUInt16LE(0x5a4d, 0)
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.writeUInt32LE(0x00004550, 0x80)
  buffer.writeUInt16LE(machine, 0x84)
  writeFileSync(filePath, buffer)
}

describe('WeChat-Hook 组件 manifest', () => {
  let hookDir: string

  beforeEach(() => {
    paths.root = mkdtempSync(path.join(tmpdir(), 'tm-hook-'))
    paths.userData = path.join(paths.root, 'userData')
    paths.appPath = path.join(paths.root, 'app')
    hookDir = path.join(paths.appPath, 'resources', 'wechat-hook')
    mkdirSync(hookDir, { recursive: true })
    mkdirSync(paths.userData, { recursive: true })
    // 覆盖真实仓库的 resources，避免测试读到仓库里的 manifest。
    process.env.TRACEMEMO_RESOURCES_PATH = path.join(paths.appPath, 'resources')
  })

  afterEach(() => {
    delete process.env.TRACEMEMO_RESOURCES_PATH
    rmSync(paths.root, { recursive: true, force: true })
  })

  function writeManifest(components: unknown[]): void {
    writeFileSync(
      path.join(hookDir, 'manifest.json'),
      JSON.stringify({ schema: 1, components }),
      'utf8'
    )
  }

  it('按当前微信版本精确匹配组件，而不是永远用第一个', () => {
    writeFakePe(path.join(hookDir, 'version-4.1.10.27.dll'))
    writeFakePe(path.join(hookDir, 'version-4.1.15.56.dll'))
    writeManifest([
      { file: 'version-4.1.10.27.dll', wechatVersions: ['4.1.10.27'], sha256: '' },
      { file: 'version-4.1.15.56.dll', wechatVersions: ['4.1.15.56'], sha256: '' }
    ])

    const manifest = readHookManifest()
    const picked = pickBundledComponent(manifest, '4.1.15.56')
    expect(picked?.file).toBe('version-4.1.15.56.dll')

    // 版本不匹配时不回退到别的版本，避免把错误 DLL 塞进微信目录。
    expect(pickBundledComponent(manifest, '4.1.16.1')).toBeNull()
  })

  it('未声明版本的组件作为兜底，但不会替别的版本背书', () => {
    writeFakePe(path.join(hookDir, 'version.dll'))
    writeManifest([{ file: 'version.dll', wechatVersions: ['*'], sha256: '' }])

    const manifest = readHookManifest()
    expect(manifest.components[0].wechatVersions).toEqual(['*'])
    expect(pickBundledComponent(manifest, '4.1.15.56')?.file).toBe('version.dll')
    // 通配组件不算「已验证版本」，设置页的版本清单应为空。
    const supportedVersions = manifest.components
      .flatMap((component) => component.wechatVersions)
      .filter((version) => version !== '*')
    expect(supportedVersions).toEqual([])
  })

  it('manifest 声明了但文件缺失时视为没有内置组件', () => {
    writeManifest([{ file: 'version.dll', wechatVersions: ['4.1.15.56'], sha256: '' }])
    expect(pickBundledComponent(readHookManifest(), '4.1.15.56')).toBeNull()
  })

  it('拒绝指向目录外的文件名，防止 manifest 被改成任意路径读取', () => {
    writeFakePe(path.join(paths.root, 'evil.dll'))
    writeManifest([
      { file: '../evil.dll', wechatVersions: ['4.1.15.56'], sha256: '' },
      { file: 'version.dll', wechatVersions: ['4.1.15.56'], sha256: '' }
    ])
    const manifest = readHookManifest()
    expect(manifest.components).toHaveLength(1)
    expect(manifest.components[0].file).toBe('version.dll')
  })

  it('manifest 损坏时回退到通配声明，不让设置页整页失败', () => {
    writeFileSync(path.join(hookDir, 'manifest.json'), '{ not json', 'utf8')
    const manifest = readHookManifest()
    expect(manifest.components).toEqual([{ file: 'version.dll', wechatVersions: ['*'] }])
  })

  it('加载器使用经过校验的配套文件，接口未登录也能连接且不声称可发送', async () => {
    if (process.platform !== 'win32') return
    const dll = path.join(hookDir, 'version.dll')
    const loader = path.join(hookDir, 'wxinject.exe')
    writeFakePe(dll)
    writeFakePe(loader)
    const hash = createHash('sha256').update(readFileSync(dll)).digest('hex')
    writeManifest([
      {
        file: 'version.dll',
        wechatVersions: ['4.1.15.56'],
        sha256: hash,
        loader: { file: 'wxinject.exe', sha256: hash }
      }
    ])
    const runtime = {
      probeWechat: vi.fn().mockResolvedValue({
        detected: true,
        running: false,
        version: '4.1.15.56',
        executablePath: 'C:\\微信 Test\\Weixin.exe'
      }),
      launch: vi.fn().mockResolvedValue(undefined),
      probe: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ protocol: 'wechat4-hook', loggedIn: false }),
      wait: vi.fn().mockResolvedValue(undefined)
    }
    const service = new WechatHookComponentService(runtime)
    const [started, duplicate] = await Promise.all([
      service.startWithHook(),
      service.startWithHook()
    ])
    expect(started).toMatchObject({
      success: true,
      port: '30001',
      loggedIn: false
    })
    expect(duplicate.success).toBe(false)
    expect(runtime.launch).toHaveBeenCalledTimes(1)
    const staged = path.join(paths.userData, 'wechat-hook', 'launch', hash, 'version.dll')
    expect(runtime.launch).toHaveBeenCalledWith(loader, ['C:\\微信 Test\\Weixin.exe', staged])
    expect(readFileSync(staged)).toEqual(readFileSync(dll))
    runtime.launch.mockClear()
    runtime.probe.mockResolvedValue(null)
    writeFileSync(loader, 'damaged')
    expect(await service.startWithHook()).toMatchObject({ success: false })
    expect(runtime.launch).not.toHaveBeenCalled()
  })

  it('启动器非零退出但服务已就绪时使用实际接口状态，保留诊断信息', async () => {
    if (process.platform !== 'win32') return
    writeFakePe(path.join(hookDir, 'version.dll'))
    writeFakePe(path.join(hookDir, 'wxinject.exe'))
    const hash = createHash('sha256')
      .update(readFileSync(path.join(hookDir, 'version.dll')))
      .digest('hex')
    writeManifest([
      {
        file: 'version.dll',
        wechatVersions: ['4.1.15.56'],
        sha256: hash,
        loader: { file: 'wxinject.exe', sha256: hash }
      }
    ])
    const runtime = {
      probeWechat: vi
        .fn()
        .mockResolvedValue({
          detected: true,
          running: false,
          version: '4.1.15.56',
          executablePath: 'C:\\Wechat\\Weixin.exe'
        }),
      launch: vi.fn().mockRejectedValue({ code: 7, stdout: '[injector] hook dll not resident' }),
      probe: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ protocol: 'wechat4-hook', loggedIn: false }),
      wait: vi.fn().mockResolvedValue(undefined)
    }
    expect(await new WechatHookComponentService(runtime).startWithHook()).toMatchObject({
      success: true,
      loggedIn: false,
      steps: expect.arrayContaining(['启动器返回异常，但已确认发送接口可访问'])
    })
    expect(
      describeWechatLoaderError({ code: 7, stdout: '[injector] hook dll not resident' })
    ).toContain('hook dll not resident')
    expect(describeWechatLoaderError({ killed: true })).toContain('超时')
  })

  it('已有服务时不再启动或要求退出微信', async () => {
    const runtime = {
      probeWechat: vi
        .fn()
        .mockResolvedValue({
          detected: true,
          running: true,
          version: '4.1.15.56',
          executablePath: 'C:\\Wechat\\Weixin.exe'
        }),
      launch: vi.fn().mockResolvedValue(undefined),
      probe: vi.fn().mockResolvedValue({ protocol: 'wechat4-hook', loggedIn: false }),
      wait: vi.fn().mockResolvedValue(undefined)
    }
    expect(await new WechatHookComponentService(runtime).startWithHook()).toMatchObject({
      success: true,
      port: '30001',
      loggedIn: false
    })
    expect(runtime.launch).not.toHaveBeenCalled()
  })

  it('旧导入组件不遮挡匹配的内置版本；启动失败和接口未响应均返回失败', async () => {
    if (process.platform !== 'win32') return
    const dll = path.join(hookDir, 'version.dll')
    const loader = path.join(hookDir, 'wxinject.exe')
    writeFakePe(dll)
    writeFakePe(loader)
    const hash = createHash('sha256').update(readFileSync(dll)).digest('hex')
    writeManifest([
      {
        file: 'version.dll',
        wechatVersions: ['4.1.15.56'],
        sha256: hash,
        loader: { file: 'wxinject.exe', sha256: hash }
      }
    ])
    const importedDir = path.join(paths.userData, 'wechat-hook')
    mkdirSync(importedDir)
    writeFakePe(path.join(importedDir, 'version.dll'))
    writeFileSync(
      path.join(importedDir, 'meta.json'),
      JSON.stringify({ sha256: hash, wechatVersions: ['4.1.10.27'] })
    )
    const runtime = {
      probeWechat: vi.fn().mockResolvedValue({
        detected: true,
        running: false,
        version: '4.1.15.56',
        executablePath: 'C:\\Wechat\\Weixin.exe'
      }),
      launch: vi
        .fn()
        .mockRejectedValueOnce(new Error('loader failed'))
        .mockResolvedValue(undefined),
      probe: vi.fn().mockResolvedValue(null),
      wait: vi.fn().mockResolvedValue(undefined)
    }
    const service = new WechatHookComponentService(runtime)
    expect((await service.getStatus()).dll).toMatchObject({ path: dll, source: 'bundled' })
    expect(await service.startWithHook()).toMatchObject({
      success: false,
      error: expect.stringContaining('loader failed')
    })
    expect(await service.startWithHook()).toMatchObject({
      success: false,
      error: expect.stringContaining('未响应')
    })
    expect(runtime.launch).toHaveBeenCalledTimes(2)
  })

  it('微信运行中、版本不匹配时不启动，也不会自动关闭微信', async () => {
    if (process.platform !== 'win32') return
    const runtime = {
      probeWechat: vi.fn().mockResolvedValue({
        detected: true,
        running: true,
        version: '4.1.15.56',
        executablePath: 'C:\\Wechat\\Weixin.exe'
      }),
      launch: vi.fn().mockResolvedValue(undefined),
      probe: vi.fn().mockResolvedValue(null),
      wait: vi.fn().mockResolvedValue(undefined)
    }
    const service = new WechatHookComponentService(runtime)
    expect(await service.startWithHook()).toMatchObject({ success: false, needsWechatClosed: true })
    runtime.probeWechat.mockResolvedValue({
      detected: true,
      running: false,
      version: '4.1.15.55',
      executablePath: 'C:\\Wechat\\Weixin.exe'
    })
    expect(await service.startWithHook()).toMatchObject({ success: false })
    expect(runtime.launch).not.toHaveBeenCalled()
  })
})

describe('微信版本与注入方式', () => {
  it('4.1.15 及以上需要进程注入，之前的版本仍可用目录代理', () => {
    expect(requiresProcessInjection('4.1.15.56')).toBe(true)
    expect(requiresProcessInjection('4.1.16.3')).toBe(true)
    expect(requiresProcessInjection('4.1.10.27')).toBe(false)
    expect(requiresProcessInjection('3.9.10.16')).toBe(false)
    expect(requiresProcessInjection('4.0.0.30')).toBe(false)
    expect(requiresProcessInjection(undefined)).toBe(false)
  })
})
