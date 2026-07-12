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
    if member.issym() or member.islnk() or member.isdev() or member.isfifo():
        raise ValueError("archive_member_type_invalid")
    if not (member.isdir() or member.isfile()):
        raise ValueError("archive_member_type_invalid")
    return value


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


def extract_archive(archive, destination):
    entries = inspect_archive(archive)
    ensure_empty(destination)
    root = destination.resolve()
    try:
        with tarfile.open(archive, "r:*") as source:
            by_name = {member.name: member for member in source.getmembers()}
            for inspected, relative in entries:
                member = by_name[inspected.name]
                target = root.joinpath(*relative.parts)
                target.resolve(strict=False).relative_to(root)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
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
    parser.add_argument("command", choices=("validate", "extract"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", nargs="?", type=Path)
    args = parser.parse_args()
    if args.command == "validate":
        inspect_archive(args.archive)
    elif args.destination is None:
        parser.error("extract requires destination")
    else:
        extract_archive(args.archive, args.destination)


if __name__ == "__main__":
    main()

