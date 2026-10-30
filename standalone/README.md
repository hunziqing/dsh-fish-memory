# 独立伴随记忆服务

当前已实现阶段一至五：独立 CLI、SQLite、事务、任务、备份恢复、六工具、HTTP/stdio、聊天钩子，以及显式配置的后台经历抽取、情绪时序修订、本次回应需要和条件交流模式。

用户已确认不接入第三方人物仓库，将提供自己的聊天页面。默认关闭模型调用，启用后后台会整理已保存回合；没有密钥时只保存任务。中文索引、旧资料导入、真实归档和聊天页面仍按后续阶段交付。原 DSH 插件未改动。

- [完整开发方案](../docs/独立伴随记忆服务开发方案.md)
- [阶段一契约与验收](./docs/阶段一契约与验收.md)
- [阶段二运行与验收](./docs/阶段二运行与验收.md)
- [阶段三 MCP 与聊天边界](./docs/阶段三MCP与聊天边界.md)
- [阶段四 DeepSeek 动态整理](./docs/阶段四DeepSeek动态整理.md)
- [阶段五 情绪与交流习惯](./docs/阶段五情绪与交流习惯.md)
- [生成的 JSON Schema](./contracts/schema-bundle.json)
- [SQLite 初始迁移草案](./contracts/database/001-initial.sql)
- [合成对话和逐步期望](./fixtures/conversations.generated.json)
- [合成 DSH 导入样本](./fixtures/dsh-import.generated.json)

使用 Node.js 24.19.0，在本目录执行：

```powershell
npm ci --ignore-scripts
npm run check
```

`check` 执行类型检查、生成物漂移检查、全部测试与构建。运行测试使用系统临时文件库和子进程；不用真实模型、DSH、密钥或个人记忆。

初始化与启动（在本目录，默认使用用户目录下的 `.fish-companion`）：

```powershell
npm run cli -- init
npm run cli -- serve
```

另开终端执行 `npm run cli -- status` 或 `npm run cli -- stop`。用 `--home '绝对路径'` 或 `FISH_MEMORY_HOME` 指定独立数据目录；服务以前台方式运行，不安装自动启动。令牌保存到运行目录的 admin-token，CLI 不打印令牌。详细权限、备份恢复命令和当前限制见阶段二文档。

修改 Schema 或合成样本后运行：

```powershell
npm run schemas:write
npm run check
```

不要手工修改 `*.generated.json` 或 `contracts/schema-bundle.json`。它们分别由 `fixtures/scenarios.ts` 和 `src/` 中的 Schema 导出。详细字段、证据与版本语义见阶段文档。
