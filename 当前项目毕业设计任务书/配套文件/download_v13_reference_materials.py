from __future__ import annotations

import csv
import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests


BASE_DIR = Path(__file__).resolve().parent.parent
MATERIALS_DIR = BASE_DIR / "文献核验材料（v1.3）"
PDF_DIR = MATERIALS_DIR / "公开PDF"

SOURCES = [
    {
        "number": 1,
        "short_title": "Agents in software engineering",
        "doi": "10.1007/s10515-025-00544-2",
        "official_url": "https://doi.org/10.1007/s10515-025-00544-2",
        "pdf_file": "01_Wang_Agents_in_Software_Engineering_author_manuscript.pdf",
        "pdf_url": "https://arxiv.org/pdf/2409.09030",
        "pdf_version": "作者公开稿（arXiv 2409.09030）；正式著录以 Springer DOI 为准",
    },
    {
        "number": 2,
        "short_title": "ChatDev",
        "doi": "10.18653/v1/2024.acl-long.810",
        "official_url": "https://aclanthology.org/2024.acl-long.810/",
        "pdf_file": "02_Qian_ChatDev_ACL_2024.pdf",
        "pdf_url": "https://aclanthology.org/2024.acl-long.810.pdf",
        "pdf_version": "ACL Anthology 正式版本（CC BY 4.0）",
    },
    {
        "number": 3,
        "short_title": "SWE-agent",
        "doi": "10.52202/079017-1601",
        "official_url": "https://proceedings.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html",
        "pdf_file": "03_Yang_SWE-agent_NeurIPS_2024.pdf",
        "pdf_url": "https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf",
        "pdf_version": "NeurIPS 2024 正式会议版本",
    },
    {
        "number": 4,
        "short_title": "A survey on large language model based autonomous agents",
        "doi": "10.1007/s11704-024-40231-1",
        "official_url": "https://doi.org/10.1007/s11704-024-40231-1",
        "pdf_file": "04_Wang_LLM_Autonomous_Agents_Survey.pdf",
        "pdf_url": "https://link.springer.com/content/pdf/10.1007/s11704-024-40231-1.pdf",
        "pdf_version": "Springer/Higher Education Press 正式开放版本（CC BY）",
    },
    {
        "number": 5,
        "short_title": "MetaGPT",
        "doi": "",
        "official_url": "https://openreview.net/forum?id=VtmBAGCN7o",
        "pdf_file": "05_Hong_MetaGPT_author_manuscript.pdf",
        "pdf_url": "https://arxiv.org/pdf/2308.00352",
        "pdf_version": "作者公开稿（arXiv 2308.00352）；会议状态以 ICLR OpenReview 为准",
    },
    {
        "number": 6,
        "short_title": "Model Context Protocol Specification 2025-06-18",
        "doi": "",
        "official_url": "https://modelcontextprotocol.io/specification/2025-06-18",
        "pdf_file": "",
        "pdf_url": "",
        "pdf_version": "官方持续维护的网页规范，无正式 PDF",
        "snapshot_file": "06_MCP_Specification_2025-06-18_official.html",
    },
    {
        "number": 7,
        "short_title": "Grounded Copilot",
        "doi": "10.1145/3586030",
        "official_url": "https://doi.org/10.1145/3586030",
        "pdf_file": "07_Barke_Grounded_Copilot_author_manuscript.pdf",
        "pdf_url": "https://arxiv.org/pdf/2206.15000",
        "pdf_version": "作者公开稿（arXiv 2206.15000）；正式著录以 ACM DOI 为准",
    },
    {
        "number": 8,
        "short_title": "Guidelines for human-AI interaction",
        "doi": "10.1145/3290605.3300233",
        "official_url": "https://doi.org/10.1145/3290605.3300233",
        "pdf_file": "08_Amershi_Guidelines_for_Human_AI_Interaction_author_copy.pdf",
        "pdf_url": "https://www.microsoft.com/en-us/research/uploads/prod/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf",
        "pdf_version": "Microsoft Research 作者公开终稿；正式著录以 ACM DOI 为准",
    },
    {
        "number": 9,
        "short_title": "Do users write more insecure code with AI assistants?",
        "doi": "10.1145/3576915.3623157",
        "official_url": "https://doi.org/10.1145/3576915.3623157",
        "pdf_file": "09_Perry_Insecure_Code_with_AI_Assistants_author_manuscript.pdf",
        "pdf_url": "https://arxiv.org/pdf/2211.03622",
        "pdf_version": "作者公开稿（arXiv 2211.03622）；正式著录以 ACM DOI 为准",
    },
    {
        "number": 10,
        "short_title": "Workflow patterns",
        "doi": "10.1023/A:1022883727209",
        "official_url": "https://doi.org/10.1023/A:1022883727209",
        "pdf_file": "10_Van_der_Aalst_Workflow_Patterns_repository_copy.pdf",
        "pdf_url": "https://eprints.qut.edu.au/9950/1/9950.pdf",
        "pdf_version": "QUT 机构仓储公开稿；正式著录以 Springer DOI 为准",
    },
    {
        "number": 11,
        "short_title": "Adoption of open source software in software-intensive organizations",
        "doi": "10.1016/j.infsof.2010.05.008",
        "official_url": "https://doi.org/10.1016/j.infsof.2010.05.008",
        "pdf_file": "11_Hauge_OSS_Adoption_repository_copy.pdf",
        "pdf_url": "https://upcommons.upc.edu/server/api/core/bitstreams/6e024616-6b14-43c3-84a6-cae4135c65be/content",
        "pdf_version": "UPC 机构仓储公开稿（CC BY-NC-ND）；正式著录以 Elsevier DOI 为准",
    },
    {
        "number": 12,
        "short_title": "Open source software ecosystems",
        "doi": "10.1016/j.infsof.2017.07.007",
        "official_url": "https://doi.org/10.1016/j.infsof.2017.07.007",
        "pdf_file": "12_Franco_Bedoya_OSS_Ecosystems_preprint.pdf",
        "pdf_url": "https://upcommons.upc.edu/server/api/core/bitstreams/ef618ad5-fe78-4aad-8c4c-c2c134e1a91b/content",
        "pdf_version": "UPC 机构仓储预印本；正式著录以 Elsevier DOI 为准",
    },
    {
        "number": 13,
        "short_title": "The Open Provenance Model core specification",
        "doi": "10.1016/j.future.2010.07.005",
        "official_url": "https://doi.org/10.1016/j.future.2010.07.005",
        "pdf_file": "13_Moreau_Open_Provenance_Model_repository_copy.pdf",
        "pdf_url": "https://kclpure.kcl.ac.uk/ws/files/8803757/Moreau_Open_2010.pdf",
        "pdf_version": "King's College London 机构仓储公开稿；正式著录以 Elsevier DOI 为准",
    },
    {
        "number": 14,
        "short_title": "Artificial Intelligence Risk Management Framework 1.0",
        "doi": "10.6028/NIST.AI.100-1",
        "official_url": "https://doi.org/10.6028/NIST.AI.100-1",
        "pdf_file": "14_Tabassi_NIST_AI_RMF_1.0.pdf",
        "pdf_url": "https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf",
        "pdf_version": "NIST 官方正式 PDF",
    },
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def download_pdf(session: requests.Session, source: dict) -> dict:
    destination = PDF_DIR / source["pdf_file"]
    if destination.exists():
        with destination.open("rb") as stream:
            if stream.read(5) == b"%PDF-":
                return {
                    "kind": "public_pdf",
                    "number": source["number"],
                    "file": destination.name,
                    "bytes": destination.stat().st_size,
                    "sha256": sha256_file(destination),
                    "source_url": source["pdf_url"],
                    "version_note": source["pdf_version"],
                }
    with tempfile.NamedTemporaryFile(
        prefix=destination.stem + "-",
        suffix=".part",
        dir=PDF_DIR,
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with temporary_path.open("wb") as target:
            with session.get(source["pdf_url"], stream=True, timeout=(30, 180)) as response:
                response.raise_for_status()
                for block in response.iter_content(chunk_size=1024 * 1024):
                    if block:
                        target.write(block)
        with temporary_path.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise RuntimeError(f"下载内容不是 PDF：{source['pdf_url']}")
        temporary_path.replace(destination)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return {
        "kind": "public_pdf",
        "number": source["number"],
        "file": destination.name,
        "bytes": destination.stat().st_size,
        "sha256": sha256_file(destination),
        "source_url": source["pdf_url"],
        "version_note": source["pdf_version"],
    }


def download_snapshot(session: requests.Session, source: dict) -> dict:
    destination = MATERIALS_DIR / source["snapshot_file"]
    response = session.get(source["official_url"], timeout=(30, 120))
    response.raise_for_status()
    content = response.content
    if b"<html" not in content[:10000].lower() and b"<!doctype html" not in content[:10000].lower():
        raise RuntimeError(f"官方页面快照不是 HTML：{source['official_url']}")
    destination.write_bytes(content)
    return {
        "kind": "official_html_snapshot",
        "number": source["number"],
        "file": destination.name,
        "bytes": destination.stat().st_size,
        "sha256": sha256_file(destination),
        "source_url": source["official_url"],
        "version_note": source["pdf_version"],
    }


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def crossref_snapshot(session: requests.Session) -> list[dict]:
    records = []
    for source in SOURCES:
        if not source["doi"]:
            records.append(
                {
                    "number": source["number"],
                    "doi": None,
                    "status": "not_applicable",
                    "official_url": source["official_url"],
                }
            )
            continue
        url = "https://api.crossref.org/works/" + quote(source["doi"], safe="")
        response = session.get(url, timeout=(30, 60))
        response.raise_for_status()
        message = response.json()["message"]
        records.append(
            {
                "number": source["number"],
                "doi": source["doi"],
                "status": "verified",
                "title": (message.get("title") or [None])[0],
                "authors": [
                    {"family": author.get("family"), "given": author.get("given")}
                    for author in message.get("author", [])
                ],
                "container_title": (message.get("container-title") or [None])[0],
                "published": message.get("published"),
                "volume": message.get("volume"),
                "issue": message.get("issue"),
                "page": message.get("page"),
                "publisher": message.get("publisher"),
                "official_url": source["official_url"],
            }
        )
    return records


def main() -> None:
    MATERIALS_DIR.mkdir(parents=True, exist_ok=True)
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    old_tabassi = PDF_DIR / "15_Tabassi_NIST_AI_RMF_1.0.pdf"
    new_tabassi = PDF_DIR / "14_Tabassi_NIST_AI_RMF_1.0.pdf"
    if old_tabassi.exists() and not new_tabassi.exists():
        old_tabassi.replace(new_tabassi)
    obsolete_iso_snapshot = MATERIALS_DIR / "14_ISO_IEC_25010_2023_official_page.html"
    if obsolete_iso_snapshot.exists():
        obsolete_iso_snapshot.unlink()
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "graduate-taskbook-reference-archiver/1.0",
            "Accept": "application/pdf,text/html,application/json;q=0.9,*/*;q=0.8",
        }
    )

    hashes = [download_pdf(session, source) for source in SOURCES if source["pdf_url"]]
    hashes.extend(
        download_snapshot(session, source)
        for source in SOURCES
        if source.get("snapshot_file")
    )
    downloaded_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    for row in hashes:
        row["downloaded_at"] = downloaded_at
    write_csv(
        MATERIALS_DIR / "文件哈希（SHA-256）.csv",
        ["kind", "number", "file", "bytes", "sha256", "source_url", "version_note", "downloaded_at"],
        hashes,
    )

    source_rows = [
        {
            "number": source["number"],
            "short_title": source["short_title"],
            "doi": source["doi"] or "不适用",
            "official_url": source["official_url"],
            "pdf_file": source["pdf_file"] or "无",
            "pdf_url": source["pdf_url"] or "无",
            "snapshot_file": source.get("snapshot_file", "无"),
            "pdf_version_or_restriction": source["pdf_version"],
        }
        for source in SOURCES
    ]
    write_csv(
        MATERIALS_DIR / "官方来源链接.csv",
        [
            "number",
            "short_title",
            "doi",
            "official_url",
            "pdf_file",
            "pdf_url",
            "snapshot_file",
            "pdf_version_or_restriction",
        ],
        source_rows,
    )

    metadata = {
        "retrieved_at": downloaded_at,
        "provider": "Crossref REST API",
        "records": crossref_snapshot(session),
    }
    (MATERIALS_DIR / "DOI元数据核验快照.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "public_pdf_count": sum(row["kind"] == "public_pdf" for row in hashes),
                "official_html_snapshot_count": sum(
                    row["kind"] == "official_html_snapshot" for row in hashes
                ),
                "files": hashes,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
