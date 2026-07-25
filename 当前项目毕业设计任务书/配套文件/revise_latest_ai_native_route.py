from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
from pathlib import Path

import pythoncom
import win32com.client


SUPPORT_DIR = Path(__file__).resolve().parent
BASE_DIR = SUPPORT_DIR.parent
FINAL_DOCX = BASE_DIR / "毕业论文（设计）任务书_面向超级个体的AIGC协作开发工作流平台设计与实现_根据批注四次修正版（含批注回复）.docx"
CLEAN_DOCX = SUPPORT_DIR / "毕业论文（设计）任务书_面向超级个体的AIGC协作开发工作流平台设计与实现_根据批注四次修正版（无批注）.docx"
OUTPUT_PDF = SUPPORT_DIR / "毕业论文（设计）任务书_面向超级个体的AIGC协作开发工作流平台设计与实现_根据批注四次修正版.pdf"


TECH_ROUTE_TEXT = """系统采用“AIGC编排层+确定性控制层”的双层技术架构：AIGC负责根据目标动态规划任务、选择工具、观察结果并决定是否修正或重规划；Node.js控制层负责权限、状态持久化、结构校验、审批和安全边界，不用固定业务顺序代替AI规划。
（1）目标与上下文建模：将用户目标、Project Brief、需求资料、代码仓库快照、约束条件和验收标准组织为结构化输入，并建立MCP能力目录，使AIGC能够同时理解“要完成什么、当前项目是什么状态、可以调用哪些能力”。
（2）动态工作流生成：由LLM Orchestrator依据目标和上下文执行Plan-and-Execute规划，动态生成Workstream/Task组成的DAG、依赖关系、输入输出和验收标准，而不是预置固定节点。确定性校验器检查DAG无环、需求覆盖、依赖完整和能力可用性，用户确认后形成正式工作流。
（3）智能体任务与MCP编排：每个Task作为具有目标、上下文、可用工具和完成条件的智能体任务。AIGC根据当前计划和执行观察自主选择MCP工具、代码执行器及调用顺序；Node.js后端提供统一能力入口和执行约束，不硬编码每类任务的业务路径。
（4）动态Context Pack与记忆组织：执行前按Task从显式输入、直接依赖、项目决策、相关代码和仓库快照中检索、压缩并组装最小充分Context Pack；上下文随任务和版本动态更新，避免把全部历史对话直接塞给模型，并降低信息遗漏、冲突和上下文漂移。
（5）执行、反思与自我修正：采用“Plan—Execute—Observe—Reflect”循环，智能体执行工具或修改代码后读取测试、命令和错误结果，在限定次数内反思原因并修正；当目标、依赖或验收条件发生变化时生成重规划提案，超过重试上限、置信度不足或涉及高风险操作时转交人工处理。
（6）人机协同与确定性治理：用户负责确认目标、正式工作流、高风险写入和最终交付，并通过审批、Diff Review、撤销和人工接管保持控制。受管worktree、权限校验、凭据隔离、幂等和失败恢复约束智能体行为；这些机制提供安全边界，但不替代AIGC的动态规划与工具决策。
（7）分层测试与AI Eval：对权限、状态、接口、数据和安全边界继续执行单元、集成、端到端、故障和安全测试；对动态工作流、工具选择、上下文构造、反思和重规划建立版本化Eval场景集。在固定Brief、仓库快照、模型、Prompt和能力集合下重复运行，评价需求覆盖、DAG有效性与可执行性、工具选择正确性、验收通过、范围偏离及自我修正结果；Prompt、模型或编排策略变化后执行回归Eval并报告波动和局限。
（8）集成部署与迭代优化：集成Codex、MCP、Git/GitHub和Docker，完成代表性软件任务及异常场景验证；依据Eval、自动化测试和人工审查结果迭代Prompt模板、规划器、Context Pack选择策略、工具权限、停止条件和交互方式，最终完成可运行原型、部署文档、测试与评测报告。"""


def clean_text(value) -> str:
    return str(value).replace("\x07", "").replace("\r", "\n").strip()


def comment_snapshot(document) -> list[dict]:
    result = []
    for index in range(1, document.Comments.Count + 1):
        comment = document.Comments.Item(index)
        result.append({
            "author": str(comment.Author),
            "initial": str(comment.Initial),
            "date": comment.Date.strftime("%Y-%m-%d %H:%M:%S"),
            "scope": clean_text(comment.Scope.Text),
            "text": clean_text(comment.Range.Text),
            "replies": [
                {
                    "author": str(comment.Replies.Item(reply_index).Author),
                    "initial": str(comment.Replies.Item(reply_index).Initial),
                    "date": comment.Replies.Item(reply_index).Date.strftime("%Y-%m-%d %H:%M:%S"),
                    "text": clean_text(comment.Replies.Item(reply_index).Range.Text),
                }
                for reply_index in range(1, comment.Replies.Count + 1)
            ],
        })
    return result


def canonical_comments(comments: list[dict]) -> list[str]:
    return sorted(json.dumps(item, ensure_ascii=False, sort_keys=True) for item in comments)


def find_text(document, start: int, end: int, text: str):
    search_range = document.Range(start, end)
    finder = search_range.Find
    finder.ClearFormatting()
    finder.Text = text
    finder.Forward = True
    finder.Wrap = 0
    finder.Format = False
    return search_range if finder.Execute() else None


def locate_route_range(document):
    table = document.Tables.Item(1)
    cell_range = table.Cell(18, 1).Range.Duplicate
    cell_range.End -= 1

    heading = find_text(document, cell_range.Start, cell_range.End, "基本技术路线")
    if heading is None:
        raise ValueError("最新稿中找不到“基本技术路线”标题")
    heading_paragraph = heading.Paragraphs.Item(1).Range
    replacement_start = heading_paragraph.End

    next_heading = None
    for marker in ("四、核心工程问题与处理重点", "四、拟解决的关键问题", "四、"):
        candidate = find_text(document, replacement_start, cell_range.End, marker)
        if candidate is not None and (next_heading is None or candidate.Start < next_heading.Start):
            next_heading = candidate
    if next_heading is None:
        raise ValueError("最新稿中找不到技术路线之后的下一节标题")
    return replacement_start, next_heading.Start


def format_route(document, start: int, end: int):
    heading_paragraph = document.Range(max(0, start - 1), start).Paragraphs.Item(1)
    heading_paragraph.Format.KeepWithNext = -1

    route_range = document.Range(start, end)
    route_range.Font.Name = "Times New Roman"
    route_range.Font.NameAscii = "Times New Roman"
    route_range.Font.NameFarEast = "宋体"
    route_range.Font.Size = 9.6
    route_range.Font.Bold = 0

    for index in range(1, route_range.Paragraphs.Count + 1):
        paragraph = route_range.Paragraphs.Item(index)
        text = clean_text(paragraph.Range.Text)
        paragraph.Format.Alignment = 3 if text else 0
        paragraph.Format.LeftIndent = 0
        paragraph.Format.RightIndent = 0
        paragraph.Format.FirstLineIndent = 19.6 if index == 1 and text else 0
        paragraph.Format.SpaceBefore = 0
        paragraph.Format.SpaceAfter = 0
        paragraph.Format.LineSpacingRule = 4
        paragraph.Format.LineSpacing = 11.2


def revise_document(document):
    if document.Revisions.Count:
        raise ValueError("最新稿仍包含修订记录，停止修改以避免覆盖用户修订")

    comments_before = comment_snapshot(document)
    start, end = locate_route_range(document)
    intersecting_comments = []
    for index in range(1, document.Comments.Count + 1):
        comment = document.Comments.Item(index)
        if comment.Scope.Start < end and comment.Scope.End > start:
            intersecting_comments.append(clean_text(comment.Range.Text))
    if intersecting_comments:
        raise ValueError(f"技术路线正文范围内仍有批注，停止替换：{intersecting_comments}")

    replacement = document.Range(start, end)
    replacement.Text = TECH_ROUTE_TEXT.replace("\n", "\r") + "\r"

    _, new_end = locate_route_range(document)
    format_route(document, start, new_end)
    document.Fields.Update()
    document.Repaginate()
    return comments_before, document.ComputeStatistics(2)


def remove_comments(document):
    while document.Comments.Count:
        comment = document.Comments.Item(1)
        if comment.Replies.Count:
            comment.DeleteRecursively()
        else:
            comment.Delete()
    if document.Revisions.Count:
        raise ValueError("无批注版出现了非预期修订记录")


def generate_artifacts_only():
    if not FINAL_DOCX.exists():
        raise FileNotFoundError(f"找不到最新修订稿：{FINAL_DOCX}")

    pythoncom.CoInitialize()
    word = None
    document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        word.ScreenUpdating = False

        document = word.Documents.Open(
            str(FINAL_DOCX),
            ReadOnly=True,
            AddToRecentFiles=False,
        )
        comments = comment_snapshot(document)
        pages = document.ComputeStatistics(2)
        if document.Revisions.Count:
            raise RuntimeError("含批注最终稿出现非预期修订记录")
        document.Close(False)
        document = None

        shutil.copy2(FINAL_DOCX, CLEAN_DOCX)
        document = word.Documents.Open(
            str(CLEAN_DOCX),
            ReadOnly=False,
            AddToRecentFiles=False,
        )
        remove_comments(document)
        document.Save()
        document.PrintRevisions = False
        document.ExportAsFixedFormat(str(OUTPUT_PDF), 17)
        clean_pages = document.ComputeStatistics(2)
        if document.Comments.Count:
            raise RuntimeError("无批注版仍残留批注")
        document.Close(False)
        document = None
    finally:
        if document is not None:
            document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()

    return {
        "final_docx": FINAL_DOCX,
        "clean_docx": CLEAN_DOCX,
        "pdf": OUTPUT_PDF,
        "pages": pages,
        "clean_pages": clean_pages,
        "comment_threads_in_final": len(comments),
    }


def generate(force: bool = False):
    if not FINAL_DOCX.exists():
        raise FileNotFoundError(f"找不到最新用户修订稿：{FINAL_DOCX}")

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = SUPPORT_DIR / f"{FINAL_DOCX.stem}_用户修订稿备份（技术路线修改前）_{timestamp}.docx"
    if backup.exists() and not force:
        raise FileExistsError(f"备份文件已存在：{backup}")
    shutil.copy2(FINAL_DOCX, backup)

    pythoncom.CoInitialize()
    word = None
    document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        word.ScreenUpdating = False
        document = word.Documents.Open(
            str(FINAL_DOCX),
            ReadOnly=False,
            AddToRecentFiles=False,
        )
        comments_before, pages = revise_document(document)
        document.Save()
        document.Close(False)
        document = None

        document = word.Documents.Open(
            str(FINAL_DOCX),
            ReadOnly=True,
            AddToRecentFiles=False,
        )
        comments_after = comment_snapshot(document)
        if canonical_comments(comments_after) != canonical_comments(comments_before):
            raise RuntimeError("技术路线修改后，最新稿中的批注或回复发生变化")
        if document.Revisions.Count:
            raise RuntimeError("技术路线修改后出现非预期修订记录")
        final_text = clean_text(document.Content.Text)
        if "AIGC编排层+确定性控制层" not in final_text or "分层测试与AI Eval" not in final_text:
            raise RuntimeError("技术路线正文写入不完整")
        document.Close(False)
        document = None

        shutil.copy2(FINAL_DOCX, CLEAN_DOCX)
        document = word.Documents.Open(
            str(CLEAN_DOCX),
            ReadOnly=False,
            AddToRecentFiles=False,
        )
        remove_comments(document)
        document.Save()
        document.PrintRevisions = False
        document.ExportAsFixedFormat(str(OUTPUT_PDF), 17)
        clean_pages = document.ComputeStatistics(2)
        document.Close(False)
        document = None
    finally:
        if document is not None:
            document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()

    return {
        "final_docx": FINAL_DOCX,
        "backup": backup,
        "clean_docx": CLEAN_DOCX,
        "pdf": OUTPUT_PDF,
        "pages": pages,
        "clean_pages": clean_pages,
        "comment_objects_preserved": len(comments_before),
    }


def main():
    parser = argparse.ArgumentParser(description="Revise only the latest task-book technical route")
    parser.add_argument("--force", action="store_true", help="allow a same-second backup name to be replaced")
    parser.add_argument("--artifacts-only", action="store_true", help="regenerate the clean DOCX and PDF without editing the final DOCX")
    args = parser.parse_args()
    result = generate_artifacts_only() if args.artifacts_only else generate(force=args.force)
    for key, value in result.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
