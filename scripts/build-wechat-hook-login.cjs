// Build only the explicitly supplied local source and independently verified Weixin image.
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`)
  return path.resolve(process.argv[index + 1])
}
const source = option('source')
const weixin = option('weixin')
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const expectedWeixin = 'e0428a7b691853de496532523c2c09aa095f90941c37c9f4cfb3f137f3c66556'
if (process.platform !== 'win32' || hash(weixin) !== expectedWeixin) {
  throw new Error(
    'This login reader only supports the independently verified Weixin.dll 4.1.15.56 image'
  )
}
const native = path.join(root, 'resources/wechat-hook/native')
const patch = path.join(native, 'integration.patch')
const project = path.join(source, 'x64_Version_dll.vcxproj')
if (!existsSync(project)) throw new Error('Local WeChat-Hook project not found')
const check = spawnSync('git', ['apply', '--check', patch], { cwd: source, windowsHide: true })
if (check.status === 0) {
  execFileSync('git', ['apply', patch], { cwd: source, windowsHide: true })
} else {
  const applied = spawnSync('git', ['apply', '--reverse', '--check', patch], {
    cwd: source,
    windowsHide: true
  })
  if (applied.status !== 0)
    throw new Error('Source does not match the reviewed route patch; refusing to overwrite it')
}
for (const file of ['login-status.h', 'login-status-route.h']) {
  const target = path.join(source, 'include', file)
  if (existsSync(target) && hash(target) !== hash(path.join(native, file))) {
    throw new Error(`Local ${file} differs from the reviewed reader`)
  }
  copyFileSync(path.join(native, file), target)
}
execFileSync(
  process.execPath,
  [path.join(root, 'scripts/test-wechat-hook-login.cjs'), '--source', source],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 150000
  }
)

const output = path.join(root, 'output/wechat-hook-validation/component')
const intermediate = path.join(output, 'obj')
mkdirSync(intermediate, { recursive: true })
const msbuild =
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe'
execFileSync(
  msbuild,
  [
    project,
    '/m',
    '/t:Build',
    '/p:Configuration=Release',
    '/p:Platform=x64',
    '/p:PlatformToolset=v143',
    `/p:OutDir=${output}${path.sep}`,
    `/p:IntDir=${intermediate}${path.sep}`,
    '/v:minimal',
    '/nologo'
  ],
  { cwd: source, stdio: 'inherit', windowsHide: true, timeout: 240000 }
)
const built = path.join(output, 'version.dll')
const binary = readFileSync(built)
const pe = binary.readUInt32LE(0x3c)
if (
  binary.readUInt16LE() !== 0x5a4d ||
  binary.readUInt32LE(pe) !== 0x4550 ||
  binary.readUInt16LE(pe + 4) !== 0x8664
)
  throw new Error('Build did not produce an x64 DLL')
const manifestFile = path.join(root, 'resources/wechat-hook/manifest.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const entry = manifest.components.find((item) => item.file === 'version-4.1.15.56.dll')
if (!entry?.loader) throw new Error('Matching bundle with verified loader is required')
const bundled = path.join(root, 'resources/wechat-hook', entry.file)
if (existsSync(bundled) && !existsSync(path.join(output, 'before-login-fix.dll'))) {
  copyFileSync(bundled, path.join(output, 'before-login-fix.dll'))
}
copyFileSync(built, bundled)
entry.sha256 = hash(built)
entry.source = '本地 WeChat-Hook 4.1.15.56，保留登录检测；原生回调崩溃修复验证前暂停发送'
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(
  path.join(output, 'provenance.json'),
  `${JSON.stringify(
    {
      weixinSha256: expectedWeixin,
      componentSha256: entry.sha256,
      componentBuild: '4.1.15.56-send-suspended-v2',
      integrationPatchSha256: hash(patch),
      readerSha256: hash(path.join(native, 'login-status.h')),
      routesSha256: hash(path.join(native, 'login-status-route.h')),
      sourceFiles: Object.fromEntries(
        ['src/QueryDB.cpp', 'src/SendTextMsg.cpp', 'src/SendImageMsg.cpp'].map((file) => [
          file,
          hash(path.join(source, file))
        ])
      )
    },
    null,
    2
  )}\n`
)
console.log(`[wechat-login] Built and bundled ${bundled}\nSHA256 ${entry.sha256}`)
