# ModLens

面向 AI Agent 的视觉外挂 CLI，用于把图片来源（本地路径或远程 URL）转成结构化文本证据，补齐纯文本 LLM 的“看图”能力。

## 特性

- 面向“无视觉能力模型”场景（文本模型 + 外挂视觉）
- 支持本地图片路径与远程图片 URL
- 基于 Gemini CLI 非交互调用（`gemini -p`）
- 输出结构化 JSON（OCR + 布局 + 语义 + 视觉线索）
- 适合作为 Agent Skill 工具被 Claude Code / Codex 等调用

## 安装

```bash
npm install -g @liustack/modlens
```

需要先安装并认证 Gemini CLI：

```bash
npm install -g @google/gemini-cli
gemini
```

或直接用 `npx`：

```bash
npx @liustack/modlens [options]
```

## 用法

```bash
# 标准输出 JSON
modlens -i screenshot.png

# 落盘到文件
modlens -i screenshot.png -o lens.json

# 指定模型和额外解析要求
modlens -i screenshot.png -m gemini-2.5-flash --prompt "重点提取表格结构"
```

## 参数

- `-i, --input <path>` 输入图片路径（必填）
- `-o, --output <path>` 可选输出 JSON 路径
- `-m, --model <name>` Gemini 模型名
- `--prompt <text>` 额外解析约束
- `--timeout <ms>` 超时毫秒（默认 `180000`）
- `--gemini-bin <path>` Gemini 可执行路径（默认 `gemini`）

## Agent Skill

- [modlens/SKILL.md](skills/modlens/SKILL.md)

## 说明

- `modlens` 只做视觉解析。
- `modsearch` / `modfetch` 是其他独立项目，不在本仓库实现。

## 免责声明

本项目仅供**个人学习与实验**使用，请勿用于商业用途。

## License

MIT
