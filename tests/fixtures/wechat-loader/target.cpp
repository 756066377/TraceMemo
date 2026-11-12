#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>

int wmain() {
    wchar_t executable[MAX_PATH]{};
    GetModuleFileNameW(nullptr, executable, MAX_PATH);
    std::wstring directory(executable);
    directory.resize(directory.find_last_of(L"\\/") + 1);
    if (!LoadLibraryW((directory + L"Weixin.dll").c_str())) return 1;
    Sleep(3000);
    return 0;
}
