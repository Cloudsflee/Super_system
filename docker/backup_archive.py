#!/usr/bin/env python3
import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile

MAX_MEMBERS = 250_000
MAX_TOTAL_BYTES = 100 * 1024 * 1024 * 1024


def normalized_name(member):
    raw = member.name
    while raw.startswith("./"):
        raw = raw[2:]
    if not raw or raw == ".":
        return None
    value = PurePosixPath(raw)
    if value.is_absolute() or "\\" in raw or any(part in ("", ".", "..") for part in value.parts):
        raise ValueError("archive_path_invalid")
    if member.islnk() or member.isdev() or member.isfifo():
        raise ValueError("archive_member_type_invalid")
    if member.issym():
        validate_symlink(value, member.linkname)
    elif not (member.isdir() or member.isfile()):
        raise ValueError("archive_member_type_invalid")
    return value


def validate_symlink(name, linkname):
    if not linkname or "\\" in linkname or "\0" in linkname:
        raise ValueError("archive_symlink_target_invalid")
    link = PurePosixPath(linkname)
    if link.is_absolute():
        raise ValueError("archive_symlink_target_invalid")
    resolved = list(name.parent.parts)
    for part in link.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not resolved:
                raise ValueError("archive_symlink_target_outside")
            resolved.pop()
        else:
            resolved.append(part)


def transient_codex_path(name):
    raw = str(name)
    while raw.startswith("./"):
        raw = raw[2:]
    parts = PurePosixPath(raw).parts
    return len(parts) >= 3 and parts[0] == "codex-homes" and parts[2] == "tmp"


def inspect_archive(archive):
    entries = []
    seen = set()
    total = 0
    with tarfile.open(archive, "r:*") as source:
        for index, member in enumerate(source):
            if index >= MAX_MEMBERS:
                raise ValueError("archive_member_limit_exceeded")
            name = normalized_name(member)
            if name is None:
                continue
            key = name.as_posix()
            if key in seen:
                raise ValueError("archive_duplicate_path")
            seen.add(key)
            total += member.size if member.isfile() else 0
            if total > MAX_TOTAL_BYTES:
                raise ValueError("archive_size_limit_exceeded")
            entries.append((member, name))
    return entries


def ensure_empty(destination):
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("restore_target_not_empty")


def clear_destination(destination):
    for child in destination.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink(missing_ok=True)


def create_archive(source, archive):
    source = source.resolve(strict=True)
    if not source.is_dir() or archive.exists():
        raise ValueError("backup_source_or_target_invalid")
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_name(f".{archive.name}.{os.getpid()}.tmp")
    count = 0
    total = 0

    def filter_member(member):
        nonlocal count, total
        if transient_codex_path(member.name):
            return None
        normalized_name(member)
        count += 1
        total += member.size if member.isfile() else 0
        if count > MAX_MEMBERS:
            raise ValueError("archive_member_limit_exceeded")
        if total > MAX_TOTAL_BYTES:
            raise ValueError("archive_size_limit_exceeded")
        return member

    try:
        with tarfile.open(temporary, "x:gz") as target:
            for child in sorted(source.iterdir(), key=lambda item: item.name):
                target.add(child, arcname=child.name, recursive=True, filter=filter_member)
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, archive)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def sanitize_archive(source_archive, target_archive):
    if target_archive.exists():
        raise ValueError("backup_target_exists")
    target_archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = target_archive.with_name(f".{target_archive.name}.{os.getpid()}.tmp")
    seen = set()
    total = 0
    try:
        with tarfile.open(source_archive, "r:*") as source, tarfile.open(temporary, "x:gz") as target:
            for index, member in enumerate(source):
                if transient_codex_path(member.name):
                    continue
                if index >= MAX_MEMBERS:
                    raise ValueError("archive_member_limit_exceeded")
                name = normalized_name(member)
                if name is None:
                    continue
                key = name.as_posix()
                if key in seen:
                    raise ValueError("archive_duplicate_path")
                seen.add(key)
                total += member.size if member.isfile() else 0
                if total > MAX_TOTAL_BYTES:
                    raise ValueError("archive_size_limit_exceeded")
                payload = source.extractfile(member) if member.isfile() else None
                target.addfile(member, payload)
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, target_archive)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def extract_archive(archive, destination):
    entries = inspect_archive(archive)
    ensure_empty(destination)
    root = destination.resolve()
    try:
        with tarfile.open(archive, "r:*") as source:
            by_name = {member.name: member for member in source.getmembers()}
            ordered = sorted(entries, key=lambda item: 0 if item[0].isdir() else 2 if item[0].issym() else 1)
            for inspected, relative in ordered:
                member = by_name[inspected.name]
                target = root.joinpath(*relative.parts)
                target.parent.resolve(strict=False).relative_to(root)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if member.issym():
                    target.symlink_to(member.linkname)
                    continue
                payload = source.extractfile(member)
                if payload is None:
                    raise ValueError("archive_file_unreadable")
                with target.open("xb") as output:
                    shutil.copyfileobj(payload, output, length=1024 * 1024)
                os.chmod(target, member.mode & 0o777)
    except Exception:
        clear_destination(root)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("create", "sanitize", "validate", "extract"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", nargs="?", type=Path)
    args = parser.parse_args()
    if args.command == "create":
        if args.destination is None:
            parser.error("create requires an archive destination")
        create_archive(args.archive, args.destination)
    elif args.command == "sanitize":
        if args.destination is None:
            parser.error("sanitize requires an archive destination")
        sanitize_archive(args.archive, args.destination)
    elif args.command == "validate":
        inspect_archive(args.archive)
    elif args.destination is None:
        parser.error("extract requires destination")
    else:
        extract_archive(args.archive, args.destination)


if __name__ == "__main__":
    main()
