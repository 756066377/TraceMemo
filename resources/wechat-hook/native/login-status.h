#pragma once
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <utility>

// Verified against the 4.1.15.56 native getters and a read-only live account snapshot.
namespace wechat_login {
inline constexpr DWORD image_timestamp = 0x6AD083C8;
inline constexpr DWORD image_size = 0xC34F000;
inline constexpr uintptr_t manager_rva = 0xBB92FA0;
inline constexpr uintptr_t manager_vtable_rva = 0x8F514E8;
inline constexpr uintptr_t account_vtable_rva = 0x8FD1468;
inline constexpr uintptr_t account_member = 0x68;
inline constexpr uintptr_t login_member = 0x38;
inline constexpr uintptr_t wxid_member = 0x48;

struct Status {
    // -1 means unknown, 0 means confirmed logged out, 1 means confirmed logged in.
    int state = -1;
    std::string error;
};

inline bool ReadBytes(HANDLE process, uintptr_t address, void* target, size_t size) {
    SIZE_T copied = 0;
    return address && ReadProcessMemory(process, reinterpret_cast<const void*>(address),
        target, size, &copied) && copied == size;
}

template<class T> inline bool ReadValue(HANDLE process, uintptr_t address, T& value) {
    return ReadBytes(process, address, &value, sizeof(value));
}

inline bool ReadWxid(HANDLE process, uintptr_t address, std::string& out) {
    struct Header { unsigned char storage[16]; uint64_t length, capacity; } before{}, after{};
    if (!ReadValue(process, address, before) || before.length == 0 || before.length > 256 ||
        before.capacity < before.length || before.capacity < 15 || before.capacity > 1024 * 1024)
        return false;
    std::string value(static_cast<size_t>(before.length), '\0');
    if (before.capacity == 15) {
        if (before.length > 15) return false;
        std::memcpy(value.data(), before.storage, value.size());
    } else {
        uintptr_t data = 0;
        std::memcpy(&data, before.storage, sizeof(data));
        if (!ReadBytes(process, data, value.data(), value.size())) return false;
    }
    if (!ReadValue(process, address, after) || std::memcmp(&before, &after, sizeof(before)) ||
        value.find('\0') != std::string::npos ||
        !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), nullptr, 0)) return false;
    out = std::move(value);
    return true;
}

inline Status Read(HANDLE process, uintptr_t base) {
    IMAGE_DOS_HEADER dos{};
    IMAGE_NT_HEADERS64 nt{};
    if (!ReadValue(process, base, dos) || dos.e_magic != IMAGE_DOS_SIGNATURE ||
        dos.e_lfanew <= 0 || dos.e_lfanew > 0x100000 ||
        !ReadValue(process, base + dos.e_lfanew, nt) || nt.Signature != IMAGE_NT_SIGNATURE ||
        nt.FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
        nt.FileHeader.TimeDateStamp != image_timestamp || nt.OptionalHeader.SizeOfImage != image_size)
        return { -1, "unsupported Weixin.dll build; expected 4.1.15.56" };

    // Validate the native manager getter and login-bit getter, without invoking either.
    constexpr std::array<unsigned char, 8> manager_code{ 0x48, 0x8B, 0x05, 0x89, 0xD2, 0xB4, 0x0B, 0xC3 };
    constexpr std::array<unsigned char, 7> login_code{ 0x0F, 0xB6, 0x41, 0x38, 0x24, 0x01, 0xC3 };
    std::array<unsigned char, 8> actual_manager{};
    std::array<unsigned char, 7> actual_login{};
    if (!ReadValue(process, base + 0x45D10, actual_manager) || actual_manager != manager_code ||
        !ReadValue(process, base + 0x389A50, actual_login) || actual_login != login_code)
        return { -1, "native login getter signature mismatch" };

    uintptr_t manager = 0, manager_table = 0, account = 0, table = 0, getter = 0;
    unsigned char flag = 0;
    if (!ReadValue(process, base + manager_rva, manager) || !manager ||
        !ReadValue(process, manager, manager_table) || manager_table != base + manager_vtable_rva ||
        !ReadValue(process, manager + account_member, account) || !account ||
        !ReadValue(process, account, table) || table != base + account_vtable_rva ||
        !ReadValue(process, table, getter) || getter != base + 0x389A50 ||
        !ReadValue(process, account + login_member, flag))
        return { -1, "account unavailable or native layout mismatch" };

    const bool logged_in = (flag & 1) != 0;
    std::string wxid, confirmed_wxid;
    if (logged_in && !ReadWxid(process, account + wxid_member, wxid))
        return { -1, "logged-in account identifier unreadable" };

    uintptr_t manager_after = 0, manager_table_after = 0, account_after = 0, table_after = 0;
    unsigned char flag_after = 0;
    if (!ReadValue(process, base + manager_rva, manager_after) || manager_after != manager ||
        !ReadValue(process, manager, manager_table_after) || manager_table_after != manager_table ||
        !ReadValue(process, manager + account_member, account_after) || account_after != account ||
        !ReadValue(process, account, table_after) || table_after != table ||
        !ReadValue(process, account + login_member, flag_after) || ((flag_after ^ flag) & 1) ||
        (logged_in && (!ReadWxid(process, account + wxid_member, confirmed_wxid) || confirmed_wxid != wxid)))
        return { -1, "account changed during login check; retry" };
    return { logged_in ? 1 : 0, {} };
}
}
