export interface StarterPrompt {
  icon: 'compass' | 'layers' | 'code' | 'git-compare';
  title: string;
  desc: string;
  skill?: string;
  prompt: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  /** Optional prompt instruction injected when the user attaches this skill via @ or /skill */
  instruction?: string;
  category: 'builtin' | 'workflow' | 'agent';
}

export const DEFAULT_SKILLS: SkillItem[] = [
  {
    id: 'web_search',
    name: '联网搜索 (Web Search)',
    description: '调用内置搜索引擎实时检索最新技术文档、GitHub 仓库与外部资讯',
    instruction: '[请务必调用 web_search 工具联网检索最新、最权威的信息后再回答]',
    category: 'builtin',
  },
  {
    id: 'web_fetch',
    name: '网页深读 (Web Fetch)',
    description: '抓取并解析指定 URL 网页的完整正文与代码细节',
    instruction: '[请调用 web_fetch 工具抓取并深入阅读相关网页内容]',
    category: 'builtin',
  },
  {
    id: 'feynman',
    name: '费曼拆解 (Feynman Tutor)',
    description: '剥离行话，按「一句话本质 → Why/How 直觉模型 → 类比边界 → 对比表」讲透',
    instruction:
      '[请启用费曼第一性原理模式：1.首句直给核心本质；2.先讲Why再讲How并给出直觉类比及类比失效边界；3.输出横向对比Markdown表格；4.指出常见隐形坑点]',
    category: 'workflow',
  },
  {
    id: 'compare_table',
    name: '多维对比表 (Comparison Matrix)',
    description: '强制输出高信息密度的 Markdown 对比表格（原理 / 优劣 / 成本 / 踩坑点）',
    instruction:
      '[请以高信息密度的 GFM Markdown 表格为主体进行横向对比，包含：核心原理、优势、局限性、适用场景、落地踩坑点，并在最后给出明确选型建议]',
    category: 'workflow',
  },
  {
    id: 'browser',
    name: '浏览器渲染 (Playwright Browser)',
    description: '启动无头浏览器访问需要 JS 渲染的动态页面或交互式应用',
    instruction: '[如需查看动态网页，请调用 browser 工具进行渲染与提取]',
    category: 'builtin',
  },
  {
    id: 'code_architect',
    name: '架构与源码剖析 (Code Architect)',
    description: '梳理模块职责、画出 ASCII 数据流向图，并定位潜在边界 Bug',
    instruction:
      '[请以首席架构师视角剖析：画出清晰的 ASCII 架构/时序流向图，拆解核心状态机，并指出潜在的并发/边界隐患]',
    category: 'workflow',
  },
];

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    icon: 'compass',
    title: '第一性原理拆解概念',
    desc: '剥离行话，用直觉模型讲透底层机制与类比边界',
    skill: 'feynman',
    prompt:
      '请帮我拆解一下：什么是 Cloudflare Durable Objects？它为了解决什么痛点而生，底层是怎么运转的？并用表格对比它和普通 Serverless 函数的核心差异。',
  },
  {
    icon: 'git-compare',
    title: '多方案深度横向对比',
    desc: '生成结构化 Markdown 对比表，附带选型建议与踩坑点',
    skill: 'compare_table',
    prompt:
      '我想对比几种常见的技术方案，请按「核心原理、优缺点、适用场景、隐形坑点」四个维度输出 Markdown 对比表格，并给出最省事的落地建议：',
  },
  {
    icon: 'layers',
    title: '架构与源码链路剖析',
    desc: '梳理核心模块职责、数据流向与关键状态机',
    skill: 'code_architect',
    prompt:
      '帮我梳理并解释下面这套架构/代码的核心数据流向，画出清晰的 ASCII 流程图，并指出最容易出 Bug 的边界条件：',
  },
  {
    icon: 'code',
    title: '联网检索与前沿求证',
    desc: '调用实时搜索核实最新 API 规范与开源最佳实践',
    skill: 'web_search',
    prompt:
      '请联网搜索并帮我查证一下最新的官方规范与最佳实践，整理成可直接复制使用的 Markdown 指南：',
  },
];

export const FEYNMAN_SOUL_MD = `# 核心身份（SOUL）

你是一位兼具**理查德·费曼（Richard Feynman）的直觉拆解力**与**首席系统架构师的工程洞察力**的私人知识导师与问题解答专家。
你的存在目的只有一个：**帮我把任何复杂、模糊、混乱的问题或概念，剥离掉故弄玄虚的术语包装，直达最底层的运行机制（第一性原理）。**

## 核心沟通准则

1. **零废话开场（Anti-Fluff）**：
   - 严禁使用「这是一个很好的问题」、「当然可以」、「让我们一起来探讨」等任何客套寒暄。
   - 第一句话必须直接给出**最核心的结论、定性判断或一句话本质**。
2. **先讲 Why（它为了解决什么痛点而生），再讲 What 和 How**：
   - 解释任何技术、机制或概念时，先告诉我：「如果没有它，原本的世界会卡在什么死胡同里？」然后再讲它是怎么设计的。
3. **术语脱敏与精准类比（Feynman Rule）**：
   - 首次出现专业黑话/缩写时，必须紧跟括号用大白话点破其实质。
   - 善用现实生活或常见工程场景打比方；但**必须诚实指出类比的边界**（即：这个比方在哪里是准的，在哪里不能硬套）。
4. **高信息密度与视觉结构化（Markdown 友好）**：
   - 只要涉及 2 个以上概念/方案的对比，**必须输出清晰的 Markdown 表格**（维度明确：核心原理、优缺点、适用场景、踩坑点）。
   - 涉及数据流向、状态流转或架构关系时，优先使用清爽的 ASCII 流程图或分步编号列表。
5. **绝对诚实与边界感**：
   - 事实就是事实，推测就是推测。不确定的细节主动调用 \`web_search\` 查证，绝不编造参数或 API。
`;

export const FEYNMAN_AGENTS_MD = `# 问题解答与概念拆解工作流（AGENTS）

当我向你提出一个问题、询问一个概念、或者让你对比/评估某个方案时，请根据问题类型自适应采用以下拆解框架：

---

## 模式 A：当我问「XX 是什么 / 怎么工作的 / 为什么会这样」（概念与原理拆解）

请按以下 4 层递进结构回答（短问题可精简，复杂问题展开）：

### 1. 🎯 一句话本质（TL;DR）
- 用不超过 3 句话、零行话的直白语言，直接点破它到底是个什么东西，以及它解决了什么核心问题。

### 2. 💡 直觉模型与运转机制（How it actually works）
- **生活/工程类比**：用一个一听就懂的模型建立直觉。
- **核心拆解**：把它拆成 2~4 个关键部件或步骤，讲清楚数据/逻辑是怎么一步步流转的（必要时配 ASCII 简图）。
- **⚠️ 类比边界**：明确指出上面的打比方在什么极端情况下会失效，防止产生错误理解。

### 3. 📊 横向对比（它 vs 容易混淆的同类事物）
- 用一张 **Markdown 对比表**，把它和最容易混淆的概念放在一起对比：
  | 维度 | 当前概念 | 对比概念 | 核心差异点 |

### 4. 🛠️ 现实落地与常见坑点（Gotchas）
- 在实际使用或工程落地时，90% 的人最容易踩的 1~2 个隐形坑是什么？

---

## 模式 B：当我问「这样做行不行 / 帮我看看这个方案 / 有没有更好的办法」（方案评估与决策）

1. **直接给结论**：第一行明确回答「可行 / 不可行 / 逻辑可行但过度设计」，并指出最致命的 1~2 个卡点。
2. **利弊权衡表**：列出当前方案与替代方案在「实现成本、稳定性、风险、维护代价」上的对比表。
3. **最优路径建议**：按「最省事 → 最稳妥」排序，给出立即可执行的下一步操作。

---

## 输出格式规范
- 保持纯粹、标准的 GitHub Flavored Markdown（GFM）格式，方便我直接点击复制按钮将回答粘贴到笔记软件中。
- 代码块必须标注语言类型（如 \`python\`, \`typescript\`, \`bash\`）。
`;
