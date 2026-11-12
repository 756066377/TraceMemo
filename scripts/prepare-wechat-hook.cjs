#!/usr/bin/env node
/**
 * 把 resources/wechat-hook 里的 WeChat-Hook version.dll 整理成可打包状态。
 *
 * 做三件事：
 * 1. 校验 manifest.json 结构（schema=1、components 数组、每项 file/wechatVersions）；
 * 2. 对目录里真实存在的 DLL 计算 sha256 并回填 manifest，PE 位数不是 x64 直接报错；
 * 3. 声明了但文件缺失的组件把 sha256 清空，运行时据此判定「未内置」而不是「校验失败」。
 *
 * 运行时（src/main/services/wechat-hook-component-service.ts）只读 manifest + 文件哈希，
 * 因此 manifest 里的 sha256 必须由本脚本生成，不要手写。
 */
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const HOOK_DIR = path.join(ROOT, 'resources', 'wechat-hook')
const MANIFEST = path.join(HOOK_DIR, 'manifest.json')

function fail(message) {
  console.error(`[prepare:wechat-hook] ${message}`)
  process.exit(1)
}

function readPeMachine(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return 'unknown'
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 6 > buffer.length) return 'unknown'
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return 'unknown'
  const machine = buffer.readUInt16LE(peOffset + 4)
  if (machine === 0x8664) return 'x64'
  if (machine === 0x014c) return 'x86'
  return 'unknown'
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

if (!fs.existsSync(HOOK_DIR)) {
  fs.mkdirSync(HOOK_DIR, { recursive: true })
}
if (!fs.existsSync(MANIFEST)) {
  fail(`缺少 ${path.relative(ROOT, MANIFEST)}`)
}

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
} catch (error) {
  fail(`manifest.json 不是合法 JSON：${error.message}`)
}
if (manifest.schema !== 1 || !Array.isArray(manifest.components)) {
  fail('manifest.json 需要 schema=1 且 components 为数组')
}

const seen = new Set()
let packaged = 0
const missing = []

for (const component of manifest.components) {
  const file = typeof component.file === 'string' ? component.file.trim() : ''
  if (!file) fail('manifest.components[].file 不能为空')
  if (!Array.isArray(component.wechatVersions) || component.wechatVersions.length === 0) {
    fail(`组件 ${file} 缺少 wechatVersions（用 ["*"] 表示不限定版本）`)
  }
  if (seen.has(file)) fail(`组件 ${file} 重复声明`)
  seen.add(file)
  // 只允许目录内的文件名，避免 manifest 指向目录外路径。
  if (path.basename(file) !== file) fail(`组件 ${file} 必须是 resources/wechat-hook 下的文件名`)

  const absolute = path.join(HOOK_DIR, file)
  if (component.loader) {
    const loader = component.loader
    if (typeof loader.file !== 'string' || path.basename(loader.file) !== loader.file) {
      fail(`${file} 的启动器必须是组件目录内的文件名`)
    }
    const loaderPath = path.join(HOOK_DIR, loader.file)
    if (!fs.existsSync(absolute) || !fs.existsSync(loaderPath)) {
      fail(`${file} 缺少配套 DLL 或 ${loader.file}，不能构建完整发送组件`)
    }
    if (readPeMachine(loaderPath) !== 'x64' || sha256(loaderPath) !== loader.sha256) {
      fail(`${loader.file} 架构或哈希不匹配，请核对提供的适配产物`)
    }
    if (sha256(absolute) !== component.sha256) {
      fail(`${file} 哈希不匹配，请核对提供的适配产物`)
    }
  }
  if (!fs.existsSync(absolute)) {
    component.sha256 = ''
    missing.push(file)
    continue
  }
  const machine = readPeMachine(absolute)
  if (machine !== 'x64') {
    fail(`${file} 的 PE Machine 是 ${machine}，微信 4.x 只接受 x64`)
  }
  component.sha256 = sha256(absolute)
  packaged += 1
  console.log(
    `[prepare:wechat-hook] ${file} x64 ${(fs.statSync(absolute).size / 1024).toFixed(1)}KB ` +
      `sha256=${component.sha256.slice(0, 12)}… 适用 ${component.wechatVersions.join(',')}`
  )
}

// 原子写：先写临时文件再替换，避免构建中途被读到半截 manifest。
const tmp = `${MANIFEST}.tmp`
fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
fs.renameSync(tmp, MANIFEST)

if (missing.length > 0) {
  console.warn(
    `[prepare:wechat-hook] 未内置：${missing.join(', ')}（安装包里不会有该组件，用户可在设置页手动导入）`
  )
}
console.log(`[prepare:wechat-hook] 完成，内置组件 ${packaged} 个`)
