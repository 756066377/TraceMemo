#include "login-status-route.h"
#include "global.h"
#include "SendTextMsg.h"
#include "SendImageMsg.h"
#include <atomic>
#include <iostream>
#include <stdexcept>
#include <thread>

HMODULE g_hWeixinDll = nullptr;
static std::atomic<int> text_calls{ 0 }, image_calls{ 0 };
namespace WeixinSend {
void SendText(const std::string&, const std::string&) { ++text_calls; }
void SendImage(const std::string&, const std::string&) { ++image_calls; }
void DecodePic(const std::string&, const std::string&) {}
}

static void Check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

struct Image {
    unsigned char* memory = static_cast<unsigned char*>(
        VirtualAlloc(nullptr, wechat_login::image_size, MEM_RESERVE, PAGE_READWRITE));
    uintptr_t base = reinterpret_cast<uintptr_t>(memory);
    uintptr_t manager = base + wechat_login::image_size - 0x4000;
    uintptr_t account = base + wechat_login::image_size - 0x2000;
    uintptr_t identifier = account + 0x400;

    template<class T> void Put(uintptr_t address, const T& value) {
        Check(VirtualAlloc(reinterpret_cast<void*>(address & ~uintptr_t(4095)),
            4096, MEM_COMMIT, PAGE_READWRITE) != nullptr, "commit fixture page");
        std::memcpy(reinterpret_cast<void*>(address), &value, sizeof(value));
    }

    Image() {
        Check(memory != nullptr, "reserve fixture image");
        IMAGE_DOS_HEADER dos{}; dos.e_magic = IMAGE_DOS_SIGNATURE; dos.e_lfanew = 0x100;
        IMAGE_NT_HEADERS64 nt{};
        nt.Signature = IMAGE_NT_SIGNATURE;
        nt.FileHeader.Machine = IMAGE_FILE_MACHINE_AMD64;
        nt.FileHeader.TimeDateStamp = wechat_login::image_timestamp;
        nt.OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC;
        nt.OptionalHeader.SizeOfImage = wechat_login::image_size;
        Put(base, dos); Put(base + 0x100, nt);
        Put(base + 0x45D10, std::array<unsigned char, 8>{ 0x48, 0x8B, 0x05, 0x89, 0xD2, 0xB4, 0x0B, 0xC3 });
        Put(base + 0x389A50, std::array<unsigned char, 7>{ 0x0F, 0xB6, 0x41, 0x38, 0x24, 0x01, 0xC3 });
        Put(base + wechat_login::manager_rva, manager);
        Put(manager, base + wechat_login::manager_vtable_rva);
        Put(manager + wechat_login::account_member, account);
        Put(account, base + wechat_login::account_vtable_rva);
        Put(base + wechat_login::account_vtable_rva, base + 0x389A50);
        SetFlag(1);
        struct Header { uintptr_t pointer; uint64_t padding, length, capacity; };
        constexpr char wxid[] = "wxid_native_fixture_001";
        Put(identifier, wxid);
        Put(account + wechat_login::wxid_member, Header{ identifier, 0, sizeof(wxid) - 1, 31 });
    }
    void SetFlag(unsigned char flag) { Put(account + wechat_login::login_member, flag); }
    wechat_login::Status Read() { return wechat_login::Read(GetCurrentProcess(), base); }
    ~Image() { if (memory) VirtualFree(memory, 0, MEM_RELEASE); }
};

static int RunFixture() {
    Image image;
    Check(image.Read().state == 1, "logged in");
    image.SetFlag(3); Check(image.Read().state == 1, "unrelated flag bits");
    image.SetFlag(2); Check(image.Read().state == 0, "logout with unrelated flag bit");
    image.SetFlag(0); Check(image.Read().state == 0, "logged out");
    image.SetFlag(1);
    image.Put(image.account + wechat_login::wxid_member + 16, uint64_t(0));
    Check(image.Read().state == -1, "empty identifier is unknown");
    image.Put(image.account + wechat_login::wxid_member + 16, uint64_t(22));
    image.Put(image.account + wechat_login::wxid_member + 16, uint64_t(5000));
    Check(image.Read().state == -1, "oversized identifier");
    image.Put(image.account + wechat_login::wxid_member + 16, uint64_t(22));
    image.Put(image.identifier, static_cast<unsigned char>(0xFF));
    Check(image.Read().state == -1, "invalid UTF-8");
    image.Put(image.identifier, static_cast<unsigned char>('w'));
    image.Put(image.account, uintptr_t(0));
    Check(image.Read().state == -1, "vtable mismatch");
    image.Put(image.account, image.base + wechat_login::account_vtable_rva);
    image.Put(image.manager + wechat_login::account_member, uintptr_t(0));
    Check(image.Read().state == -1, "null account");
    image.Put(image.manager + wechat_login::account_member, image.account);
    image.Put(image.base + wechat_login::manager_rva, uintptr_t(1));
    Check(image.Read().state == -1, "unreadable manager");
    image.Put(image.base + wechat_login::manager_rva, image.manager);
    image.Put(image.base + 0x100 + offsetof(IMAGE_NT_HEADERS64, FileHeader) +
        offsetof(IMAGE_FILE_HEADER, TimeDateStamp), DWORD(0));
    Check(image.Read().state == -1, "wrong image build");
    image.Put(image.base + 0x100 + offsetof(IMAGE_NT_HEADERS64, FileHeader) +
        offsetof(IMAGE_FILE_HEADER, TimeDateStamp), wechat_login::image_timestamp);
    image.Put(image.base + 0x389A50, static_cast<unsigned char>(0x90));
    Check(image.Read().state == -1, "getter signature mismatch");
    image.Put(image.base + 0x389A50, static_cast<unsigned char>(0x0F));
    Check(image.Read().state == 1, "restored fixture");

    g_hWeixinDll = reinterpret_cast<HMODULE>(image.base);
    httplib::Server server;
    wechat_login::RegisterStatus(server, image.base);
    Route_SendTextMsg(server);
    Route_SendImageMsg(server);
    const int port = server.bind_to_any_port("127.0.0.1");
    Check(port > 0, "bind test server");
    std::thread worker([&server] { server.listen_after_bind(); });
    try {
        httplib::Client client("127.0.0.1", port);
        client.set_connection_timeout(2);
        client.set_read_timeout(2);
        auto status = [&client] {
            auto response = client.Get("/QueryDB/status");
            Check(response && response->status == 200, "HTTP status response");
            return nlohmann::json::parse(response->body);
        };
        Check(status()["IsLogin"] == 1, "HTTP logged in");
        auto text = client.Post("/SendTextMsg", R"({"wxidorgid":"fixture","msg":"test"})", "application/json");
        Check(text && text->status == 503 && text_calls == 0, "logged-in text suspended before native call");
        auto picture = client.Post("/SendImgMsg", R"({"wxidorgid":"fixture","path":"fixture.png"})", "application/json");
        Check(picture && picture->status == 503 && image_calls == 0, "logged-in image suspended before native call");
        Check(status()["sendReady"] == false, "status reports sending suspended");
        image.SetFlag(0);
        Check(status()["loginState"] == "logged_out", "HTTP logout transition");
        text = client.Post("/SendTextMsg", R"({"wxidorgid":"fixture","msg":"test"})", "application/json");
        picture = client.Post("/SendImgMsg", R"({"wxidorgid":"fixture","path":"fixture.png"})", "application/json");
        Check(text && text->status == 409 && text_calls == 0, "logged-out text blocked");
        Check(picture && picture->status == 409 && image_calls == 0, "logged-out image blocked");
        image.SetFlag(1);
        Check(status()["IsLogin"] == 1, "HTTP relogin transition");
        image.Put(image.base + wechat_login::manager_rva, uintptr_t(0));
        auto unknown = status();
        Check(unknown["IsLogin"] == -1 && unknown["loginState"] == "unknown" &&
            unknown["ret"] == -1, "HTTP unavailable is unknown");
        text = client.Post("/SendTextMsg", R"({"wxidorgid":"fixture","msg":"test"})", "application/json");
        Check(text && text->status == 409 && text_calls == 0, "unknown text blocked");
        picture = client.Post("/SendImgMsg", R"({"wxidorgid":"fixture","path":"fixture.png"})", "application/json");
        Check(picture && picture->status == 409 && image_calls == 0, "unknown image blocked");
    } catch (...) {
        server.stop(); worker.join(); throw;
    }
    server.stop(); worker.join();
    std::cout << "{\"nativeFixtures\":\"passed\",\"httpTransitions\":\"passed\",\"sendGuards\":\"passed\"}\n";
    return 0;
}

int main(int argc, char** argv) {
    try {
        if (argc == 4 && std::string(argv[1]) == "--live") {
            HANDLE process = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_LIMITED_INFORMATION,
                FALSE, static_cast<DWORD>(std::stoul(argv[2])));
            Check(process != nullptr, "open read-only target");
            auto status = wechat_login::Read(process, static_cast<uintptr_t>(std::stoull(argv[3], nullptr, 0)));
            CloseHandle(process);
            std::cout << wechat_login::ToJson(status).dump() << "\n";
            return status.state < 0 ? 1 : 0;
        }
        return RunFixture();
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\n"; return 1;
    }
}
