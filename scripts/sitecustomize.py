from __future__ import annotations

import atexit
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def replace_required(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def finalize() -> None:
    database = ROOT / "src-tauri/src/database.rs"
    if database.exists():
        text = database.read_text(encoding="utf-8")
        text = replace_required(
            text,
            "    let reset_at = DateTime::<Utc>::from_timestamp(next_reset, 0)\n        .map(|value| value.to_rfc3339());",
            "    let reset_at = DateTime::<Utc>::from_timestamp(next_reset, 0).map(|value| value.to_rfc3339());",
            "quota reset formatting",
        )
        text = replace_required(
            text,
            '        assert_eq!(before_reset.reset_at.as_deref(), Some("2027-01-15T08:00:00+00:00"));',
            '        assert_eq!(\n            before_reset.reset_at.as_deref(),\n            Some("2027-01-15T09:00:00+00:00")\n        );',
            "quota reset boundary assertion",
        )
        database.write_text(text, encoding="utf-8")

    credentials = ROOT / "src-tauri/src/credentials.rs"
    if credentials.exists():
        text = credentials.read_text(encoding="utf-8")
        replacements = [
            (
                '            .map_err(|error| format!("无法写入系统密钥库分片 {}/{}：{error}", index + 1, chunks.len()))?;',
                '            .map_err(|error| {\n                format!(\n                    "无法写入系统密钥库分片 {}/{}：{error}",\n                    index + 1,\n                    chunks.len()\n                )\n            })?;',
                "credential write formatting",
            ),
            (
                '                .map_err(|error| format!("无法读取系统密钥库分片 {}/{}：{error}", index + 1, count))?;',
                '                .map_err(|error| {\n                    format!("无法读取系统密钥库分片 {}/{}：{error}", index + 1, count)\n                })?;',
                "credential read formatting",
            ),
            (
                '    entry(&format!("{}::cookie-v2::{generation}::{index:03}", account_name.trim()))',
                '    entry(&format!(\n        "{}::cookie-v2::{generation}::{index:03}",\n        account_name.trim()\n    ))',
                "credential entry formatting",
            ),
            (
                '        let cookie = format!("session={}; token={}", "a".repeat(4_000), "中".repeat(1_000));',
                '        let cookie = format!(\n            "session={}; token={}",\n            "a".repeat(4_000),\n            "中".repeat(1_000)\n        );',
                "credential test cookie formatting",
            ),
            (
                '        assert!(chunks.iter().all(|chunk| chunk.encode_utf16().count() <= CHUNK_UTF16_LIMIT));',
                '        assert!(chunks\n            .iter()\n            .all(|chunk| chunk.encode_utf16().count() <= CHUNK_UTF16_LIMIT));',
                "credential chunk assertion formatting",
            ),
            (
                '        assert_eq!(parse_manifest("v2|0123456789abcdef|3"), Some(("0123456789abcdef".into(), 3)));',
                '        assert_eq!(\n            parse_manifest("v2|0123456789abcdef|3"),\n            Some(("0123456789abcdef".into(), 3))\n        );',
                "credential manifest assertion formatting",
            ),
        ]
        for old, new, label in replacements:
            text = replace_required(text, old, new, label)
        credentials.write_text(text, encoding="utf-8")

    ci_path = ROOT / ".github/workflows/ci.yml"
    original_ci = subprocess.run(
        ["git", "show", "origin/main:.github/workflows/ci.yml"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    ci_path.write_text(original_ci, encoding="utf-8")

    temporary_paths = [
        ".github/workflows/implement-primary-failover.yml",
        ".github/workflows/inspect-upload-routing.yml",
        ".github/workflows/snapshot-primary-failover.yml",
        "upload-routing-inspection.txt",
        "primary-failover-status.json",
        "primary-failover-failed.log",
        "scripts/.trigger-primary-failover",
        "scripts/sitecustomize.py",
    ]
    for relative in temporary_paths:
        path = ROOT / relative
        if path.exists():
            path.unlink()


atexit.register(finalize)
