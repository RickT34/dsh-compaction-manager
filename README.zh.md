# dsh-compaction-manager

[English](README.md) | 中文

一个 DeepSeek Harness 插件，在一个面板里统一管理上下文压缩：

- **按顺序执行的压缩步骤。** 压缩触发后，启用的步骤按配置的顺序执行，都不调用模型。执行完如果上下文仍超过阈值，再由 `compaction-basic` 做 LLM 摘要，这一步固定在最后。
- **自动压缩参数。** 可以调整 `compaction-basic` 的触发阈值、保留比例、重试次数、摘要模型和自动压缩开关，下一次压缩时生效，不用重启。
- **取回原文。** 被隐藏的内容带一个 ID，模型可以调用 `restore_context` 从会话日志里读回原文。
- **压缩预览与立即压缩。** 每个会话顶部多了一个「压缩」标签，和「对话」「轨迹」并列。它用已保存的步骤预览这个会话的压缩效果，逐条显示压缩前后的文字和估算节省的 token，并提供「立即压缩」按钮。DSH 只允许在模型回合内改写历史，所以立即压缩会在这个会话下一次调用模型前执行。

默认配置与原版 DSH 完全一致：只运行官方的首尾裁剪，并且直接调用官方原来的实现。

![压缩步骤](assets/screenshot-steps-zh.png)

![方法介绍与参数](assets/screenshot-method-zh.png)

![压缩预览](assets/screenshot-preview-zh.png)

## 安装

需要 DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`。

```sh
dsh plugin --profile web add dsh-compaction-manager
```

也可以在 Web 界面里打开**插件 → 添加插件**，输入 `dsh-compaction-manager`。安装后左侧栏会出现**压缩管理**，**插件**页里这个插件的详情页也有打开面板的入口。

如果想装 GitHub 上的最新提交而不是 npm 发布版，把包名换成 `github:RickT34/dsh-compaction-manager`。

## 内置方法

| 方法 | 隐藏什么 | 能否取回 | 默认 |
|---|---|---|---|
| 官方首尾裁剪 | 超过 8192 字符的工具结果的中间部分 | 打开“附带取回 ID”后可以 | 开启 |
| Magic Compact | 旧的、体积大的工具输出，换成省略提示（仿照 aerovato/magic-compact 的 `/magic-trim`） | 能 | 关闭 |
| OpenCode DCP | 重复调用、若干回合前出错调用的输入，可选清理被覆盖的读取（仿照 Opencode-DCP） | 能 | 关闭 |
| 折叠旧工具调用 | 整组调用和结果，包括调用参数，比如 `write`/`edit` 里的整段文件内容 | 能 | 关闭 |

DSH 不允许单独改写工具调用的参数，所以折叠会把一条已闭合的 assistant 工具调用消息和它的结果一起换成一条 user 消息。

## 接入方式

Web 版把 `compaction-basic` 和 `tool-result-pruner` 装在每个 agent preset 内部。插件加载期间会替换它们原型上的方法：

- `ToolResultPruner.prototype.pruneSession`：执行配置好的压缩步骤。
- `BasicCompactionEngine.prototype` 上的方法：应用面板里填写的压缩参数。

卸载插件后会还原原来的方法。所有改写都使用和官方裁剪相同、可安全重放的事件（先写 `compaction/prune`，再做一次 surface `replace`），所以卸载插件后这些会话照样能正常打开。

## 扩展

其他插件可以注册新的压缩方法：

```js
export const inject = ['compactionMethods']
export function apply(ctx) {
  ctx.effect(() => ctx.compactionMethods.register({
    id: 'my-method',
    name: { zh: '我的方法', en: 'My method' },
    summary: { zh: '…', en: '…' },
    details: { zh: '…', en: '…' },
    options: [{ key: 'minChars', type: 'number', label: { zh: '最小字符数', en: 'Min chars' }, default: 500 }],
    recall: () => true,
    // view.nodes: [{ seq, rootSeq, type, text, chars, toolName, args, isError, pending, turn, ... }]
    plan(view, options) {
      return view.nodes
        .filter(n => n.type === 'tool' && !n.pending && n.chars > options.minChars)
        .map(n => ({ type: 'result', seq: n.seq, content: [{ type: 'text', text: `[compacted · id=r${n.rootSeq}] …` }] }))
    },
  }))
}
```

`plan` 必须是纯函数，不能修改任何东西。它返回的候选项有两种：

- `{ type: 'result', seq, content }`：改写一条工具结果。
- `{ type: 'fold', startSeq, endSeq, content }`：把一组已闭合的工具调用换成一条 user 消息。

内置方法会跳过以 `[compacted` 开头的提示。`r<seq>` 和 `c<seq>` 形式的 ID 都可以传给 `restore_context`。注册后，新方法会自动出现在面板里，可以排序、调整参数和预览。

## 开发

```sh
npm run link-dsh   # 从本机的 dsh 安装链接测试需要的 DSH 包
npm test           # node --test test/*.test.mjs
npm run build      # 用 src/client/*.js 重新生成 dist/client.js
```

`dist/client.js` 已提交到仓库，从 GitHub 安装时不需要构建。修改 `src/client/` 后，要重新构建并提交它。

## 许可证

[MIT](LICENSE)
