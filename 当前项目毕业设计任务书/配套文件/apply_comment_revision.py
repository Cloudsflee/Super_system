from __future__ import annotations

import argparse
import datetime as dt
import hashlib
from pathlib import Path
from xml.dom import minidom
from zipfile import ZipFile

import pythoncom
import win32com.client


OUTPUT_DIR = Path(__file__).resolve().parent
FINAL_DIR = OUTPUT_DIR.parent
SOURCE_DOCX = OUTPUT_DIR / "毕业论文（设计）任务书_面向超级个体的AI协作工作空间设计与实现_批注原稿.docx"

CHINESE_TITLE = "面向超级个体的AIGC协作开发工作流平台设计与实现"
ENGLISH_TITLE = "Design and Implementation of an AIGC-Driven Collaborative Development Workflow Platform for Solo Developers"

OUTPUT_DOCX = OUTPUT_DIR / f"毕业论文（设计）任务书_{CHINESE_TITLE}_根据批注四次修正版（无批注）.docx"
COMMENTED_OUTPUT_DOCX = FINAL_DIR / f"毕业论文（设计）任务书_{CHINESE_TITLE}_根据批注四次修正版（含批注回复）.docx"
OUTPUT_PDF = OUTPUT_DIR / f"毕业论文（设计）任务书_{CHINESE_TITLE}_根据批注四次修正版.pdf"
CHANGE_REPORT = OUTPUT_DIR / "任务书批注更改说明.md"

COMMENT_ANCHORS = [
    CHINESE_TITLE,
    "现有工程资料和代码只作为需求分析、方案选型与技术可行性验证的输入",
    "二、主要交付内容",
    "四、核心工程问题与处理重点",
    "三、系统开发方案与技术路线",
]

COMMENT_REPLIES = [
    "明白，老师列举的几个维度只是例子。我依据课题目标、维度边界和证据可获得性，选择任务有效性、工程产物质量、人机协作与可控性、过程可信与可追溯性、平台工程能力五个维度，分别评价任务是否做对、产物是否合格、用户能否控制AI、过程能否审计追溯以及平台能否可靠运行。没有选择“研发效能与资源效率”作为核心维度，是因为“可记录”不等于“可比较”，更不等于“可归因”：任务异质性、模型版本与随机性、多智能体并行使耗时、Token、重试和费用难以形成公平对照；这些数据只用于案例描述与运行诊断。",
    "这里已改写。前期工作只作为方案和可行性依据，最终成果按毕业设计阶段的原型、测试和数据验收。",
    "已重新整理为四个主要交付模块，需求内容和开发过程现在分开表述。",
    "已按需求与UE、架构与安全边界、实现集成、测试评价等开发环节重新组织。",
    "技术路线已按实际开发过程重写：我在现有原型上按版本迭代，提出需求和问题后与Codex讨论，Codex读取项目文档和代码分析方案并辅助实现；随后运行静态检查、单元、集成和端到端测试，由我检查页面与功能并继续反馈，直到本轮验收，后续仍沿用这一流程。",
]

WORDPROCESSINGML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


MAIN_CONTENT = """论文（设计）的主要内容及要求：（以设计作品为主要成果形式的毕业设计要求以各分院实施方案为准）
1、开题报告和文献阅读
（1）文献阅读：查阅文献15篇（含）以上，其中外文文献2篇（含）以上，近三年公开发表的文献5篇（含）以上，书籍不超过3本，期刊（[J]）和论文集（[C]）10篇（含）以上，包括导师指定的全部参考文献。
（2）外文翻译：3000字以上。
（3）文献综述：3000字以上，包括国内外研究现状、研究方向、进展情况、存在问题和参考依据等。
（4）开题报告：3000字以上，包括选题的意义、可行性分析、研究内容、研究方法、拟解决的关键问题、预期结果和研究进度计划等。
2、论文：10000字以上，包括绪论、正文、结论、参考文献等。法学、人文、经管类专业8000字以上，特殊专业应满足分院根据培养目标另行制定的相应要求。
3、课题要解决的主要问题和具体要求（填写如下）：
一、课题定位与目标
本课题选择独立开发者维护软件项目作为具体业务场景，设计并实现一个人工智能生成内容（Artificial Intelligence Generated Content，AIGC）协作开发工作流平台。平台以项目目标、需求资料、代码仓库、决策记录和验收标准为事实输入，通过模型上下文协议（Model Context Protocol，MCP）连接代码智能体、Git/GitHub及测试工具，把需求澄清、任务规划、代码执行、人工审查、测试和交付组织为可编辑、可执行、可追溯的工程闭环。
毕业设计以可运行平台原型和工程验证结果为主要成果。评价维度按照“与课题目标直接对应、相互边界清晰、能够取得可验证证据”三项原则确定。依据软件产品质量、人机协作、AI风险治理和平台工程研究，选择五个核心维度：（1）任务有效性，考察验收条件、需求覆盖和范围偏离；（2）工程产物质量，考察测试、缺陷返工、可维护性和安全问题；（3）人机协作与可控性，考察状态理解、澄清、审批、审查、撤销和人工接管；（4）过程可信与可追溯性，考察证据链、权限审批、复现恢复和敏感信息保护；（5）平台工程能力，考察可靠性、MCP互操作、Runner可替换性、工具集成和部署能力。五个维度分别回答任务是否做对、产物是否合格、用户能否控制AI、过程能否审计追溯以及平台能否可靠运行，并可由需求追踪、测试报告、交互事件、Trace/Asset和部署验证提供证据。没有将研发效能与资源效率列为核心维度，是因为真实AI开发任务难以等价，模型版本、随机输出和多智能体并行又使耗时、Token、重试与费用难以公平比较和归因；相关数据仅用于案例复盘和运行诊断，不据此宣称平台具有普遍的效率或成本优势。现有工程资料和代码只作为需求分析、方案选型与技术可行性验证的输入，不直接作为毕业设计成果；本阶段重新完成需求收敛、用户体验原型、架构设计、核心实现、测试与场景验证。
二、主要交付内容
（1）需求规格与用户体验（User Experience，UE）核心原型。依据项目现有核心想法、开发计划和Focus OS界面规范，形成独立开发者的典型用户旅程、功能范围、异常场景和验收标准；完成项目创建或导入、Project Brief确认、工作流成果视图与完整流程、Task工作区、Assist协作、审批、Diff Review、资产和交付结果等核心界面原型。
（2）工作流与项目上下文模块。采用“Project—Workflow—Workstream—Task”层级，把Project Brief中的功能、里程碑、风险和验收条件映射到可独立验收的任务；用Node Contract声明任务目标、输入、输出、允许工具和验收标准。AIGC生成候选工作流，确定性校验器检查依赖、需求覆盖和资产流，用户确认后形成正式版本；任务执行前由系统从显式输入、直接依赖、项目决策和仓库快照构建结构化上下文包（Context Pack）。
（3）MCP工具集成与受控执行模块。系统通过MCP能力目录和Runner Adapter接入Codex等代码智能体，页面、REST、MCP和终端入口复用同一业务服务、权限与审计规则。任务在受管Repository Workspace及隔离worktree中执行，记录命令、文件变更、工具调用和状态事件；写入、敏感操作和外部交付经过人工确认、checkpoint与Diff Review，凭据不进入Context Pack、Trace或前端响应。
（4）资产证据与工程交付模块。将需求、决策、代码变更、测试报告和交付记录保存为带版本和来源关系的Asset，使用Trace、Workspace Digest、内容哈希及证明记录关联任务输入、执行过程与输出。验收通过后形成Git提交或Draft Pull Request，并以需求追踪、工程产物、人工决策、过程证据和平台测试数据支撑五维评价；任务耗时、模型用量、工具调用和重试只作为具体运行的描述与诊断信息。
三、系统开发方案与技术路线
系统前端采用React、TypeScript和Vite实现项目接入、工作流画布、Task工作区、Assist、审批和审查界面；后端采用Node.js实现项目、工作流、上下文、资产、权限、执行与交付服务，原型阶段使用JSON-local本地持久化并保留Prisma数据模型。MCP Gateway负责Agent入口，Core保留能力目录、业务状态、审批、凭据和执行权威；Runner Adapter对接Codex等执行器，Runner在Docker或受管本地环境中运行，Git受管checkout/worktree隔离代码写入。
本课题将在现有系统原型基础上继续采用当前的AIGC辅助版本迭代方式。每轮先由本人根据使用体验、现有问题和阶段目标提出需求，形成该版本的开发计划、测试计划和验收项；再与Codex讨论需求，允许其读取项目文档、现有代码和报错信息，分析受影响模块并给出实现方案，由本人通过追问、补充约束和反馈确认方案。方案明确后，由Codex辅助修改前端、后端、MCP集成、Runner及工程脚本等相关代码，并同步补充或调整测试。
实现后根据改动范围运行lint、typecheck、单元测试、集成测试、Playwright端到端测试和Web构建；出现失败时根据日志继续定位和修复。自动化检查通过后，由本人实际打开页面、操作对应功能并检查交互与结果，再把发现的问题反馈给Codex继续修改和复测，直到该版本的功能与测试满足验收要求。阶段稳定后更新开发文档和版本记录，并通过Git保存代码版本，再进入下一轮需求与迭代。后续开发继续沿用这一实际流程，不把平台内部的用户工作流或尚未实际采用的功能作为开发本系统的方法。
四、核心工程问题与处理重点
（1）需求与UE核心原型的范围一致性。Project Brief作为需求基线，功能、验收条件、里程碑和风险均需映射到负责的Workstream/Task；界面同时呈现目标、依据、执行状态、阻塞原因和人工决策入口，使用户能够理解并控制AIGC工作过程。
（2）架构设计中的上下文主权与组件可替换性。项目上下文、资产、决策和Trace由平台持有，代码智能体只消费按任务组装的Context Pack；Runner Adapter和MCP能力目录隔离具体模型及工具差异，REST、MCP和网页入口统一调用领域服务。
（3）实现集成中的执行边界与状态一致性。外部代码源保持只读，写操作限定在受管checkout/worktree；权限、路径、敏感信息、写锁、幂等、checkpoint、失败恢复和仓库快照共同约束长任务执行，避免并发覆盖、重复交付和越权访问。
（4）测试评价中的证据充分性与结论边界。采用标准化系统测试和代表性场景案例，分别验证功能验收、产物质量、人工控制、证据追溯和平台可靠性。案例可记录耗时、Token、重试和人工决策，用于还原执行过程和识别运行开销；但由于任务异质性、模型变化、随机输出和多智能体并行，不将这些数据用于跨工具或跨运行条件的研发效率与成本因果比较，结论明确说明样本与外部服务限制。
五、开发过程与进度要求
各阶段均沿用上述实际开发流程：提出本轮需求，与Codex讨论并确认方案，完成代码修改和自动化测试，再由本人检查页面与功能并反馈修正，直至达到本轮验收要求。
（1）需求与UE原型阶段：以核心想法、愿景范围、开发计划和现有界面规范为输入，完成场景边界、用户旅程、需求规格、非功能要求、信息架构和可交互原型，并建立需求到验收标准的追踪表。
（2）架构与最小闭环阶段：完成领域模型、模块边界、接口、权限和数据方案，优先跑通“Project Brief—Workflow—Task—Context Pack—受控执行—Diff Review—测试—交付”的最小闭环。
（3）实现集成与质量加固阶段：分阶段接入Codex Runner、MCP、受管仓库、资产证据和Git/GitHub交付；每个增量配置单元、集成和端到端测试，并覆盖路径隔离、敏感信息、幂等、审批、回滚和异常恢复。
（4）场景验证与成果交付阶段：选择具有代表性的功能增量和异常处理场景，验证平台闭环及五维评价要求；根据测试、可用性与案例证据优化工作流、上下文和交互，运行时间与模型用量只作案例说明，最终完成部署包、源代码、项目文档、测试报告、场景验证报告和答辩材料。
六、预期成果与验收要求
（1）提交可运行的平台原型及源代码，完整演示项目接入、Brief确认、工作流生成与校验、Task上下文构建、受控执行、人工审查、自动化测试、资产绑定和Git交付。
（2）提交需求规格、UE核心原型、系统架构与数据模型、接口说明、部署运行手册、测试用例、需求追踪矩阵和场景验证报告，关键结论可追溯到代码、测试、Trace、Asset或版本库记录。
（3）系统通过静态检查、单元测试、集成测试和端到端测试，重点验证需求覆盖、上下文范围、权限路径、敏感信息、审批幂等、失败恢复、输出绑定和交付一致性；未执行的真实外部服务测试明确标记。
（4）至少完成两类代表性软件开发场景验证，分别覆盖功能增量和带异常或安全约束的任务；每个场景保留需求、上下文、执行、审批、Diff、测试和交付证据，按任务有效性、工程产物质量、人机协作与可控性、过程可信与可追溯性、平台工程能力报告结果及局限。涉及时间、Token和费用的数据注明任务、模型、版本、上下文与环境，仅作为描述性证据。
（5）平台形成需求、决策、执行、测试和交付的证据链，正式Task的必需输出全部绑定并通过验收后方可完成，代码交付包含Diff、测试结果、提交或Draft PR记录。
（6）完成不少于10000字的毕业论文（设计说明书），包括绪论、相关工作、需求与UE设计、系统架构、实现、测试与工程评价、结论与展望，并按GB/T 7714—2015著录参考文献。"""


REFERENCES = [
    "WANG L, MA C, FENG X, et al. A survey on large language model based autonomous agents[J]. Frontiers of Computer Science, 2024, 18(6): 186345. DOI:10.1007/s11704-024-40231-1.",
    "BECKER J, RUSH N, CUNNINGHAM T, et al. We are changing our developer productivity experiment design[EB/OL]. (2026-02-24)[2026-07-23]. https://metr.org/blog/2026-02-24-uplift-update/.",
    "WANG Y, ZHONG W, HUANG Y, et al. Agents in software engineering: Survey, landscape, and vision[J]. Automated Software Engineering, 2025, 32(2): 70. DOI:10.1007/s10515-025-00544-2.",
    "QIAN C, LIU W, LIU H, et al. ChatDev: Communicative agents for software development[C]//Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics. Bangkok: Association for Computational Linguistics, 2024: 15174-15186. DOI:10.18653/v1/2024.acl-long.810.",
    "YANG J, JIMENEZ C E, WETTIG A, et al. SWE-agent: Agent-computer interfaces enable automated software engineering[C]//Advances in Neural Information Processing Systems 37. [S.l.]: Neural Information Processing Systems Foundation, 2024: 50528-50652. DOI:10.52202/079017-1601.",
    "BARKE S, JAMES M B, POLIKARPOVA N. Grounded Copilot: How programmers interact with code-generating models[J]. Proceedings of the ACM on Programming Languages, 2023, 7(OOPSLA1): 85-111. DOI:10.1145/3586030.",
    "VAITHILINGAM P, ZHANG T, GLASSMAN E L. Expectation vs. experience: Evaluating the usability of code generation tools powered by large language models[C]//CHI Conference on Human Factors in Computing Systems Extended Abstracts. New York: ACM, 2022: 1-7. DOI:10.1145/3491101.3519665.",
    "CUI K Z, DEMIRER M, JAFFE S, et al. The productivity effects of generative AI: Evidence from a field experiment with GitHub Copilot[J/OL]. An MIT Exploration of Generative AI, 2024[2026-07-22]. DOI:10.21428/e4baedd9.3ad85f1c.",
    "AMERSHI S, WELD D, VORVOREANU M, et al. Guidelines for human-AI interaction[C]//Proceedings of the 2019 CHI Conference on Human Factors in Computing Systems. New York: ACM, 2019: 1-13. DOI:10.1145/3290605.3300233.",
    "FORSGREN N, STOREY M A, MADDILA C, et al. The SPACE of developer productivity: There's more to it than you think[J]. Queue, 2021, 19(1): 20-48. DOI:10.1145/3454122.3454124.",
    "NODA A, STOREY M A, FORSGREN N, et al. DevEx: What actually drives productivity[J]. Queue, 2023, 21(2): 35-53. DOI:10.1145/3595878.",
    "LEE J D, SEE K A. Trust in automation: Designing for appropriate reliance[J]. Human Factors, 2004, 46(1): 50-80. DOI:10.1518/hfes.46.1.50_30392.",
    "HART S G, STAVELAND L E. Development of NASA-TLX (Task Load Index): Results of empirical and theoretical research[A]//HANCOCK P A, MESHKATI N. Human Mental Workload. Amsterdam: North-Holland, 1988: 139-183. DOI:10.1016/S0166-4115(08)62386-9.",
    "PEARCE H, AHMAD B, TAN B, et al. Asleep at the keyboard? Assessing the security of GitHub Copilot's code contributions[C]//2022 IEEE Symposium on Security and Privacy. Los Alamitos, CA: IEEE, 2022: 754-768. DOI:10.1109/SP46214.2022.9833571.",
    "PERRY N, SRIVASTAVA M, KUMAR D, et al. Do users write more insecure code with AI assistants?[C]//Proceedings of the 2023 ACM SIGSAC Conference on Computer and Communications Security. New York: ACM, 2023: 2785-2799. DOI:10.1145/3576915.3623157.",
    "VAN DER AALST W M P, TER HOFSTEDE A H M, KIEPUSZEWSKI B, et al. Workflow patterns[J]. Distributed and Parallel Databases, 2003, 14(1): 5-51. DOI:10.1023/A:1022883727209.",
    "MOREAU L, CLIFFORD B, FREIRE J, et al. The Open Provenance Model core specification (v1.1)[J]. Future Generation Computer Systems, 2011, 27(6): 743-756. DOI:10.1016/j.future.2010.07.005.",
    "DORA. DORA's software delivery performance metrics[EB/OL]. [2026-07-23]. https://dora.dev/guides/dora-metrics/.",
    "INTERNATIONAL ORGANIZATION FOR STANDARDIZATION. ISO/IEC 25010:2023 Systems and software engineering—Systems and software Quality Requirements and Evaluation (SQuaRE)—Product quality model[S]. Geneva: ISO, 2023.",
    "INTERNATIONAL ORGANIZATION FOR STANDARDIZATION. ISO/IEC 25023:2016 Systems and software engineering—Systems and software Quality Requirements and Evaluation (SQuaRE)—Measurement of system and software product quality[S]. Geneva: ISO, 2016.",
    "INTERNATIONAL ORGANIZATION FOR STANDARDIZATION. ISO/IEC 25059:2023 Software engineering—Systems and software Quality Requirements and Evaluation (SQuaRE)—Quality model for AI systems[S]. Geneva: ISO, 2023.",
    "INTERNATIONAL ORGANIZATION FOR STANDARDIZATION. ISO 9241-11:2018 Ergonomics of human-system interaction—Part 11: Usability: Definitions and concepts[S]. Geneva: ISO, 2018.",
    "TABASSI E. Artificial Intelligence Risk Management Framework (AI RMF 1.0)[R]. Gaithersburg, MD: National Institute of Standards and Technology, 2023. DOI:10.6028/NIST.AI.100-1.",
    "MODEL CONTEXT PROTOCOL. Model Context Protocol specification: 2025-06-18[EB/OL]. (2025-06-18)[2026-07-22]. https://modelcontextprotocol.io/specification/2025-06-18.",
    "WORLD WIDE WEB CONSORTIUM. PROV-DM: The PROV data model[S/OL]. (2013-04-30)[2026-07-22]. https://www.w3.org/TR/2013/REC-prov-dm-20130430/.",
]

REFERENCE_META = [
    ("J", 2024), ("EB", 2026), ("J", 2025), ("C", 2024),
    ("C", 2024), ("J", 2023), ("C", 2022), ("J", 2024),
    ("C", 2019), ("J", 2021), ("J", 2023), ("J", 2004),
    ("A", 1988), ("C", 2022), ("C", 2023), ("J", 2003),
    ("J", 2011), ("EB", 2026), ("S", 2023), ("S", 2016),
    ("S", 2023), ("S", 2018), ("R", 2023), ("EB", 2025),
    ("S", 2013),
]

CHANGE_ACTIONS = [
    "将老师所列内容理解为方向示例；依据课题目标、维度边界和证据可获得性说明选择五个核心维度的理由，并说明没有选择研发效能与资源效率的原因：相关数据难以公平比较和归因，只作案例诊断。",
    "不再单独辩解既有版本；把现有工程资料和代码明确列为需求、选型与可行性输入，本阶段成果改由重新形成的原型、实现、测试和场景验证数据验收。",
    "按项目实际模块重写为需求与UE、工作流与上下文、MCP工具与受控执行、资产证据与工程交付四部分，开发过程另节表述。",
    "删除连续的“如何”问句，改为需求与UE范围一致性、架构主权与可替换性、实现边界与状态一致性、测试证据充分性与结论边界四项工程处理重点。",
    "按本人当前开发原型的实际方式重写技术路线：以版本需求和问题为起点，与Codex讨论并确认方案，由Codex读取现有文档与代码后辅助实现；运行静态、单元、集成、E2E和构建检查，再由本人检查页面与功能、反馈问题并继续迭代，稳定后更新文档和Git版本。",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def cell_range(table, row: int, column: int):
    cell = table.Cell(row, column)
    rng = cell.Range.Duplicate
    rng.End -= 1
    return cell, rng


def cell_text(table, row: int, column: int) -> str:
    _, rng = cell_range(table, row, column)
    return rng.Text.strip()


def set_cell_text(table, row: int, column: int, text: str):
    cell, rng = cell_range(table, row, column)
    rng.Text = text.replace("\n", "\r")
    return cell, rng


def set_font(rng, *, size: float, bold: bool = False):
    rng.Font.Name = "Times New Roman"
    rng.Font.NameAscii = "Times New Roman"
    rng.Font.NameFarEast = "宋体"
    rng.Font.Size = size
    rng.Font.Bold = -1 if bold else 0


def format_value_cell(table, row: int, column: int, size: float = 10.5):
    cell, rng = cell_range(table, row, column)
    set_font(rng, size=size)
    rng.Font.ColorIndex = 0
    rng.HighlightColorIndex = 0
    rng.ParagraphFormat.Alignment = 1
    rng.ParagraphFormat.LeftIndent = 0
    rng.ParagraphFormat.RightIndent = 0
    rng.ParagraphFormat.FirstLineIndent = 0
    rng.ParagraphFormat.SpaceBefore = 0
    rng.ParagraphFormat.SpaceAfter = 0
    rng.ParagraphFormat.LineSpacingRule = 4
    rng.ParagraphFormat.LineSpacing = 12
    cell.VerticalAlignment = 1


def format_body(cell):
    headings = (
        "论文（设计）的主要内容及要求", "1、开题报告和文献阅读",
        "2、论文：", "3、课题要解决的主要问题", "一、", "二、",
        "三、", "四、", "五、", "六、",
    )
    narrative_starts = (
        "本课题选择", "毕业设计以", "系统前端采用", "本课题将在现有系统原型基础上",
    )
    for index in range(1, cell.Range.Paragraphs.Count + 1):
        para = cell.Range.Paragraphs.Item(index)
        text = para.Range.Text.rstrip("\r\x07").strip()
        set_font(para.Range, size=9.8)
        para.Format.Alignment = 3 if text else 0
        para.Format.LeftIndent = 0
        para.Format.RightIndent = 0
        para.Format.FirstLineIndent = 19.6 if text.startswith(narrative_starts) else 0
        para.Format.SpaceBefore = 0
        para.Format.SpaceAfter = 0
        para.Format.LineSpacingRule = 4
        para.Format.LineSpacing = 12.6
        if text.startswith(headings):
            para.Range.Font.Bold = -1
            para.Format.Alignment = 0


def format_references(cell):
    for index in range(1, cell.Range.Paragraphs.Count + 1):
        para = cell.Range.Paragraphs.Item(index)
        set_font(para.Range, size=9.5)
        para.Format.Alignment = 3 if index > 1 else 0
        para.Format.LeftIndent = 14 if index > 1 else 0
        para.Format.RightIndent = 0
        para.Format.FirstLineIndent = -14 if index > 1 else 0
        para.Format.SpaceBefore = 0
        para.Format.SpaceAfter = 0
        para.Format.LineSpacingRule = 4
        para.Format.LineSpacing = 12.2
        if index == 1:
            para.Range.Font.Bold = -1


def validate_references():
    if len(REFERENCES) != len(REFERENCE_META) or len(REFERENCES) < 15:
        raise ValueError("参考文献数量或元数据不一致")
    journal_or_conference = sum(kind in {"J", "C"} for kind, _ in REFERENCE_META)
    recent = sum(year >= 2024 for _, year in REFERENCE_META)
    foreign = len(REFERENCES)
    if journal_or_conference < 10 or recent < 5 or foreign < 2:
        raise ValueError("参考任务书的文献数量要求未满足")
    return journal_or_conference, recent, foreign


def collect_comments(document):
    result = []
    for index in range(1, document.Comments.Count + 1):
        comment = document.Comments.Item(index)
        raw_text = str(comment.Range.Text)
        result.append({
            "index": index,
            "author": str(comment.Author),
            "initial": str(comment.Initial),
            "date": comment.Date.strftime("%Y-%m-%d %H:%M:%S"),
            "scope": comment.Scope.Text.replace("\r", " ").replace("\x07", " ").strip(),
            "text": raw_text.replace("\r", " ").replace("\x07", " ").strip(),
            "raw_text": raw_text,
        })
    return result


def restore_comments(document, comments):
    if len(comments) != len(COMMENT_ANCHORS):
        raise ValueError("批注与修改后锚点数量不一致")

    restored_comments = []
    for comment, anchor_text in zip(comments, COMMENT_ANCHORS, strict=True):
        anchor_range = document.Content.Duplicate
        finder = anchor_range.Find
        finder.ClearFormatting()
        finder.Text = anchor_text
        finder.Forward = True
        finder.Wrap = 0
        finder.Format = False
        if not finder.Execute():
            raise ValueError(f"修改版中找不到批注锚点：{anchor_text}")

        restored = document.Comments.Add(anchor_range, comment["raw_text"])
        restored.Author = comment["author"]
        restored.Initial = comment["initial"]
        restored_comments.append(restored)
    return restored_comments


def add_comment_replies(restored_comments):
    if len(restored_comments) != len(COMMENT_REPLIES):
        raise ValueError("批注与回复数量不一致")
    for comment, reply_text in zip(restored_comments, COMMENT_REPLIES, strict=True):
        reply = comment.Replies.Add(comment.Range.Duplicate, reply_text)
        reply.Author = "曹志隆"
        reply.Initial = "C"


def restore_comment_dates(source_docx: Path, target_docx: Path):
    def read_comments_xml(path: Path):
        with ZipFile(path, "r") as package:
            return package.read("word/comments.xml")

    def comment_text(node) -> str:
        parts = []
        for text_node in node.getElementsByTagNameNS(WORDPROCESSINGML_NS, "t"):
            parts.extend(
                child.data
                for child in text_node.childNodes
                if child.nodeType in {child.TEXT_NODE, child.CDATA_SECTION_NODE}
            )
        return "".join(parts)

    source_xml = minidom.parseString(read_comments_xml(source_docx))
    source_dates = {}
    for node in source_xml.getElementsByTagNameNS(WORDPROCESSINGML_NS, "comment"):
        key = (node.getAttributeNS(WORDPROCESSINGML_NS, "author"), comment_text(node))
        source_dates[key] = node.getAttributeNS(WORDPROCESSINGML_NS, "date")

    target_xml = minidom.parseString(read_comments_xml(target_docx))
    target_comments = target_xml.getElementsByTagNameNS(WORDPROCESSINGML_NS, "comment")
    restored_date_count = 0
    reply_metadata_count = 0
    for node in target_comments:
        text = comment_text(node)
        key = (node.getAttributeNS(WORDPROCESSINGML_NS, "author"), text)
        if key in source_dates:
            node.setAttributeNS(
                WORDPROCESSINGML_NS,
                "w:date",
                source_dates[key],
            )
            restored_date_count += 1
        if text in COMMENT_REPLIES:
            node.setAttributeNS(WORDPROCESSINGML_NS, "w:author", "曹志隆")
            node.setAttributeNS(WORDPROCESSINGML_NS, "w:initials", "C")
            reply_metadata_count += 1
    if restored_date_count != len(source_dates):
        raise ValueError("未能恢复全部原始批注时间")
    if reply_metadata_count != len(COMMENT_REPLIES):
        raise ValueError("未能设置全部批注回复作者")

    updated_comments_xml = target_xml.toxml(encoding="UTF-8", standalone=True)
    temporary_docx = target_docx.with_name(f".{target_docx.name}.tmp")
    try:
        with ZipFile(target_docx, "r") as source_package, ZipFile(temporary_docx, "w") as target_package:
            for entry in source_package.infolist():
                data = (
                    updated_comments_xml
                    if entry.filename == "word/comments.xml"
                    else source_package.read(entry.filename)
                )
                target_package.writestr(entry, data)
        temporary_docx.replace(target_docx)
    finally:
        if temporary_docx.exists():
            temporary_docx.unlink()


def escape_markdown(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def build_change_report(
    comments,
    *,
    pages: int,
    journal_or_conference: int,
    recent: int,
    foreign: int,
) -> str:
    rows = []
    anchors = ["中文题目处", "“AI Workspace System V1.9工程原型”", "主要研究与设计内容开头", "拟解决的关键问题开头", "基本技术路线开头"]
    for comment, anchor, action in zip(comments, anchors, CHANGE_ACTIONS, strict=True):
        scope = comment["scope"] or anchor
        rows.append(
            f'| {comment["index"]} | {escape_markdown(scope)} | '
            f'{escape_markdown(comment["text"])} | {escape_markdown(action)} |'
        )
    comment_rows = "\n".join(rows)
    reply_rows = "\n".join(
        f"| {index} | {escape_markdown(reply)} |"
        for index, reply in enumerate(COMMENT_REPLIES, 1)
    )
    references = "\n".join(f"[{index}] {reference}" for index, reference in enumerate(REFERENCES, 1))
    return f"""# 任务书批注第四次更改说明

> 修改日期：{dt.date.today().isoformat()}  
> 批注原稿：`{SOURCE_DOCX.name}`  
> 无批注版：`{OUTPUT_DOCX.name}`  
> 最终版（位于配套文件夹的上一级目录）：`{COMMENTED_OUTPUT_DOCX.name}`  
> 同步PDF：`{OUTPUT_PDF.name}`

## 处理原则

本次为第四次修正。针对第1条批注，老师列举的内容作为方向示例理解；正文依据课题目标、维度边界和证据可获得性，说明为什么选择五个核心维度，以及为什么没有选择研发效能与资源效率。“可记录”不等于“可比较”，更不等于“可归因”，因此时间、Token、重试和费用只作为案例描述与运行诊断。技术路线按照本人当前开发原型的真实过程表述：提出版本需求，与Codex讨论并确认方案，由Codex辅助修改代码，运行分层自动化测试，本人检查页面和功能后继续反馈迭代，稳定后更新文档与Git版本；后续沿用同一方式。修改版保留批注稿中已填写的学生及指导教师事实信息，不修改选题类型、选题来源、周次安排和签名栏；学院正式起止日期仍无可靠来源，因此继续保留待填标记。

批注原稿以只读方式迁入项目，SHA-256为 `{sha256(SOURCE_DOCX)}`，没有覆盖桌面源文件。最终版保留5条原始批注、原作者和原时间，并由学生对每条批注作一句简短回复；另提供无批注版和PDF供提交或打印。

## 本次论证依据

- 效率比较的条件：SPACE指出生产力不能由单一活动指标代表；DevEx说明开发体验受反馈回路、认知负荷和心流共同影响；METR在2026年调整开发者生产力实验设计，直接讨论多智能体并行、等待期间切换任务等因素如何削弱单任务耗时的可测量性与可比性。
- 产品质量与可用性：ISO/IEC 25010、25023用于功能适合性、可靠性、可维护性、安全性等产品质量及测量；ISO/IEC 25059补充AI系统质量；ISO 9241-11区分有效性、效率和满意度。
- 人机协作与治理：Human-AI Interaction Guidelines、适当信任研究和NASA-TLX支撑可控性、信任与认知负荷指标；NIST AI RMF、代码生成安全研究支撑可信、安全和风险指标。
- 过程证据与平台能力：W3C PROV、Open Provenance Model、MCP规范支撑来源关系、可追溯性和互操作性指标。
- 项目工程资料：`doc/核心想法.MD`、`开发计划v1.9.md`、`测试计划v1.9.md`、UE与MCP架构文档以及当前代码用于核对实际系统边界和可采集数据。
- 五个维度的推导、边界、证据来源以及未选择效能维度的理由，见 `五个核心评价维度的选择依据.md`；系统开发路线梳理见 `系统开发技术路线说明.md`。

## 逐条批注处理

| 序号 | 批注位置/原文 | 批注意见 | 实际修改 |
|---:|---|---|---|
{comment_rows}

## 批注回复

| 序号 | 学生回复 |
|---:|---|
{reply_rows}

## 结构调整

1. 正文从“批注回应”改为“项目任务”，统一落到独立开发者维护软件项目的真实业务链路。
2. 四个交付模块直接对应项目领域对象和实现边界，不再使用泛化的工作空间能力清单。
3. 关键问题全部改为陈述式工程处理重点，删除连续的“如何”问句。
4. 技术路线按本人当前开发原型的实际过程表述：版本需求与计划、Codex辅助分析和实现、分层自动化测试、本人页面与功能检查、问题反馈修正、文档与Git版本整理，并循环进入下一版本。
5. 现有代码和历史版本只作为需求、选型和可行性输入；毕业设计成果以本阶段重新形成的原型、实现、测试和场景验证数据为准。
6. 核心评价采用任务有效性、工程产物质量、人机协作与可控性、过程可信与可追溯性、平台工程能力五个维度，并绑定需求追踪、量表、运行事件、测试报告和版本库证据。
7. 没有把研发效能与资源效率列为核心维度，不计算缺少可比基础的效率或成本差异；时间、Token、重试和费用只作具体案例的描述与运行诊断，并报告样本和外部服务限制。

## 保留与待确认项

- 已保留：曹志隆、32301288、软件工程2304、13868360863；侯宏仑、副教授、计算机与计算科学学院、13071858629。
- 已保留：工程设计、学校自选项目、社会实践“是”及第七/第八学期周次安排。
- 待确认：学院规定的毕业论文（设计）正式起止日期、第二指导教师（如有）、最终签名与日期。
- 题目调整属于对第1条批注的实质响应，提交前应由指导教师确认新题目是否作为学院系统中的正式题目。

## 成品核验

| 核验项 | 结果 |
|---|---:|
| PDF页数 | {pages} |
| 无批注版Word批注 | 0 |
| 最终版原始批注 | 5 |
| 最终版批注回复 | 5 |
| 两个修改版的修订记录 | 0 |
| 参考文献总数 | {len(REFERENCES)} |
| 外文文献 | {foreign} |
| 2024年以来文献 | {recent} |
| 期刊/会议文献 | {journal_or_conference} |

## 修改后推荐参考文献

{references}
"""


def generate(force: bool = False):
    if not SOURCE_DOCX.exists():
        raise FileNotFoundError(f"找不到批注原稿：{SOURCE_DOCX}")
    journal_or_conference, recent, foreign = validate_references()

    outputs = (
        (OUTPUT_DOCX, OUTPUT_DIR),
        (COMMENTED_OUTPUT_DOCX, FINAL_DIR),
        (OUTPUT_PDF, OUTPUT_DIR),
        (CHANGE_REPORT, OUTPUT_DIR),
    )
    for path, expected_parent in outputs:
        if path.exists() and not force:
            raise FileExistsError(f"输出已存在；如需覆盖请使用 --force：{path}")
        if path.exists():
            if path.resolve().parent != expected_parent.resolve():
                raise RuntimeError(f"输出文件不在预期目录：{path}")
            path.unlink()

    pythoncom.CoInitialize()
    word = None
    document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        word.ScreenUpdating = False
        document = word.Documents.Open(
            str(SOURCE_DOCX),
            ConfirmConversions=False,
            ReadOnly=True,
            AddToRecentFiles=False,
        )
        table = document.Tables.Item(1)
        document.TrackRevisions = False

        expected = {
            (1, 2): "曹志隆", (1, 4): "32301288", (1, 6): "软件工程2304",
            (1, 8): "13868360863", (4, 2): "侯宏仑", (4, 4): "副教授",
            (4, 6): "计算机与计算科学学院", (4, 8): "13071858629",
        }
        for position, value in expected.items():
            actual = cell_text(table, *position)
            if value not in actual:
                raise ValueError(f"批注稿身份字段与预期不符：{position}={actual!r}")

        comments = collect_comments(document)
        if len(comments) != 5:
            raise ValueError(f"预期5条批注，实际{len(comments)}条")
        while document.Comments.Count:
            document.Comments.Item(1).Delete()
        if document.Revisions.Count:
            document.AcceptAllRevisions()

        set_cell_text(table, 2, 2, CHINESE_TITLE)
        set_cell_text(table, 3, 2, ENGLISH_TITLE)
        set_cell_text(table, 18, 1, MAIN_CONTENT)
        set_cell_text(
            table,
            19,
            1,
            "推荐参考文献：\n" + "\n".join(
                f"[{index}] {reference}" for index, reference in enumerate(REFERENCES, 1)
            ),
        )

        for row, columns in {
            1: (2, 4, 6, 8), 2: (2,), 3: (2,), 4: (2, 4, 6, 8), 5: (2, 4, 6, 8),
        }.items():
            for column in columns:
                format_value_cell(table, row, column, 9.5 if row == 3 else 10.5)

        body_cell, _ = cell_range(table, 18, 1)
        reference_cell, _ = cell_range(table, 19, 1)
        format_body(body_cell)
        format_references(reference_cell)
        table.Rows.Item(2).HeightRule = 1
        table.Rows.Item(2).Height = 30
        table.Rows.Item(3).HeightRule = 1
        table.Rows.Item(3).Height = 38
        table.Rows.Item(18).AllowBreakAcrossPages = True
        table.Rows.Item(19).AllowBreakAcrossPages = True

        document.TrackRevisions = False
        if document.Revisions.Count:
            document.AcceptAllRevisions()
        document.Fields.Update()
        document.Repaginate()
        document.SaveAs2(str(OUTPUT_DOCX), FileFormat=12, AddToRecentFiles=False)
        document.ExportAsFixedFormat(str(OUTPUT_PDF), 17)
        pages = document.ComputeStatistics(2)
        if document.Comments.Count or document.Revisions.Count:
            raise RuntimeError("修改版仍包含批注或修订")

        restored_comments = restore_comments(document, comments)
        if document.Comments.Count != len(comments) or document.Revisions.Count:
            raise RuntimeError("保留原批注版的批注或修订数量不正确")
        add_comment_replies(restored_comments)
        if any(comment.Replies.Count != 1 for comment in restored_comments):
            raise RuntimeError("批注回复数量不正确")
        document.SaveAs2(str(COMMENTED_OUTPUT_DOCX), FileFormat=12, AddToRecentFiles=False)
    finally:
        if document is not None:
            document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()

    restore_comment_dates(SOURCE_DOCX, COMMENTED_OUTPUT_DOCX)
    CHANGE_REPORT.write_text(
        build_change_report(
            comments,
            pages=pages,
            journal_or_conference=journal_or_conference,
            recent=recent,
            foreign=foreign,
        ),
        encoding="utf-8",
    )
    return {
        "docx": OUTPUT_DOCX,
        "commented_docx": COMMENTED_OUTPUT_DOCX,
        "pdf": OUTPUT_PDF,
        "change_report": CHANGE_REPORT,
        "pages": pages,
        "comments_removed": len(comments),
        "comments_restored": len(comments),
        "comment_replies": len(COMMENT_REPLIES),
        "references": len(REFERENCES),
        "journal_or_conference": journal_or_conference,
        "recent": recent,
    }


def main():
    parser = argparse.ArgumentParser(description="Apply the five Word comments to the task book")
    parser.add_argument("--force", action="store_true", help="overwrite generated revision outputs")
    args = parser.parse_args()
    result = generate(force=args.force)
    for key, value in result.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
