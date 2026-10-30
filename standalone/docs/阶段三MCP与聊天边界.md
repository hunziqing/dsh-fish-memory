# 阶段三：MCP 与自有聊天入口边界

版本：0.3.0；领域契约仍为 1.0.0。

## 交付范围

服务提供 `/mcp` 标准 Streamable HTTP 和 `mcp-stdio` 桥接。使用官方 TypeScript SDK，固定 server 2.4.0、client 2.4.0 和 node 2.1.2，兼容 SDK 的现代协议及旧版无会话 Streamable HTTP。桥接不打开第二个 SQLite 写入口。

六个工具都进入同一存储服务：recall_context、observe_turn、get_episode、correct_memory、set_memory_preference、retract_memory。MCP 外壳由 SDK 处理，业务结果沿用严格的 `{contract_version,outcome}`。模型默认只用 read 凭据；observe 和 user_edit 凭据供可信聊天入口，admin 供本地管理。工具列表按实际能力过滤，每次调用仍重新检查身份。

本阶段实现自有聊天入口的调用边界和降级逻辑；尚无用户聊天页面、DeepSeek 请求或自动整理。后续阶段实现模型候选和消费任务，最后交付自己的聊天页面。用户已确认不接入第三方人物仓库。

## 使用

在 standalone 目录，初始化并在启动前生成只读令牌：

```powershell
npm run cli -- init --home '你的独立运行目录'
npm run cli -- token-issue --home '你的独立运行目录' --capability read --out '你的独立运行目录/mcp-read-token'
npm run cli -- serve --home '你的独立运行目录'
```

HTTP 客户端连接 service.json 中实际端口的 `http://127.0.0.1:<port>/mcp`，使用 Bearer 凭据。Host 必须匹配回环地址与端口；浏览器调用暂不开放。stdio 客户端配置示意如下，路径需替换为实际绝对路径，JSON 内反斜线需转义：

```json
{
  "mcpServers": {
    "fish-companion": {
      "command": "node",
      "args": ["D:/你的代码目录/standalone/dist/cli.js", "mcp-stdio", "--home", "D:/你的独立运行目录", "--token-file", "D:/你的独立运行目录/mcp-read-token"]
    }
  }
}
```

先执行 npm run build。默认 stdio 令牌文件为运行目录的 mcp-read-token，不默认授予管理权限。stdout 仅写协议，诊断走 stderr。服务没有运行或元数据指向其他实例时桥接失败，不自动另开数据库。

## 真实消息、证据和写操作

观察工具只接收调用方实际保存的可见 user/assistant 消息，不接收 reasoning、系统提示或回忆注入。工具能否看到完整对话取决于可信入口；MCP 不能凭空截取任意客户端聊天。

本阶段支持 main 有效链；编辑须保留逻辑消息、提高变更消息版本并将 chain_revision 加一。旧链候选拒绝提交。其他分支会明确拒绝，不宣称已实现任意宿主分叉。

`POST /host/evidence` 是 user_edit 权限的受限宿主入口，输入 request_id、ref、start、end；服务从已持久化的真实用户消息中自行截取原话，返回不可变证据 ID。调用方不能指定 speaker 或伪造 quote。偏好和纠正工具使用这些证据或已有记忆证据；模型只读令牌不能调用这个入口。

纠正整组 targets、mutations、links 在一次事务里发布，并保存用户编辑输入的不可变审计对象。回执随事务持久化；重放原请求返回首次结果，不因后来版本改变而再次提交。任一目标冲突则整组回滚。

来源撤回只能使用 retract_memory，普通纠正及自动候选不能直接把状态设为 retracted。拆分/合并需令被替代旧记录 disputed，并以关系连接新记录，不能借撤回状态绕过来源屏蔽。所有新发布的有效记忆汇总去重后的证据不超过 128 项，避免写入后读契约无法承载。专用撤回允许保留超出读预算的历史证据，保证旧资料不会因为过大而无法撤回；撤回修订不会进入默认读取或召回。

撤回保存新修订，增长 suppression_generation，停止默认召回；不删除原始对话或声称物理销毁。源消息的屏蔽记录跨修订保留，旧任务即使新建另一个记忆 ID，也不能把相同来源恢复为有效记忆。屏蔽依据是该记忆真正引用的证据，不把同一整理批次中其他事情的全部上下文一起撤回。来源被屏蔽的其他当前投影会进入待重算状态，避免旧索引继续返回。

## 召回与详情

当前提供基础关键词和中文二元片段匹配。正式词典分词、持久词项、人物日期检索和规模优化在阶段六完善。当前仍会加载可信上下文，不把这版基础扫描宣称为大规模性能交付。

只返回当前 active、published 且来源有效的记忆。默认召回去掉 corrected 解释；include_history 可查看理解修订的版本元信息。读取不增加用户有效提及次数，不改变主性格，也不自动让冷内容变热。

max_chars 是序列化资料的码点预算，元信息和证据也计入；另保留 128 KiB 业务包裹字节上限。可截短的概要/详情只取原文前缀，并标记 truncated。无法放入的条目跳过或返回 BUDGET_EXCEEDED，不编造精简后的证据或日期。临时回应规划、观察模式的适用条件将在阶段五实现，当前不自动注入这两类规则。

## 聊天入口钩子

`ConversationHooks` 提供 beforeReply / afterReply / retryOutbox：回答前召回超时返回明确降级状态，聊天可继续；回答后先将原始回合写入宿主 outbox，再提交 observe_turn。失败或超时保留待重试文件，入口重启可用同一请求号与载荷重投。

超时不表示服务器一定未提交。迟到的成功结果不会让适配器虚报已经收到确认；后续重试由持久幂等回执消除副作用。outbox 只保存真实可见回合，不保存注入背景或角色主设定。文件是个人运行数据，必须放在源码仓库外。

## 数据迁移与恢复

新增 003-tool-service.sql：来源消息屏蔽和用户编辑审计对象。001、002 保持已发布字节内容，迁移校验仍检查编号与哈希。构建自动复制全部运行迁移。

新版本备份仍为 inline-only，快照保留屏蔽和审计状态。阶段二的旧备份需用阶段二标签的程序恢复到新目录，再用本版启动完成升级；不回退原数据库的迁移记录，也不使用旧代码直接打开已升级数据库。

阶段恢复标签为 companion-phase-3-v0.3.0，是否已上传以远程标签实际存在为准。验证入口仍为 npm run check，新增正式 SDK 的 HTTP/stdio、六工具、权限、预算、来源屏蔽、钩子超时及 outbox 重启重试测试。

工具目录按凭据固定，不声明 tools/list_changed 订阅；关闭服务时主动关闭仍在处理的 MCP handler，避免长连接阻塞停机。stdio 初始化列工具失败也会关闭远端连接。

本阶段验证：npm run check 全部通过，89 项测试、0 失败；覆盖现代 2026-07-28 与旧版协议客户端、真实 stdio 子进程及六工具。类型、生成物、构建和编译产物备份恢复验证通过。原 DSH 的 24 个基线文件 SHA-256 均未变化。未调用付费模型或接触真实私人记忆。

参考：[官方 SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)、[stdio 工厂入口](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)。
