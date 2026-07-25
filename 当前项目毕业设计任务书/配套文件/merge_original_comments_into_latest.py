from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import tempfile
from collections import Counter
from pathlib import Path
from xml.dom import minidom
from zipfile import ZIP_DEFLATED, ZipFile

import pythoncom
import win32com.client


SUPPORT_DIR = Path(__file__).resolve().parent
BASE_DIR = SUPPORT_DIR.parent
CURRENT_DOCX = BASE_DIR / "毕业论文（设计）任务书_面向超级个体的AIGC协作开发工作流平台设计与实现_根据批注四次修正版（含批注回复）.docx"
ORIGINAL_DOCX = SUPPORT_DIR / "毕业论文（设计）任务书_面向超级个体的AI协作工作空间设计与实现_批注原稿.docx"
DEFAULT_CANDIDATE = SUPPORT_DIR / "完整原始批注迁移候选.docx"

MISSING_COMMENT_ANCHOR = "项目现有核心想法、开发计划和Focus OS界面规范"
MISSING_COMMENT_REPLY = "已调整表述，前期工作仅作为可行性与方案依据，毕业设计成果以本阶段完成的原型、测试和验证为准。"
COMMENTS_PART = "word/comments.xml"
COMMENTS_IDS_PART = "word/commentsIds.xml"
COMMENTS_EXTENSIBLE_PART = "word/commentsExtensible.xml"


def clean_text(value) -> str:
    return str(value).replace("\x07", "").replace("\r", "\n").strip()


def normalized(value: str) -> str:
    return re.sub(r"\s+", "", clean_text(value))


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


def simple_records(items: list[dict]) -> Counter:
    return Counter(
        json.dumps(
            {key: item[key] for key in ("author", "initial", "date", "scope", "text")},
            ensure_ascii=False,
            sort_keys=True,
        )
        for item in items
    )


def comment_text(element) -> str:
    paragraphs = []
    for paragraph in element.getElementsByTagName("w:p"):
        paragraphs.append("".join(
            node.firstChild.data
            for node in paragraph.getElementsByTagName("w:t")
            if node.firstChild is not None
        ))
    return "\n".join(paragraphs).strip()


def read_zip_parts(path: Path, names: set[str]) -> dict[str, bytes]:
    with ZipFile(path) as archive:
        return {name: archive.read(name) for name in names}


def original_teacher_comments() -> list[dict]:
    data = read_zip_parts(ORIGINAL_DOCX, {COMMENTS_PART})[COMMENTS_PART]
    document = minidom.parseString(data)
    result = []
    for comment in document.getElementsByTagName("w:comment"):
        result.append({
            "text": comment_text(comment),
            "author": comment.getAttribute("w:author"),
            "initial": comment.getAttribute("w:initials"),
            "date": comment.getAttribute("w:date"),
        })
    if len(result) != 5:
        raise RuntimeError(f"最初批注稿应有5条老师批注，实际读取到{len(result)}条")
    return result


def local_wall_time_to_utc(value: str) -> str:
    # The original Word file stores local wall time in w:date with a trailing Z.
    local_time = dt.datetime.fromisoformat(value.rstrip("Z"))
    utc_time = local_time - dt.timedelta(hours=8)
    return utc_time.strftime("%Y-%m-%dT%H:%M:%SZ")


def patch_teacher_metadata(path: Path, teacher_comments: list[dict]) -> dict[str, str]:
    parts = read_zip_parts(path, {COMMENTS_PART, COMMENTS_IDS_PART, COMMENTS_EXTENSIBLE_PART})
    comments_doc = minidom.parseString(parts[COMMENTS_PART])
    ids_doc = minidom.parseString(parts[COMMENTS_IDS_PART])
    extensible_doc = minidom.parseString(parts[COMMENTS_EXTENSIBLE_PART])

    target_comments = {
        normalized(comment_text(element)): element
        for element in comments_doc.getElementsByTagName("w:comment")
    }
    para_to_durable = {
        element.getAttribute("w16cid:paraId"): element.getAttribute("w16cid:durableId")
        for element in ids_doc.getElementsByTagName("w16cid:commentId")
    }
    durable_to_extensible = {
        element.getAttribute("w16cex:durableId"): element
        for element in extensible_doc.getElementsByTagName("w16cex:commentExtensible")
    }

    expected_date_utc = {}
    for source in teacher_comments:
        key = normalized(source["text"])
        if key not in target_comments:
            raise RuntimeError(f"合并稿缺少老师批注：{source['text']}")
        target = target_comments[key]
        target.setAttribute("w:author", source["author"])
        target.setAttribute("w:initials", source["initial"])
        target.setAttribute("w:date", source["date"])

        paragraphs = target.getElementsByTagName("w:p")
        if not paragraphs:
            raise RuntimeError("批注中缺少段落，无法校正现代批注时间")
        durable_id = next(
            (
                para_to_durable[paragraph.getAttribute("w14:paraId")]
                for paragraph in paragraphs
                if paragraph.getAttribute("w14:paraId") in para_to_durable
            ),
            None,
        )
        extensible = durable_to_extensible.get(durable_id or "")
        if extensible is None:
            raise RuntimeError(f"批注缺少commentsExtensible映射：{source['text']}")
        utc_value = local_wall_time_to_utc(source["date"])
        extensible.setAttribute("w16cex:dateUtc", utc_value)
        expected_date_utc[source["text"]] = utc_value

    replacement_parts = {
        COMMENTS_PART: comments_doc.toxml(encoding="UTF-8", standalone=True),
        COMMENTS_EXTENSIBLE_PART: extensible_doc.toxml(encoding="UTF-8", standalone=True),
    }
    with tempfile.NamedTemporaryFile(
        prefix=path.stem + "-",
        suffix=".docx",
        dir=path.parent,
        delete=False,
    ) as temporary_file:
        temporary_path = Path(temporary_file.name)
    try:
        with ZipFile(path, "r") as source_archive, ZipFile(temporary_path, "w") as target_archive:
            for item in source_archive.infolist():
                data = replacement_parts.get(item.filename, source_archive.read(item.filename))
                target_archive.writestr(item, data)
        temporary_path.replace(path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return expected_date_utc


def find_range(document, text: str):
    search_range = document.Content.Duplicate
    finder = search_range.Find
    finder.ClearFormatting()
    finder.Text = text
    finder.Forward = True
    finder.Wrap = 0
    finder.Format = False
    if not finder.Execute():
        raise RuntimeError(f"当前人工修订稿中找不到批注锚点：{text}")
    return search_range


def merge(source: Path, output: Path) -> dict:
    if not source.exists():
        raise FileNotFoundError(source)
    if not ORIGINAL_DOCX.exists():
        raise FileNotFoundError(ORIGINAL_DOCX)
    if source.resolve() == output.resolve():
        raise ValueError("输出必须先写入候选文件，不能直接覆盖正文来源")

    teacher_comments = original_teacher_comments()
    teacher_by_key = {normalized(item["text"]): item for item in teacher_comments}
    shutil.copy2(source, output)

    pythoncom.CoInitialize()
    word = None
    source_document = None
    output_document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        word.ScreenUpdating = False

        source_document = word.Documents.Open(str(source), ReadOnly=True, AddToRecentFiles=False)
        source_text = source_document.Content.Text
        source_comments = comment_snapshot(source_document)
        if source_document.Revisions.Count:
            raise RuntimeError("当前人工修订稿仍含修订记录")
        source_document.Close(False)
        source_document = None

        source_teacher_keys = {
            normalized(item["text"])
            for item in source_comments
            if normalized(item["text"]) in teacher_by_key
        }
        missing = [item for item in teacher_comments if normalized(item["text"]) not in source_teacher_keys]
        if len(missing) != 1:
            raise RuntimeError(f"预期仅缺少1条老师批注，实际缺少{len(missing)}条")

        output_document = word.Documents.Open(str(output), ReadOnly=False, AddToRecentFiles=False)
        anchor = find_range(output_document, MISSING_COMMENT_ANCHOR)
        restored = output_document.Comments.Add(anchor, missing[0]["text"])
        restored.Replies.Add(restored.Range, MISSING_COMMENT_REPLY)
        output_document.Save()
        output_document.Close(False)
        output_document = None
    finally:
        if source_document is not None:
            source_document.Close(False)
        if output_document is not None:
            output_document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()

    expected_date_utc = patch_teacher_metadata(output, teacher_comments)

    pythoncom.CoInitialize()
    word = None
    output_document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        output_document = word.Documents.Open(str(output), ReadOnly=True, AddToRecentFiles=False)
        final_comments = comment_snapshot(output_document)
        if output_document.Content.Text != source_text:
            raise RuntimeError("完整批注合并后正文发生变化")
        if output_document.Revisions.Count:
            raise RuntimeError("完整批注合并后出现非预期修订记录")
        before_records = simple_records(source_comments)
        after_records = simple_records(final_comments)
        if any(after_records[key] < count for key, count in before_records.items()):
            raise RuntimeError("完整批注合并时改变了当前稿的既有批注或回复")

        teacher_dates = {
            normalized(item["text"]): item["date"][:19].replace("T", " ")
            for item in teacher_comments
        }
        for item in final_comments:
            key = normalized(item["text"])
            if key in teacher_dates and item["date"] != teacher_dates[key]:
                raise RuntimeError(f"老师批注时间不一致：{item['text']}")
        present_teacher_keys = {
            normalized(item["text"])
            for item in final_comments
            if normalized(item["text"]) in teacher_dates
        }
        if present_teacher_keys != set(teacher_dates):
            raise RuntimeError("最终稿未完整保留5条老师批注")

        restored_thread = next(
            item for item in final_comments
            if normalized(item["text"]) == normalized(missing[0]["text"])
        )
        if MISSING_COMMENT_REPLY not in [reply["text"] for reply in restored_thread["replies"]]:
            raise RuntimeError("缺失批注的回复未写入")

        reply_count = sum(len(item["replies"]) for item in final_comments)
        result = {
            "output": str(output),
            "body_text_identical": True,
            "original_teacher_comments": len(teacher_dates),
            "root_comments": output_document.Comments.Count - reply_count,
            "replies": reply_count,
            "comment_objects": output_document.Comments.Count,
            "revisions": output_document.Revisions.Count,
            "pages": output_document.ComputeStatistics(2),
            "restored_comment": missing[0]["text"],
            "restored_scope": restored_thread["scope"],
            "teacher_date_utc": expected_date_utc,
        }
    finally:
        if output_document is not None:
            output_document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()
    return result


def main():
    parser = argparse.ArgumentParser(description="Merge all original teacher comments into the latest manually edited DOCX")
    parser.add_argument("--source", type=Path, default=CURRENT_DOCX)
    parser.add_argument("--output", type=Path, default=DEFAULT_CANDIDATE)
    args = parser.parse_args()
    result = merge(args.source.resolve(), args.output.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
