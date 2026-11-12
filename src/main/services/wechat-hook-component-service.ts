import { app } from 'electron'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import path from 'path'
import { promisify } from 'util'

import type {
  WechatHookComponentStatus,
  WechatHookDllInfo,
  WechatHookInstallResult
} from '../../shared/personal-wechat'
import { findResource } from '../resource-paths'
import { probeHook, probeProtocol } from './windows-wechat-hook'
import { findWechatMainProcess, injectDllIntoProcess } from './wechat-hook-injector'
import { appLogger } from '../app-logger'

const execFileAsync = promisify(execFile)

const COMPONENT_FILE = 'version.dll'
const BACKUP_SUFFIX = '.tracememo-bak'
const MANIFEST_FILE = 'manifest.json'
const IMPORT_META_FILE = 'meta.json'

/** Keep the loader's required module name without overwriting an installed WeChat DLL. */
export function stageWechatHookDll(source: string, expectedHash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash) || safeHash(source) !== expectedHash) {
    throw new Error('发送组件校验失败，请重新准备配套组件')
  }
  const directory = path.join(userComponentDir(), 'launch', expectedHash)
  const target = path.join(directory, COMPONENT_FILE)
  mkdirSync(directory, { recursive: true })
  if (safeHash(target) !== expectedHash) copyFileSync(source, target)
  if (readPeMachine(target) !== 'x64' || safeHash(target) !== expectedHash) {
    throw new Error('启动组件副本校验失败')
  }
  return target
}

export function describeWechatLoaderError(error: unknown): string {
  const detail = error as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown }
  const output = [detail?.stdout, detail?.stderr]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join('\n')
    .trim()
    .slice(-2000)
  if (detail?.killed)
    return `启动器等待超时，请先检测30001端口，确认微信状态后再试${output ? `：${output}` : ''}`
  if (detail?.code === 'EACCES' || detail?.code === 'EPERM') {
    return '启动器访问被拒绝，请检查组件是否被安全软件拦截，以及当前用户是否有执行权限'
  }
  return output ? `启动器退出（${String(detail?.code ?? '未知')}）：${output}` : toMessage(error)
}

/** manifest 里的一条组件声明：文件名 + 适用微信版本 + 期望哈希。 */
export interface WechatHookManifestComponent {
  file: string
  /** 具体版本号，或 '*' 表示未声明版本（需用户显式强制才注入）。 */
  wechatVersions: string[]
  sha256?: string
  /** 组件下载地址，用于在界面上核对来源。 */
  source?: string
  loader?: { file: string; sha256: string }
}

export interface WechatHookManifest {
  schema: number
  components: WechatHookManifestComponent[]
}

/** manifest 缺失或损坏时的兜底：目录里放什么 version.dll 就用什么，但视为未验证版本。 */
const FALLBACK_MANIFEST: WechatHookManifest = {
  schema: 1,
  components: [{ file: COMPONENT_FILE, wechatVersions: ['*'] }]
}

function userComponentDir(): string {
  return path.join(app.getPath('userData'), 'wechat-hook')
}

function userComponentPath(): string {
  return path.join(userComponentDir(), COMPONENT_FILE)
}

function userComponentMetaPath(): string {
  return path.join(userComponentDir(), IMPORT_META_FILE)
}

/**
 * 安装包内置目录：打包后 resources/resources/wechat-hook，开发时 <repo>/resources/wechat-hook。
 * 用统一的资源根解析，避免打包路径多一层 resources 时找错位置。
 */
function bundledComponentDir(): string {
  const manifest = findResource(path.join('wechat-hook', MANIFEST_FILE))
  return manifest ? path.dirname(manifest) : ''
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/**
 * 读 PE 头的 Machine 字段判断位数。
 * 微信 4.x 是 x64，塞错位数会在加载时直接失败，提前拦住比事后排查便宜。
 */
export function readPeMachine(filePath: string): 'x64' | 'x86' | 'unknown' {
  try {
    const buffer = readFileSync(filePath)
    if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return 'unknown'
    const peOffset = buffer.readUInt32LE(0x3c)
    if (peOffset + 6 > buffer.length) return 'unknown'
    if (buffer.readUInt32LE(peOffset) !== 0x00004550) return 'unknown'
    const machine = buffer.readUInt16LE(peOffset + 4)
    if (machine === 0x8664) return 'x64'
    if (machine === 0x014c) return 'x86'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 读内置 manifest；结构不合法时退回兜底声明，不让设置页整页失败。 */
export function readHookManifest(): WechatHookManifest {
  const dir = bundledComponentDir()
  if (!dir) return FALLBACK_MANIFEST
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return FALLBACK_MANIFEST
    const components = (parsed as { components?: unknown }).components
    if (!Array.isArray(components)) return FALLBACK_MANIFEST
    const normalized: WechatHookManifestComponent[] = []
    for (const item of components) {
      if (!item || typeof item !== 'object') continue
      const raw = item as {
        file?: unknown
        wechatVersions?: unknown
        sha256?: unknown
        source?: unknown
        loader?: { file?: unknown; sha256?: unknown }
      }
      const file = typeof raw.file === 'string' ? raw.file.trim() : ''
      // 只接受目录内的文件名，manifest 指向目录外一律忽略。
      if (!file || path.basename(file) !== file) continue
      const versions = Array.isArray(raw.wechatVersions)
        ? raw.wechatVersions.filter((value): value is string => typeof value === 'string')
        : []
      if (versions.length === 0) continue
      normalized.push({
        file,
        wechatVersions: versions,
        sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
        source: typeof raw.source === 'string' ? raw.source : '',
        ...(typeof raw.loader?.file === 'string' &&
        path.basename(raw.loader.file) === raw.loader.file &&
        typeof raw.loader.sha256 === 'string'
          ? { loader: { file: raw.loader.file, sha256: raw.loader.sha256 } }
          : {})
      })
    }
    return normalized.length > 0 ? { schema: 1, components: normalized } : FALLBACK_MANIFEST
  } catch {
    return FALLBACK_MANIFEST
  }
}

/**
 * 按当前微信版本选内置组件：精确版本优先，其次通配 '*'。
 * 同一台机器可能装了多个微信版本，选错 DLL 会导致微信启动即崩。
 */
export function pickBundledComponent(
  manifest: WechatHookManifest,
  wechatVersion: string | undefined
): (WechatHookManifestComponent & { path: string }) | null {
  const dir = bundledComponentDir()
  if (!dir) return null
  const available = manifest.components
    .map((component) => ({ ...component, path: path.join(dir, component.file) }))
    .filter((component) => existsSync(component.path))
  const exact = wechatVersion
    ? available.find((component) => component.wechatVersions.includes(wechatVersion))
    : undefined
  if (exact) return exact
  return available.find((component) => component.wechatVersions.includes('*')) || null
}

function readImportedMeta(): { sha256?: string; wechatVersions: string[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(userComponentMetaPath(), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const raw = parsed as { sha256?: unknown; wechatVersions?: unknown }
    const versions = Array.isArray(raw.wechatVersions)
      ? raw.wechatVersions.filter((value): value is string => typeof value === 'string')
      : []
    return {
      sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
      wechatVersions: versions
    }
  } catch {
    return null
  }
}

function writeImportedMeta(meta: { sha256: string; wechatVersions: string[] }): void {
  mkdirSync(userComponentDir(), { recursive: true })
  const target = userComponentMetaPath()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

async function runPowerShell(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
    )
    return String(stdout || '').trim()
  } catch {
    return ''
  }
}

interface WechatProbe {
  detected: boolean
  version?: string
  installDir?: string
  executablePath?: string
  processName?: string
  running: boolean
}

/**
 * 读微信版本与安装目录。
 *
 * 顺序：运行中的进程路径 → 注册表安装路径。进程能拿到时版本最准
 * （用户可能装了多个版本/多个目录）。
 */
export async function probeWechat(): Promise<WechatProbe> {
  if (process.platform !== 'win32') return { detected: false, running: false }
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @('Weixin','WeChat')
$procs = @(Get-Process -Name $names)
$proc = $procs | Where-Object { $_.Modules.ModuleName -contains 'Weixin.dll' } | Select-Object -First 1
if (-not $proc) { $proc = $procs | Select-Object -First 1 }
$out = @{}
if ($proc) {
  $out.running = $true
  $out.processName = $proc.ProcessName
  $out.path = $proc.Path
}
if (-not $out.path) {
  $keys = @('HKCU:\\Software\\Tencent\\Weixin','HKCU:\\Software\\Tencent\\WeChat','HKLM:\\SOFTWARE\\WOW6432Node\\Tencent\\WeChat','HKLM:\\SOFTWARE\\Tencent\\Weixin')
  foreach ($k in $keys) {
    $v = (Get-ItemProperty -Path $k).InstallPath
    if ($v) { $out.path = (Join-Path $v 'Weixin.exe'); break }
  }
}
if ($out.path) {
  $exe = $out.path
  if (-not (Test-Path $exe)) {
    $dir = Split-Path $out.path -Parent
    $cand = @('Weixin.exe','WeChat.exe') | ForEach-Object { Join-Path $dir $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($cand) { $exe = $cand }
  }
  if (Test-Path $exe) {
    $out.exe = $exe
    $out.version = (Get-Item $exe).VersionInfo.FileVersion
    $module = $proc.Modules | Where-Object { $_.ModuleName -eq 'Weixin.dll' } | Select-Object -First 1
    if ($module) {
      $out.version = (Get-Item $module.FileName).VersionInfo.FileVersion
    } else {
      $modules = @(Get-ChildItem -LiteralPath (Split-Path $exe -Parent) -Filter Weixin.dll -Recurse -ErrorAction SilentlyContinue)
      if ($modules.Count -eq 1) { $out.version = $modules[0].VersionInfo.FileVersion }
      elseif ($modules.Count -gt 1) { $out.version = 'unknown' }
    }
  }
}
$out.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
`
  const output = await runPowerShell(script)
  const map = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    map.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  const exe = map.get('exe')
  const version = map.get('version')
  if (!exe || !version) return { detected: false, running: map.get('running') === 'True' }
  return {
    detected: true,
    version: version.replace(/\s+/g, ''),
    installDir: path.dirname(exe),
    executablePath: exe,
    processName: map.get('processName') || path.basename(exe, '.exe'),
    running: map.get('running') === 'True'
  }
}

/**
 * 微信 4.1.15 起不再从安装目录加载 version.dll：进程里加载的是 C:\Windows\System32 那份，
 * 所以「把 DLL 拷进微信目录 + 重启」拿不到发送接口，必须进程内注入。
 * 判断依据是版本号的第三段（4.1.15.x 之后）。
 */
export function requiresProcessInjection(version: string | undefined): boolean {
  const parts = String(version || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return false
  if (parts[0] !== 4) return false
  return parts[1] > 1 || (parts[1] === 1 && parts[2] >= 15)
}

export class WechatHookComponentService {
  constructor(
    private readonly runtime = {
      probeWechat,
      launch: async (loader: string, args: string[]): Promise<void> => {
        await execFileAsync(loader, args, {
          windowsHide: true,
          cwd: path.dirname(args[0]),
          timeout: 90_000,
          maxBuffer: 1024 * 1024
        })
      },
      probe: () => probeProtocol('wechat4-hook', '127.0.0.1:30001', 800),
      wait: () => new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
  ) {}

  private starting = false

  async startWithHook(): Promise<WechatHookInstallResult> {
    const steps: string[] = []
    if (this.starting) return { success: false, error: '正在启动，请稍候', steps }
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      return { success: false, error: '需要 Windows x64', steps }
    }
    this.starting = true
    try {
      const wechat = await this.runtime.probeWechat()
      if (wechat.version !== '4.1.15.56' || !wechat.executablePath) {
        return { success: false, error: '仅支持微信 4.1.15.56，请核对安装版本', steps }
      }
      const existing = await this.runtime.probe()
      if (existing) {
        return {
          success: true,
          port: '30001',
          loggedIn: existing.loggedIn,
          steps: [
            existing.loggedIn
              ? '已有发送接口，微信已登录'
              : '已有发送接口，组件尚未确认登录；可检测并保存端口'
          ]
        }
      }
      if (wechat.running) {
        return {
          success: false,
          needsWechatClosed: true,
          error: '请先手动退出微信，再点击启动微信并连接',
          steps
        }
      }
      const bundle = pickBundledComponent(readHookManifest(), wechat.version)
      const loaderPath = bundle?.loader
        ? path.join(path.dirname(bundle.path), bundle.loader.file)
        : ''
      if (
        !bundle?.sha256 ||
        !bundle.loader ||
        !loaderPath ||
        readPeMachine(bundle.path) !== 'x64' ||
        readPeMachine(loaderPath) !== 'x64' ||
        safeHash(bundle.path) !== bundle.sha256 ||
        safeHash(loaderPath) !== bundle.loader.sha256
      ) {
        return {
          success: false,
          error: '配套组件或启动器缺失、损坏，请重新准备微信发送组件',
          steps
        }
      }
      const launchDll = stageWechatHookDll(bundle.path, bundle.sha256)
      let launchError: unknown
      try {
        await this.runtime.launch(loaderPath, [wechat.executablePath, launchDll])
        steps.push('已通过配套启动器启动微信')
      } catch (error) {
        launchError = error
        appLogger.write({
          level: 'warn',
          scope: 'wechat-hook',
          message: '配套启动器返回异常，复核本地接口',
          details: { error: describeWechatLoaderError(error) }
        })
      }
      for (let index = 0; index < 20; index++) {
        const result = await this.runtime.probe()
        if (result) {
          if (launchError) steps.push('启动器返回异常，但已确认发送接口可访问')
          steps.push(
            result.loggedIn
              ? '微信已登录，可以检测并保存端口'
              : '接口已连接，可检测并保存端口；组件尚未确认登录'
          )
          return { success: true, steps, port: '30001', loggedIn: result.loggedIn }
        }
        await this.runtime.wait()
      }
      return {
        success: false,
        error: launchError
          ? describeWechatLoaderError(launchError)
          : '微信已启动，但发送接口未响应。请核对版本、运行库及组件加载情况',
        steps
      }
    } catch (error) {
      return { success: false, error: `启动失败：${describeWechatLoaderError(error)}`, steps }
    } finally {
      this.starting = false
    }
  }

  async getStatus(): Promise<WechatHookComponentStatus> {
    const wechat = await this.runtime.probeWechat()
    const reasons: string[] = []
    const manifest = readHookManifest()

    // 不让旧导入组件遮挡当前版本的配套组件。
    const importedPath = userComponentPath()
    const importedFileExists = existsSync(importedPath)
    const importedMeta = importedFileExists ? readImportedMeta() : null
    const matchingBundle = pickBundledComponent(manifest, wechat.version)
    const importedExists =
      importedFileExists &&
      (Boolean(importedMeta?.wechatVersions.includes(wechat.version || '')) || !matchingBundle)
    const bundled = importedExists ? null : matchingBundle

    const dllPath = importedExists ? importedPath : (bundled?.path ?? '')
    // 导入组件没有版本声明时视为未验证，需要用户勾选强制。
    const dllVersions = importedExists
      ? (importedMeta?.wechatVersions ?? [])
      : (bundled?.wechatVersions ?? [])

    let dll: WechatHookDllInfo | undefined
    if (dllPath) {
      try {
        const machine = readPeMachine(dllPath)
        const actualHash = sha256(dllPath)
        dll = {
          path: dllPath,
          size: statSync(dllPath).size,
          sha256: actualHash,
          machine,
          source: importedExists ? 'imported' : 'bundled',
          wechatVersions: dllVersions,
          ...(bundled?.source ? { origin: bundled.source } : {})
        }
        if (machine !== 'x64') reasons.push('组件不是 x64，微信 4.x 无法加载')
        if (bundled?.sha256 && bundled.sha256 !== actualHash) {
          reasons.push('内置组件哈希与 manifest 不一致，请重新运行 pnpm prepare:wechat-hook')
        }
        if (importedExists && importedMeta?.sha256 && importedMeta.sha256 !== actualHash) {
          reasons.push('导入组件在磁盘上被改动过，建议重新导入')
        }
      } catch {
        reasons.push('组件文件无法读取')
      }
    } else {
      reasons.push('还没有可用的 Hook 组件（安装包未内置，也没有导入）')
    }

    const installedPath = wechat.installDir ? path.join(wechat.installDir, COMPONENT_FILE) : ''
    const installedExists = Boolean(installedPath && existsSync(installedPath))
    const installedMatchesComponent = Boolean(
      installedExists && dll && safeHash(installedPath) === dll.sha256
    )
    const backupExists = Boolean(
      wechat.installDir && existsSync(path.join(wechat.installDir, COMPONENT_FILE + BACKUP_SUFFIX))
    )

    if (!wechat.detected) reasons.push('没有找到本机微信（Weixin.exe）')

    // 版本清单来自 manifest 与导入记录，不再硬编码，换 DLL 时不用改代码。
    const supportedVersions = Array.from(
      new Set(
        [
          ...manifest.components.flatMap((component) => component.wechatVersions),
          ...(importedMeta?.wechatVersions ?? [])
        ].filter((version) => version && version !== '*')
      )
    ).sort()

    const versionSupported = Boolean(wechat.version && dllVersions.includes(wechat.version))
    if (wechat.detected && dll && !versionSupported) {
      reasons.push(
        wechat.version
          ? `组件适用 ${dllVersions.filter((v) => v !== '*').join('、') || '未声明版本'}，与当前微信 ${wechat.version} 不一致：可以按对应版本重新导入，或勾选强制注入`
          : '没有读到微信版本，无法判断组件是否匹配'
      )
    }
    if (wechat.running) reasons.push('微信正在运行，替换 DLL 前需要先退出微信')
    if (requiresProcessInjection(wechat.version)) {
      reasons.push('微信 4.1.15+ 请先退出微信，再用「启动微信并连接」加载配套组件')
    }

    return {
      platform: process.platform,
      wechat,
      ...(dll ? { dll } : {}),
      installed: installedExists,
      installedMatchesComponent,
      backupExists,
      supportedVersions,
      versionSupported,
      canInject: Boolean(
        dll && wechat.detected && versionSupported && !wechat.running && reasons.length === 0
      ),
      reasons
    }
  }

  /**
   * 导入用户自备的 version.dll（校验 PE 位数后存到 userData）。
   *
   * 只有哈希与版本清单相符才记录适用版本；导入动作不能证明版本兼容。
   */
  async importDll(sourcePath: string): Promise<{ success: boolean; error?: string }> {
    const source = String(sourcePath || '').trim()
    if (!source || !existsSync(source)) return { success: false, error: '找不到所选文件' }
    if (path.extname(source).toLowerCase() !== '.dll') {
      return { success: false, error: '请选择 version.dll 文件' }
    }
    const machine = readPeMachine(source)
    if (machine === 'unknown') return { success: false, error: '不是有效的 PE 文件' }
    if (machine !== 'x64') return { success: false, error: '组件不是 x64，微信 4.x 无法加载' }
    try {
      mkdirSync(userComponentDir(), { recursive: true })
      copyFileSync(source, userComponentPath())
      const hash = sha256(userComponentPath())
      writeImportedMeta({
        sha256: hash,
        wechatVersions:
          readHookManifest().components.find((item) => item.sha256 === hash)?.wechatVersions || []
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: `写入组件失败：${toMessage(error)}` }
    }
  }

  /**
   * 一步到位：导入选定的 DLL 并立刻注入微信目录。
   *
   * 用户视角就是「点一下 → 选文件 → 装好」，中间不再需要第二次点击。
   * 微信在运行会先退出（DLL 被占用时无法覆盖），退出失败就停在导入这一步。
   */
  async importAndInstall(
    sourcePath: string,
    options: { force?: boolean } = {}
  ): Promise<WechatHookInstallResult> {
    const imported = await this.importDll(sourcePath)
    if (!imported.success) {
      return { success: false, error: imported.error || '导入组件失败', steps: [] }
    }
    const steps = ['组件已保存到用户目录']
    const status = await this.getStatus()
    if (requiresProcessInjection(status.wechat.version)) {
      return {
        success: false,
        error: '此微信版本请使用配套启动器，不能通过目录安装加载组件',
        steps
      }
    }
    if (status.wechat.running) {
      const closed = await this.closeWechat()
      if (!closed.success) {
        return {
          success: false,
          error: closed.error || '微信还在运行，请手动退出后再注入',
          steps
        }
      }
      steps.push('已退出微信')
    }
    const result = await this.install(options)
    return {
      success: result.success,
      error: result.error,
      steps: [...steps, ...result.steps]
    }
  }

  /**
   * 注入到正在运行的微信进程（不重启微信）。
   *
   * 微信 4.1.15 起不再加载安装目录里的 version.dll（进程里加载的是 System32 那份），
   * 所以「拷文件 + 重启」拿不到发送接口；这里直接走进程注入把组件塞进微信，
   * hook 在进程内启动 HTTP 服务（wechat4-hook 默认 30001）。
   */
  async injectRunningWechat(options: { force?: boolean } = {}): Promise<{
    success: boolean
    error?: string
    steps: string[]
    /** 注入成功并探测到的服务端口。 */
    port?: string
  }> {
    const steps: string[] = []
    const status = await this.getStatus()
    if (requiresProcessInjection(status.wechat.version)) {
      return { success: false, error: '此微信版本请先退出微信，再使用「启动微信并连接」', steps }
    }
    if (!status.dll) return { success: false, error: '没有可用的 Hook 组件', steps }
    if (!status.wechat.running) {
      return { success: false, error: '微信没有运行，请先启动并登录微信', steps }
    }
    // 版本不匹配的组件会让 hook 打到错误地址，微信会直接崩，先拦住。
    if (!status.versionSupported && !options.force) {
      const declared = status.dll.wechatVersions.filter((version) => version !== '*').join('、')
      return {
        success: false,
        error: `组件适用 ${declared || '未声明版本'}，与当前微信 ${status.wechat.version || '未知'} 不一致：版本不匹配的 hook 会让微信崩溃，确认要试请勾选「版本不匹配也强制尝试」`,
        steps
      }
    }
    const installedPath = status.wechat.installDir
      ? path.join(status.wechat.installDir, COMPONENT_FILE)
      : ''
    const target =
      status.installedMatchesComponent && installedPath ? installedPath : status.dll.path
    const pid = await findWechatMainProcess()
    if (!pid) return { success: false, error: '没有找到正在运行的微信主进程', steps }
    steps.push(`已定位微信主进程 pid=${pid}`)
    const result = injectDllIntoProcess(pid, target)
    if (!result.success) {
      return { success: false, error: result.error || '注入失败', steps }
    }
    steps.push(
      `已注入 ${target}${result.moduleAddress ? `（模块地址 ${result.moduleAddress}）` : ''}`
    )

    // hook 需要一点时间把 HTTP 服务拉起来。
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const probe = await probeHook('127.0.0.1:30001')
    if (!probe) {
      steps.push('注入完成，但 30001 端口没有响应')
      return {
        success: false,
        error: '注入完成但 hook 没有起来：可能组件与当前微信版本不匹配',
        steps
      }
    }
    steps.push(
      `hook 已就绪：${probe.protocol}${probe.loggedIn ? '（微信已登录）' : '（微信未登录）'}`
    )
    if (!probe.loggedIn) {
      steps.push('接口可访问，但 hook 报告未登录：确认微信已登录；版本不匹配时读取会是空值')
    }
    return { success: true, steps, port: '30001' }
  }

  /**
   * 注入 = 把 DLL 放到微信安装目录并改名为 version.dll。
   *
   * 微信必须已退出（DLL 被占用时无法覆盖）；如果目录里已有别人的 version.dll，
   * 先备份成 version.dll.tracememo-bak，卸载时原样还原。
   * 版本不匹配时默认拒绝，需要调用方显式 force。
   */
  async install(options: { force?: boolean } = {}): Promise<WechatHookInstallResult> {
    const status = await this.getStatus()
    const steps: string[] = []
    if (requiresProcessInjection(status.wechat.version)) {
      return { success: false, error: '此微信版本不支持目录安装，请使用「启动微信并连接」', steps }
    }
    if (!status.dll) return { success: false, error: '没有可用的 Hook 组件', steps }
    if (status.dll.machine !== 'x64') {
      return { success: false, error: '组件不是 x64，无法注入微信 4.x', steps }
    }
    if (!status.wechat.installDir) {
      return { success: false, error: '没有定位到微信安装目录', steps }
    }
    if (status.wechat.running) {
      return { success: false, error: '微信正在运行，请先退出微信', needsWechatClosed: true, steps }
    }
    if (!status.versionSupported && !options.force) {
      return {
        success: false,
        error: status.wechat.version
          ? `微信 ${status.wechat.version} 不在组件的适用版本（${status.dll.wechatVersions.join('、') || '未声明'}）`
          : '没有读到微信版本，无法确认组件匹配',
        steps
      }
    }

    const target = path.join(status.wechat.installDir, COMPONENT_FILE)
    const backup = target + BACKUP_SUFFIX
    try {
      if (existsSync(target)) {
        const current = safeHash(target)
        if (current === status.dll.sha256) {
          steps.push('组件已是最新，无需重复写入')
          return { success: true, steps }
        }
        if (!existsSync(backup)) {
          renameSync(target, backup)
          steps.push('已备份原有 version.dll → version.dll.tracememo-bak')
        } else {
          steps.push('已有备份，保留最早那一份')
        }
      }
      copyFileSync(status.dll.path, target)
      steps.push(`已写入 ${target}`)
      steps.push('重启微信后发送接口才会生效')
      if (requiresProcessInjection(status.wechat.version)) {
        steps.push(
          '注意：微信 4.1.15+ 不会加载安装目录里的 version.dll，还要用「注入到运行中的微信」'
        )
      }
      return { success: true, steps }
    } catch (error) {
      return { success: false, error: `写入失败：${toMessage(error)}`, steps }
    }
  }

  /** 卸载：删掉我们的 DLL，并把备份还原回去。 */
  async uninstall(): Promise<{ success: boolean; error?: string; steps: string[] }> {
    const wechat = await probeWechat()
    const steps: string[] = []
    if (!wechat.installDir) return { success: false, error: '没有定位到微信安装目录', steps }
    if (wechat.running) {
      return { success: false, error: '微信正在运行，请先退出微信再卸载', steps }
    }
    const target = path.join(wechat.installDir, COMPONENT_FILE)
    const backup = target + BACKUP_SUFFIX
    try {
      if (existsSync(target)) {
        rmSync(target, { force: true })
        steps.push('已移除 version.dll')
      }
      if (existsSync(backup)) {
        renameSync(backup, target)
        steps.push('已还原原有 version.dll')
      }
      return { success: true, steps }
    } catch (error) {
      return { success: false, error: `卸载失败：${toMessage(error)}`, steps }
    }
  }

  /** 退出微信（用户点按钮才调用），用于替换 DLL。 */
  async closeWechat(): Promise<{ success: boolean; error?: string }> {
    const probe = await probeWechat()
    if (!probe.running) return { success: true }
    const output = await runPowerShell(
      `Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue | Stop-Process -Force; 'done'`
    )
    if (!output.includes('done')) return { success: false, error: '关闭微信失败，请手动退出' }
    return { success: true }
  }
}

function safeHash(filePath: string): string {
  try {
    return sha256(filePath)
  } catch {
    return ''
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const wechatHookComponentService = new WechatHookComponentService()
