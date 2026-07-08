# ZCode 插件（用于 Claude Code）

[English](README.md) · [简体中文](README.zh-CN.md)

在 **Claude Code** 里调用 **ZCode** 做代码审查，或把任务委派给 ZCode。

本项目移植自 OpenAI 的 [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)。
Codex 插件的架构是 `{引擎}-plugin-{宿主}`：Codex 引擎 + Claude Code 宿主。本项目保留
**Claude Code 宿主**，把**引擎从 Codex 换成 ZCode**——所以斜杠命令变成了 `/zcode:review`、
`/zcode:rescue` 等。宿主集成层（Claude Code 的插件约定、hooks、`${CLAUDE_PLUGIN_ROOT}`
token）保持不变；只有与编码引擎对话的引擎层被重写，改说 **ZCode Protocol**。

## 你能得到什么

- `/zcode:review` —— 对当前 git 状态做只读 ZCode 审查
- `/zcode:adversarial-review` —— 可引导的对抗式审查
- `/zcode:rescue`、`/zcode:transfer`、`/zcode:status`、`/zcode:result`、`/zcode:cancel` —— 委派任务、交接会话、管理后台作业
- `/zcode:setup` —— 检查 ZCode 是否就绪，可选开启停止时审查门禁
- 一个 `zcode:zcode-rescue` 子代理

## 环境要求

- **Claude Code**（这是 Claude Code 插件，即宿主）
- **ZCode CLI 已安装并登录**（即引擎）。用 `zcode --version` 和 `zcode login` 验证。
  - ZCode 自带运行时，无需 `npm install` 任何东西。
- **Node.js 18.18 或更高**

## 安装（在 Claude Code 里）

### 从本地目录安装

如果你已在本地检出本仓库：

```
/plugin marketplace add /zcode-plugin-cc 的绝对路径
```

### 从 GitHub 安装

```
/plugin marketplace add <你的-github-用户名>/zcode-plugin-cc
```

### 然后执行

安装插件：

```
/plugin install zcode@zcode-plugin-cc
```

重载插件，然后运行：

```
/reload-plugins
/zcode:setup
```

`/zcode:setup` 会报告 ZCode 是否就绪。如果 ZCode 已安装但未登录：

```
!zcode login
```

第一次简单试用：

```
/zcode:rescue 2+2 等于几？只回复数字。
```

## 已验证状态

已在 ZCode 0.15.0 + Claude Code 2.1.201 下端到端验证：

| 检查项 | 结果 |
|---|---|
| `/zcode:setup --json` | `ready: true`，ZCode 0.15.0，已登录 |
| `/zcode:rescue`（完整 ZCode turn） | 回答正确，exit 0 |
| `zcode:zcode-rescue` 子代理 | 出现在 `/agents`，可通过 `Agent` 工具调用 |
| 后台任务 + `/zcode:status` + `/zcode:result` | running → completed，结果已返回 |
| review 上下文采集（git diff） | 正常 |

## 用法

### `/zcode:review`

对当前改动做只读 ZCode 审查（默认审查未提交改动；`--base <ref>` 审查分支）。支持 `--wait`
和 `--background`。

```
/zcode:review
/zcode:review --base main
/zcode:review --background
```

### `/zcode:adversarial-review`

**可引导的**对抗式审查，质疑所选实现与设计。目标选择与 `/zcode:review` 相同，flags 之后可加
关注文本。只读。

```
/zcode:adversarial-review
/zcode:adversarial-review --base main 质疑这个缓存和重试设计是否合理
/zcode:adversarial-review --background 找竞态条件
```

### `/zcode:rescue`

把任务交给 ZCode（排查 bug、尝试修复、继续上一个任务）。支持 `--background`、`--wait`、
`--resume`、`--fresh`。

```
/zcode:rescue 排查为什么测试开始失败
/zcode:rescue --resume 应用上一次运行的最佳修复
/zcode:rescue --background 排查这个回归
```

### `/zcode:transfer`

把当前 Claude Code 会话作为上下文种子创建一个 ZCode 会话，并打印 `zcode --resume <session-id>`
命令。

```
/zcode:transfer
/zcode:transfer --source ~/.claude/projects/<...>/<id>.jsonl
```

> 注意：ZCode 的 app-server 没有 session-import RPC，所以会把之前的 Claude 对话作为上下文
> 种子到一个新的 ZCode 会话里（按摘要种子，而非逐轮回放）。用 `zcode --resume <session-id>`
> 续接。

### `/zcode:status`、`/zcode:result`、`/zcode:cancel`

```
/zcode:status                 # 当前仓库的活动与最近的 ZCode 作业
/zcode:status task-abc123
/zcode:result                 # 已完成作业的最终存储输出
/zcode:cancel                 # 取消一个进行中的后台作业
```

### `/zcode:setup`

```
/zcode:setup
/zcode:setup --enable-review-gate
/zcode:setup --disable-review-gate
```

## 引擎工作原理

Codex 原版通过一个长驻 broker 进程与 `codex app-server`（一个 JSON-RPC 服务器）通信。本移植
以同样方式与 **`zcode app-server`** 通信。ZCode Protocol 是从 `zcode` 0.15.0 逆向出来的，与
Codex 有三处关键差异：

| 维度 | Codex app-server | ZCode Protocol |
|---|---|---|
| **消息格式** | JSON-RPC 2.0（`{jsonrpc,id,method,params}`） | `{id,method,params}` —— **没有 `jsonrpc` 字段**（带了会被拒） |
| **握手** | `initialize` / `initialized` | 无握手——连上即用，首调 `session/create` |
| **方法** | `thread/*`、`turn/*`、`review/*` | `session/*`（`session/create`、`session/send`、`session/read`、`session/resume`、`session/stop`、`session/list`） |

一个 ZCode turn 是**发射后不管**的：`session/send` 立即返回 `{accepted:true}`，真正的执行通过
`state.updated` 通知异步进行，直到 `reason === "prompt_completed"`。随后助手文本从
`session/read` 的 `messages[].parts[]`（`type:"text"`）中读取。

ZCode 没有原生 reviewer，所以 `/zcode:review` 会采集 git diff 并作为一个只读 turn 运行审查
（与 Codex 插件对抗式审查的做法相同）。

### 已知限制

- `/zcode:review` 可能较慢（ZCode 没有原生 reviewer，会对采集到的 git diff 跑只读 turn）。对
  非微小改动建议用 `--background`。
- `/zcode:transfer` 是把 Claude 对话摘要后种子到一个新 ZCode 会话，而非逐轮回放（ZCode 的
  app-server 不提供 session-import RPC）。
- ZCode 续接会话时若提示"历史模型已不可用"（会话所用模型被下线），请新开一个会话。

## 许可证

Apache-2.0（与上游 `openai/codex-plugin-cc` 相同）。见 `LICENSE`。
