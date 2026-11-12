import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * 把 DLL 注入到运行中的微信主进程。
 *
 * 为什么需要它：微信 4.1.15 起会把 version.dll 解析到 C:\Windows\System32，
 * 放在微信安装目录的同名文件不会被加载（进程模块列表里能看到加载的是系统那份），
 * 所以「拷文件 + 重启微信」这条老路在 4.1.x 上不成立。
 * 直接把 DLL 注入进微信进程，hook 会在进程内启动 HTTP 服务（wechat4-hook 默认 30001）。
 *
 * 实现走 kernel32 的 OpenProcess / VirtualAllocEx / WriteProcessMemory /
 * CreateRemoteThread + LoadLibraryW，和常见的进程注入器一致。
 */

export interface WechatInjectionResult {
  success: boolean
  error?: string
  /** 被注入的进程 id。 */
  pid?: number
  /** 远程 LoadLibrary 返回的模块地址（十六进制），仅用于排查。 */
  moduleAddress?: string
}

const PROCESS_ALL_ACCESS = 0x001fffff
const MEM_COMMIT_RESERVE = 0x3000
const PAGE_EXECUTE_READWRITE = 0x40

interface Kernel32Bindings {
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown
  VirtualAllocEx: (
    process: unknown,
    address: unknown,
    size: number,
    allocType: number,
    protect: number
  ) => unknown
  WriteProcessMemory: (
    process: unknown,
    address: unknown,
    buffer: Buffer,
    size: number,
    written: unknown,
    writtenSame: unknown
  ) => boolean
  GetModuleHandle: (name: string) => unknown
  GetProcAddress: (module: unknown, name: string) => unknown
  CreateRemoteThread: (
    process: unknown,
    attributes: unknown,
    stackSize: number,
    startAddress: unknown,
    parameter: unknown,
    creationFlags: number,
    threadId: unknown
  ) => unknown
  WaitForSingleObject: (handle: unknown, milliseconds: number) => number
  GetExitCodeThread: (thread: unknown, exitCode: unknown) => boolean
  CloseHandle: (handle: unknown) => boolean
}

let cached: Kernel32Bindings | null = null

/** koffi.alloc 的返回可能是 ArrayBuffer 或 TypedArray，两种都能读。 */
function readU64(target: unknown): bigint {
  if (target instanceof ArrayBuffer) return new BigUint64Array(target)[0]
  if (ArrayBuffer.isView(target)) return (target as BigUint64Array)[0]
  return 0n
}

function kernel32(): Kernel32Bindings | null {
  if (cached) return cached
  try {
    // koffi 是项目既有依赖（key-service-win 用它读微信内存）。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const lib = koffi.load('kernel32.dll')
    cached = {
      OpenProcess: lib.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32']),
      VirtualAllocEx: lib.func('VirtualAllocEx', 'void*', [
        'void*',
        'void*',
        'size_t',
        'uint32',
        'uint32'
      ]),
      WriteProcessMemory: lib.func('WriteProcessMemory', 'bool', [
        'void*',
        'void*',
        'void*',
        'size_t',
        'void*',
        'void*'
      ]),
      GetModuleHandle: lib.func('GetModuleHandleA', 'void*', ['char*']),
      GetProcAddress: lib.func('GetProcAddress', 'void*', ['void*', 'char*']),
      CreateRemoteThread: lib.func('CreateRemoteThread', 'void*', [
        'void*',
        'void*',
        'size_t',
        'void*',
        'void*',
        'uint32',
        'void*'
      ]),
      WaitForSingleObject: lib.func('WaitForSingleObject', 'uint32', ['void*', 'uint32']),
      GetExitCodeThread: lib.func('GetExitCodeThread', 'bool', ['void*', 'void*']),
      CloseHandle: lib.func('CloseHandle', 'bool', ['void*'])
    }
    return cached
  } catch (error) {
    console.error('[WechatInjector] 加载 kernel32 失败:', error)
    return null
  }
}

/**
 * 找微信主进程。
 *
 * 微信会拉起一堆子进程（--type=wxocr / wxutility / wxpublic / xplayer …），
 * hook 的 dllmain 只在主进程初始化，子进程会自己卸载，所以必须按命令行挑主进程。
 */
export async function findWechatMainProcess(): Promise<number | null> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'"
foreach ($p in $procs) {
  $cmd = $p.CommandLine
  if (-not $cmd) { continue }
  if ($cmd -like '*--type=*') { continue }
  if ($cmd -like '*--crashpad-handler*') { continue }
  Write-Output $p.ProcessId
  break
}
`
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }
    )
    const pid = Number.parseInt(String(stdout || '').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 把 DLL 注入指定进程；同步执行，失败返回原因。 */
export function injectDllIntoProcess(pid: number, dllPath: string): WechatInjectionResult {
  const api = kernel32()
  if (!api) return { success: false, error: '无法调用 Windows 注入接口' }

  const handle = api.OpenProcess(PROCESS_ALL_ACCESS, true, pid)
  if (!handle) return { success: false, error: `打不开微信进程（pid ${pid}）` }

  try {
    // LoadLibraryW 需要 UTF-16 路径。
    const wide = Buffer.from(`${dllPath}\0`, 'utf16le')
    const remote = api.VirtualAllocEx(
      handle,
      null,
      wide.length,
      MEM_COMMIT_RESERVE,
      PAGE_EXECUTE_READWRITE
    )
    if (!remote) return { success: false, error: '在微信进程里分配内存失败' }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const written = koffi.alloc('uint32', 1)
    if (!api.WriteProcessMemory(handle, remote, wide, wide.length, written, written)) {
      return { success: false, error: '写入 DLL 路径失败' }
    }

    const kernel32Handle = api.GetModuleHandle('kernel32.dll')
    const loadLibrary = api.GetProcAddress(kernel32Handle, 'LoadLibraryW')
    if (!loadLibrary) return { success: false, error: '找不到 LoadLibraryW' }

    const threadId = koffi.alloc('uint64', 1)
    const thread = api.CreateRemoteThread(handle, null, 0, loadLibrary, remote, 0, threadId)
    if (!thread) return { success: false, error: '创建远程线程失败' }

    api.WaitForSingleObject(thread, 15_000)
    const exitCode = koffi.alloc('uint64', 1) as unknown
    api.GetExitCodeThread(thread, exitCode)
    const moduleAddress = readU64(exitCode)
    api.CloseHandle(thread)
    if (moduleAddress === 0n) {
      return { success: false, error: '微信进程拒绝加载该 DLL（LoadLibrary 返回 0）' }
    }
    return { success: true, pid, moduleAddress: `0x${moduleAddress.toString(16)}` }
  } catch (error) {
    return {
      success: false,
      error: `注入异常：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    api.CloseHandle(handle)
  }
}
