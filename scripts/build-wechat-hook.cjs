#!/usr/bin/env node
/**
 * 为本机微信版本编译 WeChat-Hook 的 version.dll。
 *
 * 流程：
 *   1. 拉取 hook 源码（默认 handking-xie/WeChatHook4.1.15.55，aixed/WeChat-Hook 的 4.1.15 分支）；
 *   2. 读本机 Weixin.dll 的 PE 头（TimeDateStamp / SizeOfImage），改写源码里的版本校验常量，
 *      让 hook 能识别本机这一个 build；
 *   3. 用 VS Build Tools 的 MSBuild 编译 x64\Release\version.dll；
 *   4. 输出 DLL 路径、大小、sha256，并提示「未在目标版本上验证过」。
 *
 * 用法：
 *   node scripts/build-wechat-hook.cjs
 *   node scripts/build-wechat-hook.cjs --repo https://github.com/xxx/yyy.git --out build/hook
 *
 * 前提：已安装 VS Build Tools（Microsoft.VisualStudio.2022.BuildTools，含 VCTools 工作负载）。
 */
const { execFileSync, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const repoUrl = arg('repo', 'https://github.com/handking-xie/WeChatHook4.1.15.55.git')
const outDir = path.resolve(ROOT, arg('out', 'build/wechat-hook'))
const workDir = path.join(os.tmpdir(), 'tracememo-wechat-hook-src')

function fail(message) {
  console.error(`[build:wechat-hook] ${message}`)
  process.exit(1)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false })
  if (result.status !== 0) fail(`${command} 执行失败（退出码 ${result.status}）`)
}

/** 找 VS Build Tools 的 MSBuild。 */
function findMSBuild() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MS' +
      'Build.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MS' +
      'Build.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MS' +
      'Build.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MS' +
      'Build.exe'
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

/** 找本机微信的 Weixin.dll，返回 { path, version, timestamp, sizeOfImage }。 */
function findLocalWeixinDll() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @()
$key = 'HKCU:\\Software\\Tencent\\Weixin'
$p = (Get-ItemProperty -Path $key).InstallPath
if ($p) { $roots += $p }
$roots += 'C:\\Program Files\\Tencent\\Weixin'
$roots += 'D:\\Program Files\\Tencent\\Weixin'
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  $dll = Get-ChildItem -Path $root -Filter 'Weixin.dll' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dll) { Write-Output $dll.FullName; break }
}
`
  let output = ''
  try {
    output = String(
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
      ) || ''
    ).trim()
  } catch {
    output = ''
  }
  const dllPath = output
    .split(/\r?\n/)
    .find((line) => line.trim().toLowerCase().endsWith('weixin.dll'))
  if (!dllPath) return null
  const buffer = fs.readFileSync(dllPath.trim())
  const peOffset = buffer.readUInt32LE(0x3c)
  const version = path.basename(path.dirname(dllPath.trim()))
  return {
    path: dllPath.trim(),
    version,
    timestamp: buffer.readUInt32LE(peOffset + 8),
    sizeOfImage: buffer.readUInt32LE(peOffset + 0x50)
  }
}

/** 把源码里的 image_timestamp / image_size 换成本机实际值。 */
function patchConstants(srcDir, weixin) {
  const files = [
    'include/LoginStatusMemory.h',
    'include/SelfProfileMemory.h',
    'include/ProfileMemory.h'
  ]
  let patched = 0
  for (const relative of files) {
    const file = path.join(srcDir, relative)
    if (!fs.existsSync(file)) continue
    let text = fs.readFileSync(file, 'utf8')
    const before = text
    text = text.replace(
      /image_timestamp\s*=\s*0x[0-9A-Fa-f]+/g,
      `image_timestamp = 0x${weixin.timestamp.toString(16).toUpperCase()}`
    )
    text = text.replace(
      /image_size\s*=\s*0x[0-9A-Fa-f]+/g,
      `image_size = 0x${weixin.sizeOfImage.toString(16).toUpperCase()}`
    )
    if (text !== before) {
      fs.writeFileSync(file, text, 'utf8')
      patched += 1
    }
  }
  return patched
}

const msbuild = findMSBuild()
if (!msbuild) {
  fail(
    '没找到 MSBuild。请先安装 VS Build Tools：' +
      'winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
  )
}

const weixin = findLocalWeixinDll()
if (!weixin) fail('没有找到本机微信的 Weixin.dll，无法确定版本校验常量')
console.log(`[build:wechat-hook] 本机 Weixin.dll：${weixin.path}（版本目录 ${weixin.version}）`)
console.log(
  `[build:wechat-hook] PE 校验值：timestamp=0x${weixin.timestamp
    .toString(16)
    .toUpperCase()} size=0x${weixin.sizeOfImage.toString(16).toUpperCase()}`
)

if (!fs.existsSync(path.join(workDir, '.git'))) {
  fs.rmSync(workDir, { recursive: true, force: true })
  console.log(`[build:wechat-hook] 拉取源码 ${repoUrl}`)
  run('git', ['clone', '--depth', '1', repoUrl, workDir])
} else {
  console.log('[build:wechat-hook] 复用已有源码目录')
}

const patched = patchConstants(workDir, weixin)
console.log(`[build:wechat-hook] 已改写 ${patched} 个文件的版本校验常量`)

run(
  msbuild,
  [
    path.join(workDir, 'x64_Version_dll.vcxproj'),
    '/m',
    '/t:Build',
    '/p:Configuration=Release',
    '/p:Platform=x64',
    '/v:minimal',
    '/nologo'
  ],
  workDir
)

const built = path.join(workDir, 'x64', 'Release', 'version.dll')
if (!fs.existsSync(built)) fail('编译没有产出 version.dll')

fs.mkdirSync(outDir, { recursive: true })
const target = path.join(outDir, `version-${weixin.version}.dll`)
fs.copyFileSync(built, target)
const buffer = fs.readFileSync(target)
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
console.log(`[build:wechat-hook] 产物：${path.relative(ROOT, target)}`)
console.log(`[build:wechat-hook] 大小 ${buffer.length} 字节｜sha256 ${sha256}`)
console.log(
  '[build:wechat-hook] 注意：这份 DLL 只按本机 Weixin.dll 的 PE 校验值适配过，' +
    '内部 RVA 是否匹配没有验证，注入到不匹配的微信会让微信崩溃'
)
console.log(
  `[build:wechat-hook] 内置命令：pnpm add:wechat-hook "${target}" --version ${weixin.version}`
)
