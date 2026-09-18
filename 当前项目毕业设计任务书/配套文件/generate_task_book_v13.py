from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path
from xml.dom import minidom
from xml.sax.saxutils import escape
from zipfile import ZipFile


BASE_DIR = Path(__file__).resolve().parent.parent
SOURCE = BASE_DIR / "毕业论文（设计）任务书20260723-v1.2.docx"
OUTPUT = BASE_DIR / "毕业论文（设计）任务书20260723-v1.3.docx"
MATERIALS_DIR = BASE_DIR / "文献核验材料（v1.3）"
REPORT = MATERIALS_DIR / "OOXML结构核验报告.json"

EXPECTED_SOURCE_SHA256 = "9874585938DEAB4D53A8FD58E4A70437A285ED63185560DE9EAFAB7B3A96E04E"
DOCUMENT_PART = "word/document.xml"

OLD_CHINESE_TITLE = "面向超级个体的AIGC协作开发工作流平台设计与实现"
NEW_CHINESE_TITLE = "面向超级个体的协作开发工作流平台设计与开源集成"
OLD_ENGLISH_TITLE = "Design and Implementation of an AIGC-Driven Collaborative Development Workflow Platform for Solo Developers"
NEW_ENGLISH_TITLE = "Design and Open-Source Integration of a Collaborative Development Workflow Platform for Solo Developers"

REFERENCES = [
    "[1] WANG Y, ZHONG W, HUANG Y, et al. Agents in software engineering: Survey, landscape, and vision[J]. Automated Software Engineering, 2025, 32(2): 70. DOI:10.1007/s10515-025-00544-2.",
    "[2] QIAN C, LIU W, LIU H, et al. ChatDev: Communicative agents for software development[C]//Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics. Bangkok: Association for Computational Linguistics, 2024: 15174-15186. DOI:10.18653/v1/2024.acl-long.810.",
    "[3] YANG J, JIMENEZ C E, WETTIG A, et al. SWE-agent: Agent-computer interfaces enable automated software engineering[C]//Advances in Neural Information Processing Systems 37. [S.l.]: Neural Information Processing Systems Foundation, 2024: 50528-50652. DOI:10.52202/079017-1601.",
    "[4] WANG L, MA C, FENG X, et al. A survey on large language model based autonomous agents[J]. Frontiers of Computer Science, 2024, 18(6): 186345. DOI:10.1007/s11704-024-40231-1.",
    "[5] HONG S, ZHUGE M, CHEN J, et al. MetaGPT: Meta programming for a multi-agent collaborative framework[C/OL]//The Twelfth International Conference on Learning Representations. [S.l.]: OpenReview, 2024[2026-07-24]. https://openreview.net/forum?id=VtmBAGCN7o.",
    "[6] MODEL CONTEXT PROTOCOL. Specification: 2025-06-18[EB/OL]. (2025-06-18)[2026-07-24]. https://modelcontextprotocol.io/specification/2025-06-18.",
    "[7] BARKE S, JAMES M B, POLIKARPOVA N. Grounded Copilot: How programmers interact with code-generating models[J]. Proceedings of the ACM on Programming Languages, 2023, 7(OOPSLA1): 85-111. DOI:10.1145/3586030.",
    "[8] AMERSHI S, WELD D, VORVOREANU M, et al. Guidelines for human-AI interaction[C]//Proceedings of the 2019 CHI Conference on Human Factors in Computing Systems. New York: ACM, 2019: 1-13. DOI:10.1145/3290605.3300233.",
    "[9] PERRY N, SRIVASTAVA M, KUMAR D, et al. Do users write more insecure code with AI assistants?[C]//Proceedings of the 2023 ACM SIGSAC Conference on Computer and Communications Security. New York: ACM, 2023: 2785-2799. DOI:10.1145/3576915.3623157.",
    "[10] VAN DER AALST W M P, TER HOFSTEDE A H M, KIEPUSZEWSKI B, et al. Workflow patterns[J]. Distributed and Parallel Databases, 2003, 14(1): 5-51. DOI:10.1023/A:1022883727209.",
    "[11] HAUGE O, AYALA C, CONRADI R. Adoption of open source software in software-intensive organizations: A systematic literature review[J]. Information and Software Technology, 2010, 52(11): 1133-1154. DOI:10.1016/j.infsof.2010.05.008.",
    "[12] FRANCO-BEDOYA O, AMELLER D, COSTAL D, et al. Open source software ecosystems: A systematic mapping[J]. Information and Software Technology, 2017, 91: 160-185. DOI:10.1016/j.infsof.2017.07.007.",
    "[13] MOREAU L, CLIFFORD B, FREIRE J, et al. The Open Provenance Model core specification (v1.1)[J]. Future Generation Computer Systems, 2011, 27(6): 743-756. DOI:10.1016/j.future.2010.07.005.",
    "[14] TABASSI E. Artificial Intelligence Risk Management Framework (AI RMF 1.0)[R]. Gaithersburg, MD: National Institute of Standards and Technology, 2023. DOI:10.6028/NIST.AI.100-1.",
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def paragraph_text(paragraph) -> str:
    return "".join(
        node.firstChild.data
        for node in paragraph.getElementsByTagName("w:t")
        if node.firstChild is not None
    )


def find_unique_paragraph(paragraphs, text: str):
    matches = [paragraph for paragraph in paragraphs if paragraph_text(paragraph) == text]
    if len(matches) != 1:
        raise RuntimeError(f"应唯一定位段落 {text!r}，实际找到 {len(matches)} 个")
    return matches[0]


def replace_only_text(paragraph_xml: str, value: str) -> str:
    pattern = re.compile(r"(<w:t(?:\s[^>]*)?>)(.*?)(</w:t>)", re.DOTALL)
    if len(pattern.findall(paragraph_xml)) != 1:
        raise RuntimeError("目标段落必须且只能包含一个 w:t 文本节点")
    return pattern.sub(lambda match: match.group(1) + escape(value) + match.group(3), paragraph_xml)


def extract_comment_reference_run(paragraph, comment_id: str) -> str:
    matches = [
        node
        for node in paragraph.getElementsByTagName("w:commentReference")
        if node.getAttribute("w:id") == comment_id
    ]
    if len(matches) != 1:
        raise RuntimeError(f"批注 {comment_id} 的引用标记数量应为 1，实际为 {len(matches)}")
    run = matches[0].parentNode
    if run.tagName != "w:r":
        raise RuntimeError(f"批注 {comment_id} 的引用标记不在 w:r 中")
    return run.toxml()


def locate_reference_paragraphs(document):
    paragraphs = list(document.getElementsByTagName("w:p"))
    heading = find_unique_paragraph(paragraphs, "推荐参考文献：")
    signatures = [
        paragraph
        for paragraph in paragraphs
        if paragraph_text(paragraph).startswith("指导教师签名：")
    ]
    if len(signatures) != 1:
        raise RuntimeError(f"指导教师签名段落应为 1 个，实际为 {len(signatures)} 个")
    heading_index = paragraphs.index(heading)
    signature_index = paragraphs.index(signatures[0])
    references = paragraphs[heading_index + 1 : signature_index]
    if any(not paragraph_text(paragraph).startswith(f"[{index}] ") for index, paragraph in enumerate(references, 1)):
        raise RuntimeError("推荐参考文献区不是连续的顺序编码段落")
    return references


def replace_unique(raw_xml: str, old: str, new: str, label: str) -> str:
    count = raw_xml.count(old)
    if count != 1:
        raise RuntimeError(f"{label} 在 document.xml 中应出现 1 次，实际出现 {count} 次")
    return raw_xml.replace(old, new, 1)


def patch_document_xml(source_xml: bytes) -> bytes:
    document = minidom.parseString(source_xml)
    paragraphs = list(document.getElementsByTagName("w:p"))
    chinese_paragraph = find_unique_paragraph(paragraphs, OLD_CHINESE_TITLE)
    english_paragraph = find_unique_paragraph(paragraphs, OLD_ENGLISH_TITLE)
    old_references = locate_reference_paragraphs(document)
    if len(old_references) != 25:
        raise RuntimeError(f"v1.2 应包含 25 篇推荐参考文献，实际为 {len(old_references)} 篇")

    comment_11_paragraphs = [
        paragraph
        for paragraph in old_references
        if any(
            node.getAttribute("w:id") == "11"
            for node in paragraph.getElementsByTagName("w:commentReference")
        )
    ]
    comment_12_paragraphs = [
        paragraph
        for paragraph in old_references
        if any(
            node.getAttribute("w:id") == "12"
            for node in paragraph.getElementsByTagName("w:commentReference")
        )
    ]
    if comment_11_paragraphs != [old_references[3]]:
        raise RuntimeError("v1.2 的批注 11 不在原第 4 篇文献末尾")
    if comment_12_paragraphs != [old_references[21]]:
        raise RuntimeError("v1.2 的批注 12 不在原第 22 篇文献末尾")

    comment_run_11 = extract_comment_reference_run(old_references[3], "11")
    comment_run_12 = extract_comment_reference_run(old_references[21], "12")

    raw = source_xml.decode("utf-8")
    old_chinese_xml = chinese_paragraph.toxml()
    old_english_xml = english_paragraph.toxml()
    new_chinese_xml = replace_only_text(old_chinese_xml, NEW_CHINESE_TITLE)
    new_english_xml = replace_only_text(old_english_xml, NEW_ENGLISH_TITLE)
    raw = replace_unique(raw, old_chinese_xml, new_chinese_xml, "中文题目段落")
    raw = replace_unique(raw, old_english_xml, new_english_xml, "英文题目段落")

    old_reference_xml = [paragraph.toxml() for paragraph in old_references]
    old_reference_block = "".join(old_reference_xml)
    if raw.count(old_reference_block) != 1:
        raise RuntimeError("无法把 25 个文献段落定位为唯一连续 XML 区块")

    new_reference_xml = []
    for index, reference in enumerate(REFERENCES, 1):
        paragraph_xml = old_reference_xml[index - 1]
        paragraph_xml = paragraph_xml.replace(comment_run_11, "")
        paragraph_xml = paragraph_xml.replace(comment_run_12, "")
        paragraph_xml = replace_only_text(paragraph_xml, reference)
        if index == 3:
            paragraph_xml = paragraph_xml.replace("</w:p>", comment_run_11 + "</w:p>", 1)
        if index == len(REFERENCES):
            paragraph_xml = paragraph_xml.replace("</w:p>", comment_run_12 + "</w:p>", 1)
        new_reference_xml.append(paragraph_xml)

    raw = replace_unique(
        raw,
        old_reference_block,
        "".join(new_reference_xml),
        "推荐参考文献 XML 区块",
    )
    return raw.encode("utf-8")


def write_docx(source: Path, output: Path, document_xml: bytes) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=output.stem + "-",
        suffix=".docx",
        dir=output.parent,
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with ZipFile(source, "r") as source_archive, ZipFile(temporary_path, "w") as output_archive:
            for item in source_archive.infolist():
                content = document_xml if item.filename == DOCUMENT_PART else source_archive.read(item.filename)
                output_archive.writestr(item, content)
            output_archive.comment = source_archive.comment
        temporary_path.replace(output)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def normalized_title_paragraph(paragraph) -> str:
    return replace_only_text(paragraph.toxml(), "__TITLE__")


def revision_count(document) -> int:
    revision_tags = (
        "w:ins",
        "w:del",
        "w:moveFrom",
        "w:moveTo",
        "w:moveFromRangeStart",
        "w:moveFromRangeEnd",
        "w:moveToRangeStart",
        "w:moveToRangeEnd",
    )
    return sum(len(document.getElementsByTagName(tag)) for tag in revision_tags)


def comment_reference_locations(document) -> dict[str, str]:
    result = {}
    for paragraph in document.getElementsByTagName("w:p"):
        text = paragraph_text(paragraph)
        for node in paragraph.getElementsByTagName("w:commentReference"):
            result[node.getAttribute("w:id")] = text
    return result


def validate(source: Path, output: Path) -> dict:
    with ZipFile(source, "r") as source_archive, ZipFile(output, "r") as output_archive:
        source_names = source_archive.namelist()
        output_names = output_archive.namelist()
        if source_names != output_names:
            raise RuntimeError("v1.3 的 OOXML 部件列表或顺序发生变化")
        unchanged_parts = []
        for name in source_names:
            if name == DOCUMENT_PART:
                continue
            if source_archive.read(name) != output_archive.read(name):
                raise RuntimeError(f"非目标 OOXML 部件发生变化：{name}")
            unchanged_parts.append(name)
        source_xml = source_archive.read(DOCUMENT_PART)
        output_xml = output_archive.read(DOCUMENT_PART)
        source_comments = source_archive.read("word/comments.xml")
        output_comments = output_archive.read("word/comments.xml")
        source_comments_extended = source_archive.read("word/commentsExtended.xml")
        output_comments_extended = output_archive.read("word/commentsExtended.xml")

    source_document = minidom.parseString(source_xml)
    output_document = minidom.parseString(output_xml)
    source_paragraphs = list(source_document.getElementsByTagName("w:p"))
    output_paragraphs = list(output_document.getElementsByTagName("w:p"))
    source_chinese = find_unique_paragraph(source_paragraphs, OLD_CHINESE_TITLE)
    source_english = find_unique_paragraph(source_paragraphs, OLD_ENGLISH_TITLE)
    output_chinese = find_unique_paragraph(output_paragraphs, NEW_CHINESE_TITLE)
    output_english = find_unique_paragraph(output_paragraphs, NEW_ENGLISH_TITLE)
    source_references = locate_reference_paragraphs(source_document)
    output_references = locate_reference_paragraphs(output_document)

    if [paragraph_text(paragraph) for paragraph in output_references] != REFERENCES:
        raise RuntimeError("v1.3 的 14 篇文献文本或顺序不符合目标清单")
    if normalized_title_paragraph(source_chinese) != normalized_title_paragraph(output_chinese):
        raise RuntimeError("中文题目段落除文本外发生了结构变化")
    if normalized_title_paragraph(source_english) != normalized_title_paragraph(output_english):
        raise RuntimeError("英文题目段落除文本外发生了结构变化")

    source_raw = source_xml.decode("utf-8")
    output_raw = output_xml.decode("utf-8")
    source_normalized = source_raw
    output_normalized = output_raw
    for old, marker in (
        (source_chinese.toxml(), "<TARGET_CHINESE_TITLE/>"),
        (source_english.toxml(), "<TARGET_ENGLISH_TITLE/>"),
        ("".join(paragraph.toxml() for paragraph in source_references), "<TARGET_REFERENCES/>"),
    ):
        source_normalized = replace_unique(source_normalized, old, marker, marker)
    for old, marker in (
        (output_chinese.toxml(), "<TARGET_CHINESE_TITLE/>"),
        (output_english.toxml(), "<TARGET_ENGLISH_TITLE/>"),
        ("".join(paragraph.toxml() for paragraph in output_references), "<TARGET_REFERENCES/>"),
    ):
        output_normalized = replace_unique(output_normalized, old, marker, marker)
    if source_normalized != output_normalized:
        raise RuntimeError("document.xml 在三个允许修改范围之外发生了变化")

    source_title_ids = [
        (node.tagName, node.getAttribute("w:id"))
        for node in source_chinese.childNodes
        if getattr(node, "tagName", "") in ("w:commentRangeStart", "w:commentRangeEnd")
    ]
    output_title_ids = [
        (node.tagName, node.getAttribute("w:id"))
        for node in output_chinese.childNodes
        if getattr(node, "tagName", "") in ("w:commentRangeStart", "w:commentRangeEnd")
    ]
    expected_title_ids = [
        ("w:commentRangeStart", "0"),
        ("w:commentRangeStart", "1"),
        ("w:commentRangeStart", "2"),
        ("w:commentRangeEnd", "0"),
        ("w:commentRangeEnd", "1"),
        ("w:commentRangeEnd", "2"),
    ]
    if source_title_ids != expected_title_ids or output_title_ids != expected_title_ids:
        raise RuntimeError("中文题目批注 0、1、2 的嵌套锚点顺序不正确")

    locations = comment_reference_locations(output_document)
    if locations.get("11") != REFERENCES[2]:
        raise RuntimeError("批注 11 未迁移到新第 3 篇文献末尾")
    if locations.get("12") != REFERENCES[13]:
        raise RuntimeError("批注 12 未迁移到新第 14 篇文献末尾")
    for comment_id in ("11", "12"):
        if output_xml.count(f'<w:commentRangeStart w:id="{comment_id}"'.encode()) != 0:
            raise RuntimeError(f"批注 {comment_id} 不再是零长度批注")
        if output_xml.count(f'<w:commentRangeEnd w:id="{comment_id}"'.encode()) != 0:
            raise RuntimeError(f"批注 {comment_id} 不再是零长度批注")
        if output_xml.count(f'<w:commentReference w:id="{comment_id}"'.encode()) != 1:
            raise RuntimeError(f"批注 {comment_id} 的引用标记数量不为 1")

    source_comment_document = minidom.parseString(source_comments)
    output_comment_document = minidom.parseString(output_comments)
    source_comment_count = len(source_comment_document.getElementsByTagName("w:comment"))
    output_comment_count = len(output_comment_document.getElementsByTagName("w:comment"))
    if source_comment_count != 13 or output_comment_count != 13:
        raise RuntimeError("批注对象数量不是 13")
    if source_comments != output_comments or source_comments_extended != output_comments_extended:
        raise RuntimeError("批注正文、作者、日期或回复关系发生变化")
    if revision_count(source_document) != 0 or revision_count(output_document) != 0:
        raise RuntimeError("文档包含非预期的修订记录")

    years = [2025, 2024, 2024, 2024, 2024, 2025, 2023, 2019, 2023, 2003, 2010, 2017, 2011, 2023]
    journal_conference_count = sum("[J]" in item or "[C" in item for item in REFERENCES)
    report = {
        "source": str(source),
        "source_sha256": sha256_file(source),
        "output": str(output),
        "output_sha256": sha256_file(output),
        "changed_ooxml_parts": [DOCUMENT_PART],
        "unchanged_ooxml_part_count": len(unchanged_parts),
        "document_xml_before_sha256": sha256_bytes(source_xml),
        "document_xml_after_sha256": sha256_bytes(output_xml),
        "allowed_scope_only": True,
        "revision_count": 0,
        "comment_count": output_comment_count,
        "comment_parts_byte_identical": True,
        "title_comment_anchor_order": expected_title_ids,
        "zero_length_comment_locations": {
            "11": "new_reference_3_end",
            "12": "new_reference_14_end",
        },
        "reference_count": len(REFERENCES),
        "chinese_reference_count": 0,
        "first_five_years": years[:5],
        "journal_or_conference_count": journal_conference_count,
        "book_count": 0,
    }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate task book v1.3 by patching document.xml only.")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args()

    if not args.source.exists():
        raise FileNotFoundError(args.source)
    source_hash = sha256_file(args.source)
    if source_hash != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(
            f"源文件 SHA-256 不匹配：期望 {EXPECTED_SOURCE_SHA256}，实际 {source_hash}"
        )
    if args.source.resolve() == args.output.resolve():
        raise RuntimeError("输出文件不能覆盖 v1.2 源文件")

    with ZipFile(args.source, "r") as archive:
        source_document_xml = archive.read(DOCUMENT_PART)
    patched_document_xml = patch_document_xml(source_document_xml)
    write_docx(args.source, args.output, patched_document_xml)
    report = validate(args.source, args.output)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
