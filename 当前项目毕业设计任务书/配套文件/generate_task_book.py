from __future__ import annotations

import argparse
import datetime as dt
import re
from pathlib import Path

import pythoncom
import win32com.client


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = Path(__file__).resolve().parent
SOURCE_DOC = ROOT / "任务书" / "32101055_吴明曙_侯宏仑_计算机与计算科学学院_软件工程_软件工程2102_毕业论文（设计）任务书.doc"

CHINESE_TITLE = "面向超级个体的AI协作工作空间设计与实现"
ENGLISH_TITLE = "Design and Implementation of an AI Collaborative Workspace for Solo Professionals"

OUTPUT_DOCX = OUTPUT_DIR / f"毕业论文（设计）任务书_{CHINESE_TITLE}.docx"
OUTPUT_PDF = OUTPUT_DIR / f"毕业论文（设计）任务书_{CHINESE_TITLE}.pdf"
OUTPUT_REVIEW = OUTPUT_DIR / "任务书内容核对稿.md"


MAIN_CONTENT = """论文（设计）的主要内容及要求：（以设计作品为主要成果形式的毕业设计要求以各分院实施方案为准）
1、开题报告和文献阅读
（1）文献阅读：查阅文献15篇（含）以上，其中外文文献2篇（含）以上，近三年公开发表的文献5篇（含）以上，书籍不超过3本，期刊（[J]）和论文集（[C]）10篇（含）以上，包括导师指定的全部参考文献。
（2）外文翻译：3000字以上。
（3）文献综述：3000字以上，包括国内外研究现状、研究方向、进展情况、存在问题和参考依据等。
（4）开题报告：3000字以上，包括选题的意义、可行性分析、研究内容、研究方法、拟解决的关键问题、预期结果和研究进度计划等。
2、论文：10000字以上，包括绪论、正文、结论、参考文献等。法学、人文、经管类专业8000字以上，特殊专业应满足分院根据培养目标另行制定的相应要求。
3、课题要解决的主要问题和具体要求（填写如下）：
一、课题背景与总体目标
生成式人工智能正由单轮内容生成转向能够理解上下文、调用工具并持续执行任务的智能体形态。个人开发者、独立创作者和小型团队虽然可以借助大语言模型完成调研、规划、编码、测试与交付，但项目上下文仍分散在聊天记录、代码仓库、任务系统和本地文件中，容易出现上下文丢失、工具权限不透明、执行过程难追溯、人工纠偏不及时以及经验难复用等问题。课题拟面向“超级个体”的复杂知识工作场景，设计并实现一个本地优先、自托管、MCP-first但非MCP-only的AI协作工作空间系统。系统由自身持有项目语义、工作流状态、资产、决策和审计证据，以Codex等代码智能体作为可替换执行器，通过结构化Context Pack向执行器提供受控上下文，并以“AI提议、用户确认、系统追溯”为基本协作原则，形成从项目创建、工作流规划、任务执行、过程审查到代码交付和经验沉淀的闭环。
前期已形成AI Workspace System V1.9工程原型，具备项目生命周期、Workstream/Task两级工作流、分层Assist、Context Pack、MCP服务、受管代码工作区、Git/GitHub交付、Docker部署和自动化测试等基础能力。当前项目仍处于持续开发阶段，外部服务实机联调、性能与可用性评估、部分异常恢复以及论文层面的架构归纳尚需完善。本课题以现有仓库为研究和实现基础，不把计划能力或版本说明直接等同于最终成果，最终结论必须由代码、测试、运行记录和实验数据共同支撑。
二、主要研究与设计内容
（1）需求分析与范围建模。调研大语言模型智能体、MCP、智能工作流、人机协同、软件资产追溯和本地优先软件，识别超级个体在软件项目中的核心角色、任务、数据、风险和使用场景，形成需求规格、范围边界及可验证的质量属性。
（2）项目生命周期与分层工作流。建立Project、Project Brief、Workflow、Workstream、Task和Node Contract等领域模型，支持从零头脑风暴或导入已有项目，完成草稿、确认、激活、迁移和归档等生命周期；工作流顶层保持可独立验收的工作流分支，内部任务支持列表、看板或局部结构图，并允许在审批后调整。
（3）上下文与项目记忆。研究短期会话状态与长期项目记忆的分离方法，设计Asset、Trace、Decision、Workspace Digest、Memory Manifest和Context Pack。上下文包应按目标、权限、时效和依赖关系选择资料，保留来源、版本和充分性说明，避免把全量仓库或无关会话直接注入模型。
（4）AI协作与执行器适配。以Codex app-server/CLI为首个执行器，完成会话、Turn、Goal、计划模式、工具调用、流式事件、用户补充输入、中断/恢复和结果归一化；抽象Runner能力与配置边界，为后续接入其他模型或智能体运行时保留扩展接口。
（5）MCP-first能力接入。实现系统内建MCP服务及HTTP、stdio或Gateway连接路径，把项目、工作流、资产、运行和交付能力以工具或资源形式暴露；统一REST、MCP和页面操作的业务服务、权限判断及操作回执，验证协议接入不绕过系统领域规则。
（6）人机协同治理与可追溯性。对工作流变更、文件修改、命令执行、网页语义操作和外部交付建立审批、写锁、checkpoint、累计Diff Review、撤销/回滚和审计机制；区分提议、执行、确认和最终成果，保留操作者、时间、输入、输出及证据关联。
（7）代码仓库与交付闭环。研究受管checkout/worktree、项目级仓库绑定和权限隔离，实现Git差异、分支、提交及GitHub Draft Pull Request交付；对路径越界、符号链接、秘密信息、目标仓库、测试门禁、重复请求和失败恢复进行校验。
（8）本地优先部署与安全。采用自托管部署，默认使用本地JSON持久化并保留向Prisma/PostgreSQL替换的边界；利用Docker Compose隔离应用和执行器，完成凭据脱敏、最小权限、项目ACL、数据迁移、备份恢复及敏感信息不落盘等设计。
（9）交互与可视化。采用React与TypeScript实现项目、工作流画布、节点工作区、Assist活动流、Diff审查、资产和审计等界面，保证桌面、平板和移动视口下的核心流程可用，动态内容不遮挡，复杂操作具有明确状态和反馈。
（10）测试与评估。建立静态检查、单元测试、集成测试、端到端测试、故障注入和安全测试，围绕功能正确性、项目隔离、上下文准确性、可恢复性、交付可追溯性、响应耗时和可用性进行验证；真实Codex、GitHub等外部能力应与测试适配器结果分开记录。
三、拟解决的关键问题
（1）如何在有限上下文窗口内选择充分、最新、无冲突且有权限的项目资料，使智能体获得连续性，同时避免系统记忆被单一模型会话绑定。
（2）如何把自然语言驱动的不确定智能体行为纳入可审查的软件工程流程，使用户能在关键节点确认、拒绝、中断、恢复或回滚，并能解释结果从何而来。
（3）如何在MCP、REST、网页操作、终端和Git交付等多入口之间复用同一领域规则，避免协议层与业务状态割裂或出现越权旁路。
（4）如何在本地自托管环境中平衡执行能力与安全边界，保证凭据、文件、仓库和项目之间的隔离，并在失败后保留可恢复证据。
（5）如何控制毕业设计范围，在已有工程原型上提炼具有研究价值的架构、模型和评价方法，而不是单纯堆叠功能或以代码量代替有效性论证。
四、基本技术路线
（1）文献调研：围绕LLM智能体、软件工程智能体、人机协同、工作流模式、数据来源追溯、本地优先软件和MCP规范开展检索，完成综述并建立概念对照表。
（2）需求与场景分析：以独立开发者完成一个软件项目为主场景，通过用例、用户旅程、领域词汇表和风险清单确定系统范围、输入输出、角色权限及验收指标。
（3）总体设计：采用前后端分离和模块化架构，前端使用React、TypeScript和Vite，后端使用Node.js ES Modules；设计Project、Workflow、Assist、Asset、Trace、Repository和Delivery等领域服务及持久化模型。
（4）核心实现：完成项目接入、两级工作流、节点契约、分层Assist、上下文包、受管工作区和活动流；通过SSE/WebSocket支持流式事件与终端交互，通过结构化Schema约束跨模块数据。
（5）智能体与工具集成：接入Codex原生会话能力，构建Context Pack和结果归一化机制；实现MCP工具/资源目录、客户端授权及统一操作账本，并接入Git/GitHub完成代码变更审查和Draft PR交付。
（6）治理与安全加固：实现Project ACL、审批、幂等键、写锁、checkpoint、差异审查、撤销、迁移和恢复；对路径穿越、符号链接、秘密泄露、跨项目访问和重复投递等风险进行防护。
（7）测试与实验：按单元、集成、端到端、故障和安全层次构造测试，选择至少一条“项目创建—工作流生成—任务协作—代码修改—审查交付—资产沉淀”完整旅程，记录成功率、耗时、失败原因和恢复结果；必要时比较有无结构化Context Pack及人工审批时的结果差异。
（8）总结与论文撰写：根据需求、设计、实现和实验事实归纳系统贡献与局限，明确原型、自动化测试和真实外部联调的证据边界，完成论文、部署说明、测试报告和答辩演示材料。
五、预期成果与质量要求
（1）提交可运行的AI协作工作空间系统源代码和可复现部署方案，至少跑通项目接入、分层工作流、AI Assist、Context Pack、人工审查、Git差异及资产/审计查看的核心链路。
（2）提交需求分析、系统设计、接口与数据模型说明、部署运行手册、测试用例及测试报告；关键架构决策应能追溯到需求、风险或实验依据。
（3）核心代码应具有清晰模块边界和必要注释，通过项目约定的lint、typecheck、unit、integration与e2e门禁；未执行的真实外部服务测试不得标记为通过。
（4）完成项目隔离、权限校验、路径与秘密信息防护、审批/回滚、异常恢复等安全与可靠性验证，保证测试和演示数据不包含真实敏感凭据。
（5）完成不少于10000字的毕业论文（设计说明书），内容包括绪论、相关工作、需求分析、总体设计、详细实现、测试与评估、结论与展望，并按GB/T 7714—2015著录参考文献。
（6）准备可重复的样例项目、答辩PPT和演示脚本，演示内容与论文结论一致；如时间受限，优先保证核心闭环、证据完整性和论文论证，不以未经验证的扩展功能代替必做成果。"""


REFERENCES = [
    "WANG L, MA C, FENG X, et al. A survey on large language model based autonomous agents[J]. Frontiers of Computer Science, 2024, 18(6): 186345. DOI:10.1007/s11704-024-40231-1.",
    "XI Z, CHEN W, GUO X, et al. The rise and potential of large language model based agents: A survey[J]. Science China Information Sciences, 2025, 68(2): 121101. DOI:10.1007/s11432-024-4222-0.",
    "WANG Y, ZHONG W, HUANG Y, et al. Agents in software engineering: Survey, landscape, and vision[J]. Automated Software Engineering, 2025, 32(2): 70. DOI:10.1007/s10515-025-00544-2.",
    "QIAN C, LIU W, LIU H, et al. ChatDev: Communicative agents for software development[C]//Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics. Bangkok: Association for Computational Linguistics, 2024: 15174-15186. DOI:10.18653/v1/2024.acl-long.810.",
    "YANG J, JIMENEZ C E, WETTIG A, et al. SWE-agent: Agent-computer interfaces enable automated software engineering[C]//Advances in Neural Information Processing Systems 37. [S.l.]: Neural Information Processing Systems Foundation, 2024: 50528-50652. DOI:10.52202/079017-1601.",
    "PARK J S, O'BRIEN J, CAI C J, et al. Generative agents: Interactive simulacra of human behavior[C]//Proceedings of the 36th Annual ACM Symposium on User Interface Software and Technology. New York: ACM, 2023: 1-22. DOI:10.1145/3586183.3606763.",
    "YAO S, ZHAO J, YU D, et al. ReAct: Synergizing reasoning and acting in language models[C/OL]//The Eleventh International Conference on Learning Representations. [S.l.]: OpenReview, 2023[2026-07-21]. https://openreview.net/forum?id=WE_vluYUL-X.",
    "AMERSHI S, WELD D, VORVOREANU M, et al. Guidelines for human-AI interaction[C]//Proceedings of the 2019 CHI Conference on Human Factors in Computing Systems. New York: ACM, 2019: 1-13. DOI:10.1145/3290605.3300233.",
    "KLEPPMANN M, WIGGINS A, VAN HARDENBERG P, et al. Local-first software: You own your data, in spite of the cloud[C]//Proceedings of the 2019 ACM SIGPLAN International Symposium on New Ideas, New Paradigms, and Reflections on Programming and Software. New York: ACM, 2019: 154-178. DOI:10.1145/3359591.3359737.",
    "VAN DER AALST W M P, TER HOFSTEDE A H M, KIEPUSZEWSKI B, et al. Workflow patterns[J]. Distributed and Parallel Databases, 2003, 14(1): 5-51. DOI:10.1023/A:1022883727209.",
    "MOREAU L, CLIFFORD B, FREIRE J, et al. The Open Provenance Model core specification (v1.1)[J]. Future Generation Computer Systems, 2011, 27(6): 743-756. DOI:10.1016/j.future.2010.07.005.",
    "HERSCHEL M, DIESTELKAMPER R, BEN LAHMAR H. A survey on provenance: What for? What form? What from?[J]. The VLDB Journal, 2017, 26(6): 881-906. DOI:10.1007/s00778-017-0486-1.",
    "HOLZINGER A. Interactive machine learning for health informatics: When do we need the human-in-the-loop?[J]. Brain Informatics, 2016, 3(2): 119-131. DOI:10.1007/s40708-016-0042-6.",
    "LEWIS P, PEREZ E, PIKTUS A, et al. Retrieval-augmented generation for knowledge-intensive NLP tasks[C]//Advances in Neural Information Processing Systems 33. Red Hook, NY: Curran Associates, 2020: 9459-9474.",
    "SCULLEY D, HOLT G, GOLOVANOV E, et al. Hidden technical debt in machine learning systems[C]//Advances in Neural Information Processing Systems 28. Red Hook, NY: Curran Associates, 2015: 2503-2511.",
    "MODEL CONTEXT PROTOCOL. Model Context Protocol specification: 2025-06-18[EB/OL]. (2025-06-18)[2026-07-21]. https://modelcontextprotocol.io/specification/2025-06-18.",
    "WORLD WIDE WEB CONSORTIUM. PROV-DM: The PROV data model[S/OL]. (2013-04-30)[2026-07-21]. https://www.w3.org/TR/2013/REC-prov-dm-20130430/.",
]

REFERENCE_META = [
    ("J", 2024),
    ("J", 2025),
    ("J", 2025),
    ("C", 2024),
    ("C", 2024),
    ("C", 2023),
    ("C", 2023),
    ("C", 2019),
    ("C", 2019),
    ("J", 2003),
    ("J", 2011),
    ("J", 2017),
    ("J", 2016),
    ("C", 2020),
    ("C", 2015),
    ("EB", 2025),
    ("S", 2013),
]


def cell_range(table, row: int, column: int):
    cell = table.Cell(row, column)
    rng = cell.Range.Duplicate
    rng.End -= 1
    return cell, rng


def set_cell_text(table, row: int, column: int, text: str):
    cell, rng = cell_range(table, row, column)
    rng.Text = text.replace("\n", "\r")
    return cell, rng


def set_font(rng, *, east_asia: str, ascii_font: str, size: float, bold: bool = False):
    rng.Font.Name = ascii_font
    rng.Font.NameAscii = ascii_font
    rng.Font.NameFarEast = east_asia
    rng.Font.Size = size
    rng.Font.Bold = -1 if bold else 0


def format_cell(
    table,
    row: int,
    column: int,
    *,
    size: float,
    alignment: int = 0,
    bold: bool = False,
    line_spacing: float = 12.0,
):
    cell, rng = cell_range(table, row, column)
    set_font(rng, east_asia="宋体", ascii_font="Times New Roman", size=size, bold=bold)
    rng.ParagraphFormat.Alignment = alignment
    rng.ParagraphFormat.SpaceBefore = 0
    rng.ParagraphFormat.SpaceAfter = 0
    rng.ParagraphFormat.LeftIndent = 0
    rng.ParagraphFormat.RightIndent = 0
    rng.ParagraphFormat.FirstLineIndent = 0
    rng.ParagraphFormat.LineSpacingRule = 4  # wdLineSpaceExactly
    rng.ParagraphFormat.LineSpacing = line_spacing
    cell.VerticalAlignment = 1  # wdCellAlignVerticalCenter
    return cell, rng


def format_signature_cell(table, row: int):
    cell, _ = cell_range(table, row, 1)
    for index in range(1, cell.Range.Paragraphs.Count + 1):
        para = cell.Range.Paragraphs.Item(index)
        text = para.Range.Text.rstrip("\r\x07").strip()
        set_font(para.Range, east_asia="宋体", ascii_font="Times New Roman", size=10.5)
        para.Format.SpaceBefore = 0
        para.Format.SpaceAfter = 0
        para.Format.LeftIndent = 0
        para.Format.RightIndent = 0
        para.Format.FirstLineIndent = 0
        para.Format.LineSpacingRule = 4
        para.Format.LineSpacing = 16.0 if row == 20 else 14.0
        if "同意下达任务书" in text:
            para.Format.Alignment = 1
        elif "签名" in text or re.fullmatch(r"年\s+月\s+日", text):
            para.Format.Alignment = 2
        else:
            para.Format.Alignment = 0


def format_paragraphs(cell, *, size: float, line_spacing: float, reference_list: bool = False):
    paragraph_count = cell.Range.Paragraphs.Count
    for index in range(1, paragraph_count + 1):
        para = cell.Range.Paragraphs.Item(index)
        text = para.Range.Text.rstrip("\r\x07").strip()
        set_font(para.Range, east_asia="宋体", ascii_font="Times New Roman", size=size)
        para.Format.Alignment = 3 if reference_list and index > 1 else 0
        para.Format.SpaceBefore = 0
        para.Format.SpaceAfter = 0
        para.Format.LineSpacingRule = 4
        para.Format.LineSpacing = line_spacing
        para.Format.LeftIndent = 14.0 if reference_list and index > 1 else 0
        para.Format.FirstLineIndent = -14.0 if reference_list and index > 1 else 0

        if reference_list and index == 1:
            para.Range.Font.Bold = -1
            continue

        if text.startswith(
            (
                "论文（设计）的主要内容及要求",
                "1、开题报告和文献阅读",
                "2、论文：",
                "3、课题要解决的主要问题",
                "一、",
                "二、",
                "三、",
                "四、",
                "五、",
            )
        ):
            para.Range.Font.Bold = -1

        if text.startswith(("生成式人工智能", "前期已形成")):
            para.Format.FirstLineIndent = size * 2
            para.Format.Alignment = 3


def mark_placeholder(table, row: int, column: int):
    _, rng = cell_range(table, row, column)
    rng.Font.Color = 0x0000C0  # dark red in Word's BGR representation
    rng.HighlightColorIndex = 7  # wdYellow


def validate_references():
    if len(REFERENCES) < 15:
        raise ValueError("参考文献少于15篇")
    if len(REFERENCES) != len(REFERENCE_META):
        raise ValueError("参考文献与元数据数量不一致")

    journal_or_conference = sum(kind in {"J", "C"} for kind, _ in REFERENCE_META)
    recent = sum(year >= 2024 for _, year in REFERENCE_META)
    books = sum(kind == "M" for kind, _ in REFERENCE_META)
    if journal_or_conference < 10:
        raise ValueError("期刊和会议文献少于10篇")
    if recent < 5:
        raise ValueError("2024年以来文献少于5篇")
    if books > 3:
        raise ValueError("书籍超过3本")
    if not any("[J]" in ref for ref in REFERENCES):
        raise ValueError("缺少期刊文献")
    if not any("[C]" in ref or "[C/OL]" in ref for ref in REFERENCES):
        raise ValueError("缺少会议文献")
    return journal_or_conference, recent, books


def build_review_markdown(journal_or_conference: int, recent: int, books: int) -> str:
    references = "\n".join(f"[{index}] {reference}" for index, reference in enumerate(REFERENCES, 1))
    return f"""# 毕业论文（设计）任务书内容核对稿

> 生成日期：{dt.date.today().isoformat()}  
> 中文题目：{CHINESE_TITLE}  
> 外文题目：{ENGLISH_TITLE}

## 成品文件

- `{OUTPUT_DOCX.name}`：可编辑提交稿，沿用参考任务书的表格、页边距和栏目结构。
- `{OUTPUT_PDF.name}`：与 DOCX 同步导出的检查版。

## 提交前必须补充

文档中以黄色标出的字段没有可靠来源，必须按学院信息补齐：

1. 学生姓名、学号、完整专业班级和联系电话；
2. 指导教师姓名、职称和联系电话；
3. 第二指导教师信息（没有则按学院要求填写“无”或留空）；
4. 学院正式规定的毕业论文（设计）起止日期；
5. 指导教师及工作指导小组意见、签名和日期。

当前稿暂按参考文件保留“计算机与计算科学学院”，并将选题类型设为“工程设计”、选题来源设为“学校自选项目”、社会实践设为“是”。这三项也应由学生和指导教师最终确认。

## 编写依据

- 版式与固定栏目：`../任务书/32101055_吴明曙_侯宏仑_计算机与计算科学学院_软件工程_软件工程2102_毕业论文（设计）任务书.doc`；
- 参考文献著录：`../任务书/GB+T+7714-2015+信息与文献+参考文献著录规则.pdf`；
- 项目定位与早期范围：`../doc/核心想法.MD`、`../doc/问题.md`、愿景与范围文档；
- 当前实现与边界：`../README.md`、`../开发计划v1.9.md`、`../测试计划v1.9.md`；
- 工程证据与运行说明：`../docs/`、`../apps/`、`../packages/`、`../tests/`；
- 相关工作线索：`../探索/`、`../探索-1/`。

任务正文把当前 V1.9 仓库表述为“前期工程原型”，并把外部实机联调、性能与可用性评估、异常恢复验证、论文级归纳列为后续工作，避免把尚未完成或仅由适配器测试覆盖的内容写成最终成果。

## 参考文献规则核对

| 项目 | 结果 | 参考任务书要求 |
|---|---:|---:|
| 文献总数 | {len(REFERENCES)} | 不少于15篇 |
| 外文文献 | {len(REFERENCES)} | 不少于2篇 |
| 2024年以来文献 | {recent} | 近三年不少于5篇 |
| 期刊/会议文献 | {journal_or_conference} | 不少于10篇 |
| 书籍 | {books} | 不超过3本 |

参考文献采用顺序编码制，文献类型标识、出版项、页码、DOI及在线文献引用日期按GB/T 7714—2015整理。提交前仍应结合导师指定书目和学校对“近三年”的具体口径复核。

## 任务书正文

{MAIN_CONTENT}

## 推荐参考文献

{references}
"""


def generate(force: bool = False):
    if not SOURCE_DOC.exists():
        raise FileNotFoundError(f"找不到参考任务书：{SOURCE_DOC}")

    journal_or_conference, recent, books = validate_references()

    for path in (OUTPUT_DOCX, OUTPUT_PDF, OUTPUT_REVIEW):
        if path.exists() and not force:
            raise FileExistsError(f"输出文件已存在；如需覆盖请使用 --force：{path}")
        if path.exists():
            if path.resolve().parent != OUTPUT_DIR.resolve():
                raise RuntimeError(f"拒绝删除输出目录之外的文件：{path}")
            path.unlink()

    OUTPUT_REVIEW.write_text(
        build_review_markdown(journal_or_conference, recent, books),
        encoding="utf-8",
    )

    pythoncom.CoInitialize()
    word = None
    document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        word.ScreenUpdating = False

        document = word.Documents.Open(
            str(SOURCE_DOC),
            ConfirmConversions=False,
            ReadOnly=False,
            AddToRecentFiles=False,
        )
        document.TrackRevisions = False
        if document.Revisions.Count:
            document.AcceptAllRevisions()
        while document.Comments.Count:
            document.Comments.Item(1).Delete()

        table = document.Tables.Item(1)

        # Basic information. Unknown identity fields are intentionally explicit.
        set_cell_text(table, 1, 2, "【待填】")
        set_cell_text(table, 1, 4, "【待填】")
        set_cell_text(table, 1, 6, "软件工程【待填】")
        set_cell_text(table, 1, 8, "【待填】")
        set_cell_text(table, 2, 2, CHINESE_TITLE)
        set_cell_text(table, 3, 2, ENGLISH_TITLE)
        set_cell_text(table, 4, 2, "【待填】")
        set_cell_text(table, 4, 4, "【待填】")
        set_cell_text(table, 4, 6, "计算机与计算科学学院")
        set_cell_text(table, 4, 8, "【待填】")
        set_cell_text(table, 5, 2, "【待定】")
        set_cell_text(table, 5, 4, "【待定】")
        set_cell_text(table, 5, 6, "【待定】")
        set_cell_text(table, 5, 8, "【待定】")

        set_cell_text(
            table,
            6,
            2,
            "√工程设计    □理论研究    □实验研究    □产品开发\n"
            "□设计创作    □专题研究    □应用研究    □其他",
        )
        set_cell_text(
            table,
            7,
            2,
            "□国家重点研发计划项目    □国家社科规划、基金项目    □国家自然科学基金项目\n"
            "□中央、国家各部门项目    □教育部人文、社会科学研究项目    □省（自治区、直辖市）项目\n"
            "□国际合作研究项目    □港、澳、台合作研究项目    □企、事业单位委托项目    □外资项目\n"
            "□国防项目    √学校自选项目    □非立项    □其他",
        )
        set_cell_text(table, 8, 2, "√是    □否")
        set_cell_text(table, 9, 2, "【待填：学院规定起止日期】")

        schedule = {
            11: ("查阅文献", "第5周（第七学期）至第7周（第七学期）"),
            12: ("文献综述和外文翻译", "第8周（第七学期）至第12周（第七学期）"),
            13: ("开题报告", "第13周（第七学期）至第17周（第七学期）"),
            14: ("研究、设计、开发", "第1周（第八学期）至第7周（第八学期）"),
            15: ("撰写毕业论文（说明）", "第8周（第八学期）至第12周（第八学期）"),
            16: ("答辩与修改", "第12周（第八学期）至第15周（第八学期）"),
        }
        for row, (activity, weeks) in schedule.items():
            set_cell_text(table, row, 1, activity)
            set_cell_text(table, row, 2, weeks)

        set_cell_text(table, 18, 1, MAIN_CONTENT)
        references_text = "推荐参考文献：\n" + "\n".join(
            f"[{index}] {reference}" for index, reference in enumerate(REFERENCES, 1)
        )
        set_cell_text(table, 19, 1, references_text)
        set_cell_text(
            table,
            20,
            1,
            "指导教师签名：____________________\n\n"
            "年    月    日",
        )
        set_cell_text(
            table,
            21,
            1,
            "毕业论文（设计）工作指导小组意见：\n\n"
            "□ 同意下达任务书       □ 不同意下达任务书\n\n"
            "负责人签名：____________________\n\n"
            "年    月    日",
        )

        # Preserve the source layout while improving readability for longer project text.
        for row, columns in {
            1: (2, 4, 6, 8),
            2: (2,),
            3: (2,),
            4: (2, 4, 6, 8),
            5: (2, 4, 6, 8),
            6: (2,),
            7: (2,),
            8: (2,),
            9: (2,),
        }.items():
            for column in columns:
                size = 10.0 if row in {2, 3, 6, 7} else 10.5
                format_cell(table, row, column, size=size, alignment=1, line_spacing=12.0)

        for row in range(11, 17):
            format_cell(table, row, 1, size=10.5, alignment=1, line_spacing=12.0)
            format_cell(table, row, 2, size=10.5, alignment=1, line_spacing=12.0)

        body_cell, _ = cell_range(table, 18, 1)
        reference_cell, _ = cell_range(table, 19, 1)
        format_paragraphs(body_cell, size=9.5, line_spacing=12.2)
        format_paragraphs(reference_cell, size=8.5, line_spacing=10.8, reference_list=True)
        format_cell(table, 20, 1, size=10.5, alignment=0, line_spacing=18.0)
        format_cell(table, 21, 1, size=10.5, alignment=0, line_spacing=14.0)
        format_signature_cell(table, 20)
        format_signature_cell(table, 21)

        for row, column in (
            (1, 2),
            (1, 4),
            (1, 6),
            (1, 8),
            (4, 2),
            (4, 4),
            (4, 8),
            (5, 2),
            (5, 4),
            (5, 6),
            (5, 8),
            (9, 2),
        ):
            mark_placeholder(table, row, column)

        table.Rows.Item(2).HeightRule = 1
        table.Rows.Item(2).Height = 30
        table.Rows.Item(3).HeightRule = 1
        table.Rows.Item(3).Height = 34
        table.Rows.Item(18).AllowBreakAcrossPages = True
        table.Rows.Item(19).AllowBreakAcrossPages = True

        # Remove personal metadata inherited from the reference file.
        try:
            document.RemoveDocumentInformation(99)  # wdRDIAll
        except Exception:
            pass

        document.Fields.Update()
        document.Repaginate()
        document.SaveAs2(str(OUTPUT_DOCX), FileFormat=12, AddToRecentFiles=False)
        document.ExportAsFixedFormat(str(OUTPUT_PDF), 17)

        pages = document.ComputeStatistics(2)  # wdStatisticPages
        words = document.ComputeStatistics(0)  # wdStatisticWords
        return {
            "docx": OUTPUT_DOCX,
            "pdf": OUTPUT_PDF,
            "review": OUTPUT_REVIEW,
            "pages": pages,
            "words": words,
            "references": len(REFERENCES),
            "journal_or_conference": journal_or_conference,
            "recent": recent,
        }
    finally:
        if document is not None:
            document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()


def main():
    parser = argparse.ArgumentParser(description="Generate the current project's graduation task book")
    parser.add_argument("--force", action="store_true", help="overwrite generated output files")
    args = parser.parse_args()
    result = generate(force=args.force)
    for key, value in result.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
