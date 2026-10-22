---
name: minimax-pet
description: 用户要求打开 MiniMax Pet／桌宠或查看任务提醒时，打开 MiniMax Pet。
---

# 打开 MiniMax Pet

调用当前 Host 提供的 `miniapp` 工具，使用以下参数打开已安装的桌宠：

```json
{ "action": "open", "pluginId": "minimax-pet" }
```

仅在工具返回 `ok: true` 且 `result.opened: true` 时报告已打开。工具不可用、插件未安装或打开失败时，说明具体原因；用户可以从 Desktop 的插件管理和 MiniApp 列表检查状态。

用户在页面切换“外观／任务／设置”，并通过“放到桌面”显示桌宠。任务页和桌面通知使用可见会话的只读状态；此 Skill 只负责打开页面，不创建独立聊天，也不向会话发送、停止或代答。
