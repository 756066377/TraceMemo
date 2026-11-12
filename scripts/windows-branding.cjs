/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { readFileSync, writeFileSync, renameSync } = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

// 使用 electron-builder 自身声明的依赖，不依赖本机缓存中的外部资源编辑工具。
const builderRequire = createRequire(require.resolve('app-builder-lib'))
const { NtExecutable, NtExecutableResource, Data, Resource } = builderRequire('resedit')

function editWindowsBranding(executablePath, iconPath, appInfo) {
  // 修改资源会使原签名失效；之后仍由打包器按现有配置决定是否签名。
  const executable = NtExecutable.from(readFileSync(executablePath), { ignoreCert: true })
  const resources = NtExecutableResource.from(executable)
  const icons = Data.IconFile.from(readFileSync(iconPath)).icons.map((entry) => entry.data)
  if (icons.length === 0) throw new Error(`No icon images in ${iconPath}`)
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  for (const group of groups.length ? groups : [{ id: 101, lang: 1033 }]) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons)
  }
  const versions = Resource.VersionInfo.fromEntries(resources.entries)
  for (const version of versions.length ? versions : [Resource.VersionInfo.createEmpty()]) {
    version.setFileVersion(appInfo.version)
    version.setProductVersion(appInfo.version)
    const languages = version.getAllLanguagesForStringValues()
    for (const language of languages.length ? languages : [{ lang: 1033, codepage: 1200 }]) {
      version.setStringValues(language, {
        ProductName: appInfo.productName,
        FileDescription: appInfo.description || appInfo.productName,
        InternalName: path.basename(executablePath, '.exe'),
        OriginalFilename: path.basename(executablePath)
      })
    }
    version.outputToResourceEntries(resources.entries)
  }
  // 仅替换图标和版本信息，保留清单及 Electron 的 ASAR 完整性资源。
  resources.outputResource(executable)
  const temporaryPath = `${executablePath}.branding-tmp`
  writeFileSync(temporaryPath, Buffer.from(executable.generate()))
  renameSync(temporaryPath, executablePath)
}

async function applyWindowsBranding(context) {
  if (
    context.electronPlatformName !== 'win32' ||
    context.packager.platformSpecificBuildOptions.signAndEditExecutable !== false
  ) return
  const appInfo = context.packager.appInfo
  const executableName =
    context.packager.platformSpecificBuildOptions.executableName || appInfo.productFilename
  const iconPath = await context.packager.getIconPath()
  if (!iconPath) throw new Error('Windows application icon is required')
  const executablePath = path.join(context.appOutDir, `${executableName}.exe`)
  editWindowsBranding(executablePath, iconPath, appInfo)
  console.log(`[afterPack] Windows icon and product metadata updated: ${executableName}.exe`)
}

module.exports = { editWindowsBranding, applyWindowsBranding }
