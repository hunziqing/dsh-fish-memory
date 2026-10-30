# 独立伴随记忆服务契约包

当前交付仅为阶段一：领域数据结构、六工具输入输出契约、候选补丁、SQLite 初始迁移草案、状态与归档约束，以及人工合成验证样本。

本分支不启动服务、不创建运行数据、不调用模型。持久化运行、MCP、自动整理、归档及聊天页面在后续阶段交付。原 DSH 插件未改动。

- [完整开发方案](../docs/独立伴随记忆服务开发方案.md)
- [阶段一契约与验收](./docs/阶段一契约与验收.md)
- [生成的 JSON Schema](./contracts/schema-bundle.json)
- [SQLite 初始迁移草案](./contracts/database/001-initial.sql)
- [合成对话和逐步期望](./fixtures/conversations.generated.json)
- [合成 DSH 导入样本](./fixtures/dsh-import.generated.json)

使用 Node.js 24.19.0，在本目录执行：

```powershell
npm ci --ignore-scripts
npm run check
```

`check` 执行类型检查、生成物漂移检查与 54 项契约、状态和内存 SQL 测试；不用真实模型、DSH、密钥或个人记忆。

修改 Schema 或合成样本后运行：

```powershell
npm run schemas:write
npm run check
```

不要手工修改 `*.generated.json` 或 `contracts/schema-bundle.json`。它们分别由 `fixtures/scenarios.ts` 和 `src/` 中的 Schema 导出。详细字段、证据与版本语义见阶段文档。
