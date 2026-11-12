#pragma once
#include "httplib.h"
#include "login-status.h"
#include "json.hpp"

namespace wechat_login {
inline nlohmann::json ToJson(const Status& status) {
    return {
        { "IsLogin", status.state },
        { "loginState", status.state == 1 ? "logged_in" : status.state == 0 ? "logged_out" : "unknown" },
        { "loginDetection", "account-memory-v1" },
        { "componentBuild", "4.1.15.56-send-suspended-v2" },
        { "sendReady", false },
        { "sendDisabledReason", "native send callback thread context is not validated; sending suspended after crash" },
        { "ret", status.state < 0 ? -1 : 0 },
        { "retmsg", status.error.empty() ? "success" : status.error }
    };
}

inline void RegisterStatus(httplib::Server& server, uintptr_t base, HANDLE process = GetCurrentProcess()) {
    server.Get("/QueryDB/status", [base, process](const httplib::Request&, httplib::Response& response) {
        auto payload = ToJson(Read(process, base));
        payload["hWeixin"] = base;
        response.set_content(payload.dump(), "application/json");
    });
}

inline bool RequireLoggedIn(httplib::Response& response, uintptr_t base) {
    auto status = Read(GetCurrentProcess(), base);
    auto payload = ToJson(status);
    payload["ret"] = -1;
    if (status.state == 1) {
        payload["errorCode"] = "SEND_SUSPENDED";
        payload["retmsg"] = "Sending suspended after native callback crash; no message submitted";
        response.status = 503;
        response.set_content(payload.dump(), "application/json");
        return false;
    }
    if (status.state == 0) payload["retmsg"] = "WeChat account is logged out";
    response.status = 409;
    response.set_content(payload.dump(), "application/json");
    return false;
}
}
