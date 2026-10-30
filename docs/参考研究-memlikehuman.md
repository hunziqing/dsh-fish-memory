# MemLikeHuman 长期记忆设计研究

研究对象：[xeonphi1/memlikehuman](https://github.com/xeonphi1/memlikehuman)。固定版本：`0fcf8865e9381580c562ba79717625d58d4a5b5c`。本记录基于 README、架构、MCP 契约、关键源码及测试的静态阅读，没有运行其测试或性能基准。

## 核心结论

它最值得借鉴的是“保存完整日记，控制每次想起时呈现什么”。原文先写入本机 SQLite，模型再提炼有来源的记忆；久远经历默认呈现 gist，精确细节仍可按需读取。时间淡忘改变排序和展示，没有按年龄自动删掉日记。

它当前的 archive 是 JSON / JSONL 数据导出和 SQLite 备份，不是 zstd 尘封压缩包。因此它能为本项目的概览层和按需恢复提供参考，不能替代我们计划中的无损压缩、成员校验和自动解压。

## 已核实的实现

| 机制 | 实际行为 | 代码出处 |
| --- | --- | --- |
| 原文先持久化 | record 先保存 event，再尝试提炼；未配置或提炼失败保留 pending | [Engine.record/process](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/engine.py#L45) |
| 来源和角色 | source_quote 必须是来源原文片段，basis 与 user/assistant 角色分别校验；不能以助手表达冒充用户陈述 | [validate_evidence](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/store.py#L313) |
| 淡忘视图 | episode、observation、emotion 可随年龄呈现 gist；事实、偏好等保持详细；默认约 180 天出概览、730 天显示较粗时间 | [render_memory](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/presentation.py#L52) |
| 概览回退 | 优先提炼时保存的 gist；缺少时只给明确标记的主题线索，不把截断句子冒充完整事实 | [topic_gist](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/presentation.py#L22) |
| 按需详情 | gist 返回 details_available 和 memory_read 提示；读工具分页取原文，详细召回可跳过模糊视图 | [Engine.read](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/engine.py#L331) |
| 时间权重 | freshness 衰减只改变综合排序，其新近性乘数位于 0.8 至 1.0；不会自动把旧记忆权重归零 | [recall 排序](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/engine.py#L292) |
| 有界检索 | 中文 FTS 候选、显式线索、关系邻居，可选向量；普通快速检索不调用 embedding，深度模式也只能搜索已建向量的内容 | [recall](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/engine.py#L185) |
| 纠错留痕 | 新建明确纠正事件及替代记忆，旧记录 revoked，原事件 amended，并保留 corrects 关系 | [Store.correct](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/store.py#L603) |
| 人格与情绪 | 人格独立版本化、MCP 只读；当前角色表达的情绪可以短时衰减，不自动修改核心人格 | [架构及边界](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/docs/architecture.md) |
| 可移植资料 | 导出权威表，索引和向量视为可重建缓存；导入核对来源、范围与时间 | [archive.py](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/src/memlikehuman/archive.py#L1) |

## 与我们的方案如何衔接

1. 阶段四继续保持原文先保存、模型只给候选、服务校验后提交。把原话、推断和当前概要分开，保留逐次修订，尤其不能把后文的委屈倒填到第一轮。
2. 阶段五继续分清“用户历史情绪”与“角色当前表现”。不能将角色情绪的六小时衰减公式套到用户历史感受，也不能将一次倾诉解释成永久性格。我们的情绪时序与动态重释仍需单独实现和评估。
3. 阶段六借鉴有界候选、来源线索和分页原文。先筛索引再读少量内容，逐步替换阶段三基础扫描；性能测试需覆盖常见词和规模，不能只测稀有词命中。
4. 阶段七将“日常概览”与“物理尘封”分成两层：旧经历可先少呈现细节，原文仍完整；达到条件后再无损归档。检索目录保留主题、人物和时间线索，唤醒时校验包、读原文并叠加最新修订。
5. 概览缺失时只显示可核验的主题线索，不临时编造完整旧事。精确日期仍存权威资料，前台显示时间变粗不能篡改数据库中的事件时间。
6. 阶段八提供时间线、理解变化与证据分页，让用户能够看见和纠正。若资料没有放进当前上下文，明确区分预算省略、处理未完成和没有找到。

这些是参考后的实施约束，不代表上述后续阶段已完成。不把它的 Python 核心或现有宿主插件直接引入本项目；本项目保持独立 Node 服务与自己的聊天入口。

## 不直接沿用的部分

- 它的普通 memory 用替代行和关系表达纠错；本项目保留记录 ID、单调版本、屏蔽代次和整组条件提交，以应对持久任务晚返回。
- 它的通用 MCP 分区是可信本地进程组织数据，不是安全边界；本项目继续采用服务端凭据绑定 companion，读取和用户写操作分权。
- 它的显式 forget 会删除共同来源及纠错链；我们的普通撤回只停止召回，保留修订和来源屏蔽，不把批次中后续独立贡献连带删除。
- 它对未知事实有效时间采用来源事件时间的默认策略；本项目仍保留 unknown，不能把采集时间当作未知事件发生时间。
- 精确引文验证只能证明来源存在，不能证明自然语言理解正确。动态情绪、否定、引文和人物指代仍需合成评估加用户实际测试。

## 测试和效果证据的边界

[淡忘测试](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/tests/test_fading.py#L16) 检查旧经历概览、详情仍可读和稳定事实不模糊。[生命周期测试](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/tests/test_lifecycle.py#L150) 检查情绪衰减与人格不变，但不能据此声称已实现我们需要的跨多轮情绪重新理解。

[归档测试](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/tests/test_archives.py#L13) 检查 JSON、JSONL、SQLite 往返与表内容一致，不是压缩帧解压验证。[延迟基准](https://github.com/xeonphi1/memlikehuman/blob/0fcf8865e9381580c562ba79717625d58d4a5b5c/benchmarks/memory_latency.py#L1) 使用合成资料，排除网络、模型生成、embedding 和生产提炼开销；不能把毫秒数字当作记忆理解准确率或完整聊天耗时。

该仓库为 Apache-2.0；若后续复制具体代码或资源，需要保留对应许可和 NOTICE。本次仅研究思路，没有复制其实现源码。

## 待当前开发完成后再讨论

用户提出“以八字作为角色初始性格的创作依据，基础倾向不变，经历与环境使表达逐渐隐藏、强化或冲突”。已记录为之后的独立设计议题，本阶段不据此改写自动记忆或人格权限。后续区分稳定内核、经历形成的适应方式、关系环境和当下表现，并由用户明确选择规则。
