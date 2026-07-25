from __future__ import annotations

import hashlib
import json
from pathlib import Path

import fitz
import pythoncom
import win32com.client

from generate_task_book_v13 import (
    EXPECTED_SOURCE_SHA256,
    NEW_CHINESE_TITLE,
    NEW_ENGLISH_TITLE,
    OUTPUT,
    REFERENCES,
    SOURCE,
)


BASE_DIR = Path(__file__).resolve().parent.parent
PDF_OUTPUT = BASE_DIR / "配套文件" / "毕业论文（设计）任务书20260723-v1.3.pdf"
REPORT_OUTPUT = BASE_DIR / "文献核验材料（v1.3）" / "Word只读与PDF导出核验报告.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def clean_text(value) -> str:
    return str(value).replace("\x07", "").replace("\r", "\n").strip()


def format_date(value) -> str:
    try:
        return value.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(value)


def comment_record(comment) -> dict:
    return {
        "author": str(comment.Author),
        "initial": str(comment.Initial),
        "date": format_date(comment.Date),
        "text": clean_text(comment.Range.Text),
        "replies": [
            {
                "author": str(comment.Replies.Item(index).Author),
                "initial": str(comment.Replies.Item(index).Initial),
                "date": format_date(comment.Replies.Item(index).Date),
                "text": clean_text(comment.Replies.Item(index).Range.Text),
            }
            for index in range(1, comment.Replies.Count + 1)
        ],
    }


def document_snapshot(document) -> dict:
    document.Repaginate()
    comments = [
        comment_record(document.Comments.Item(index))
        for index in range(1, document.Comments.Count + 1)
    ]
    scopes = [
        clean_text(document.Comments.Item(index).Scope.Text)
        for index in range(1, document.Comments.Count + 1)
    ]
    reply_count = sum(len(comment["replies"]) for comment in comments)
    table_cell_counts = [
        document.Tables.Item(index).Range.Cells.Count
        for index in range(1, document.Tables.Count + 1)
    ]
    return {
        "pages": document.ComputeStatistics(2),
        "paragraphs": document.Paragraphs.Count,
        "tables": document.Tables.Count,
        "table_cell_counts": table_cell_counts,
        "sections": document.Sections.Count,
        "revisions": document.Revisions.Count,
        "top_level_comments": document.Comments.Count - reply_count,
        "reply_comments": reply_count,
        "comment_objects_including_replies": document.Comments.Count,
        "comment_metadata": comments,
        "comment_scopes": scopes,
        "content_characters": len(str(document.Content.Text)),
    }


def open_read_only(word, path: Path):
    return word.Documents.Open(
        FileName=str(path),
        ConfirmConversions=False,
        ReadOnly=True,
        AddToRecentFiles=False,
        Revert=False,
        Visible=False,
        OpenAndRepair=False,
        NoEncodingDialog=True,
    )


def export_without_markup(document, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    document.PrintRevisions = False
    if document.Windows.Count:
        view = document.Windows.Item(1).View
        view.ShowRevisionsAndComments = False
        view.RevisionsView = 0
    document.ExportAsFixedFormat(
        str(output),
        17,
        False,
        0,
        0,
        1,
        1,
        0,
        True,
        True,
        1,
        True,
        True,
        False,
    )


def normalized(value: str) -> str:
    return "".join(value.split())


def validate_pdf(path: Path, comment_metadata: list[dict]) -> dict:
    document = fitz.open(path)
    try:
        blank_pages = []
        annotations = 0
        out_of_bounds_blocks = []
        page_sizes = []
        page_texts = []
        for page_index in range(document.page_count):
            page = document[page_index]
            text = page.get_text()
            page_texts.append(text)
            if len(text.strip()) < 20:
                blank_pages.append(page_index + 1)
            annotation = page.first_annot
            while annotation is not None:
                annotations += 1
                annotation = annotation.next
            page_sizes.append([round(page.rect.width, 3), round(page.rect.height, 3)])
            for block in page.get_text("blocks"):
                x0, y0, x1, y1 = block[:4]
                if x0 < -2 or y0 < -2 or x1 > page.rect.width + 2 or y1 > page.rect.height + 2:
                    out_of_bounds_blocks.append(
                        {
                            "page": page_index + 1,
                            "bbox": [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)],
                        }
                    )
        all_pdf_text = normalized("\n".join(page_texts))
        comment_texts = []
        for comment in comment_metadata:
            comment_texts.append(comment["text"])
            comment_texts.extend(reply["text"] for reply in comment["replies"])
        leaked_comments = [
            text
            for text in comment_texts
            if text and normalized(text) in all_pdf_text
        ]
        return {
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
            "pages": document.page_count,
            "blank_pages": blank_pages,
            "annotation_count": annotations,
            "comment_text_leaks": leaked_comments,
            "out_of_bounds_text_blocks": out_of_bounds_blocks,
            "page_sizes": page_sizes,
            "page_text_characters": [len(text) for text in page_texts],
        }
    finally:
        document.close()


def main() -> None:
    if sha256_file(SOURCE) != EXPECTED_SOURCE_SHA256:
        raise RuntimeError("v1.2 源文件哈希已变化")
    if not OUTPUT.exists():
        raise FileNotFoundError(OUTPUT)
    output_hash_before = sha256_file(OUTPUT)

    pythoncom.CoInitialize()
    word = None
    document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        word.ScreenUpdating = False
        word.AutomationSecurity = 3

        document = open_read_only(word, SOURCE)
        source_snapshot = document_snapshot(document)
        document.Close(False)
        document = None

        document = open_read_only(word, OUTPUT)
        output_snapshot = document_snapshot(document)
        content_text = str(document.Content.Text)
        if NEW_CHINESE_TITLE not in content_text or NEW_ENGLISH_TITLE not in content_text:
            raise RuntimeError("Word 只读打开后未找到新中英文题目")
        for reference in REFERENCES:
            if reference not in content_text:
                raise RuntimeError(f"Word 只读打开后缺少文献：{reference}")
        if output_snapshot["revisions"] != 0:
            raise RuntimeError("Word 检测到非预期修订记录")
        if output_snapshot["comment_objects_including_replies"] != 13:
            raise RuntimeError("Word 检测到的批注对象与回复总数不是 13")
        if source_snapshot["comment_metadata"] != output_snapshot["comment_metadata"]:
            raise RuntimeError("Word 检测到批注文本、作者、时间或回复关系发生变化")
        if source_snapshot["tables"] != output_snapshot["tables"]:
            raise RuntimeError("表格数量发生变化")
        if source_snapshot["table_cell_counts"] != output_snapshot["table_cell_counts"]:
            raise RuntimeError("表格单元格结构发生变化")
        removed_reference_paragraphs = 25 - len(REFERENCES)
        if output_snapshot["paragraphs"] != source_snapshot["paragraphs"] - removed_reference_paragraphs:
            raise RuntimeError(
                f"除删除 {removed_reference_paragraphs} 个多余文献段落外，段落数量发生异常变化"
            )

        export_without_markup(document, PDF_OUTPUT)
        document.Close(False)
        document = None
    finally:
        if document is not None:
            document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()

    output_hash_after = sha256_file(OUTPUT)
    if output_hash_before != output_hash_after:
        raise RuntimeError("Word 只读检查或 PDF 导出修改了 v1.3 DOCX")
    pdf_snapshot = validate_pdf(PDF_OUTPUT, output_snapshot["comment_metadata"])
    if pdf_snapshot["blank_pages"]:
        raise RuntimeError(f"PDF 出现空白页：{pdf_snapshot['blank_pages']}")
    if pdf_snapshot["annotation_count"]:
        raise RuntimeError("PDF 中仍包含批注或其他注释对象")
    if pdf_snapshot["comment_text_leaks"]:
        raise RuntimeError("PDF 正文中仍包含批注文本")
    if pdf_snapshot["out_of_bounds_text_blocks"]:
        raise RuntimeError("PDF 中存在超出页面边界的文本块")

    report = {
        "word_version": "16.0",
        "open_mode": "read_only",
        "source_docx": str(SOURCE),
        "source_sha256": sha256_file(SOURCE),
        "output_docx": str(OUTPUT),
        "output_sha256_before_and_after": output_hash_after,
        "source_snapshot": source_snapshot,
        "output_snapshot": output_snapshot,
        "comment_metadata_identical": True,
        "docx_unchanged_by_word": True,
        "pdf_export_mode": "document_content_without_markup",
        "pdf": str(PDF_OUTPUT),
        "pdf_snapshot": pdf_snapshot,
    }
    REPORT_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    REPORT_OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "source_pages": source_snapshot["pages"],
                "output_pages": output_snapshot["pages"],
                "comments_including_replies": output_snapshot["comment_objects_including_replies"],
                "revisions": output_snapshot["revisions"],
                "tables": output_snapshot["tables"],
                "pdf": str(PDF_OUTPUT),
                "pdf_sha256": pdf_snapshot["sha256"],
                "pdf_pages": pdf_snapshot["pages"],
                "blank_pages": pdf_snapshot["blank_pages"],
                "pdf_annotations": pdf_snapshot["annotation_count"],
                "comment_text_leaks": pdf_snapshot["comment_text_leaks"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
