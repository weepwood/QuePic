from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"missing replacement target: {label}")
    return text.replace(old, new, 1)


# Frontend types: use stable local asset IDs for idempotent daily-document batches.
types_path = Path("src/types.ts")
types_text = types_path.read_text(encoding="utf-8")
types_text = replace_once(
    types_text,
    "export interface DailyDocumentImage {\n  file_name: string;\n  remote_url: string;\n}",
    "export interface DailyDocumentImage {\n  asset_id: number;\n  file_name: string;\n  remote_url: string;\n}",
    "DailyDocumentImage asset id",
)
types_path.write_text(types_text, encoding="utf-8")


# Tauri bridge: serialize daily-document creation per account and add a deterministic marker.
tauri_path = Path("src/lib/tauri.ts")
tauri_text = tauri_path.read_text(encoding="utf-8")
tauri_text = replace_once(
    tauri_text,
    "const UPLOAD_CONTEXT_PREFIX = 'quepic-upload-context:';",
    "const UPLOAD_CONTEXT_PREFIX = 'quepic-upload-context:';\nconst dailyDocumentRequests = new Map<string, Promise<YuqueDocumentResult | null>>();",
    "daily document promise map",
)
ensure_start = tauri_text.index("export async function ensureDailyImageDocument(")
ensure_end = tauri_text.index("export async function appendImagesToDailyDocument(", ensure_start)
existing_ensure = tauri_text[ensure_start:ensure_end]
internal_ensure = existing_ensure.replace(
    "export async function ensureDailyImageDocument(",
    "async function resolveDailyImageDocument(",
    1,
)
wrapper = internal_ensure + """export function ensureDailyImageDocument(
  accountName: string,
): Promise<YuqueDocumentResult | null> {
  const key = accountName.trim();
  const current = dailyDocumentRequests.get(key);
  if (current) return current;

  const request = resolveDailyImageDocument(key).finally(() => {
    if (dailyDocumentRequests.get(key) === request) dailyDocumentRequests.delete(key);
  });
  dailyDocumentRequests.set(key, request);
  return request;
}

"""
tauri_text = tauri_text[:ensure_start] + wrapper + tauri_text[ensure_end:]
tauri_text = replace_once(
    tauri_text,
    "  const body = [\n    `## ${time}`,",
    "  const assetIds = [...new Set(images.map((image) => image.asset_id))].sort((left, right) => left - right);\n  const batchMarker = `<!-- quepic-daily:${assetIds.join(',')} -->`;\n  const body = [\n    batchMarker,\n    `## ${time}`,",
    "daily document idempotency marker",
)
tauri_path.write_text(tauri_text, encoding="utf-8")


# Backend: if the stable batch marker already exists, do not append or update again.
yuque_path = Path("src-tauri/src/yuque_openapi.rs")
yuque_text = yuque_path.read_text(encoding="utf-8")
yuque_text = replace_once(
    yuque_text,
    "        let merged_body = append_markdown(existing_body, body);\n        let updated = update_document(",
    "        let merged_body = append_markdown(existing_body, body);\n        if existing_body.unwrap_or_default().trim() == merged_body.trim() {\n            return Ok(document_result(existing, &namespace, false));\n        }\n        let updated = update_document(",
    "skip duplicate update",
)
old_append = """fn append_markdown(existing: Option<&str>, addition: &str) -> String {
    let existing = existing.unwrap_or_default().trim();
    if existing.is_empty() {
        addition.trim().to_string()
    } else {
        format!("{existing}\\n\\n{}", addition.trim())
    }
}
"""
new_append = """fn append_markdown(existing: Option<&str>, addition: &str) -> String {
    let existing = existing.unwrap_or_default().trim();
    let addition = addition.trim();
    let marker = addition.lines().next().filter(|line| {
        line.starts_with("<!-- quepic-daily:") && line.ends_with(" -->")
    });
    if marker.is_some_and(|marker| existing.contains(marker)) {
        return existing.to_string();
    }
    if existing.is_empty() {
        addition.to_string()
    } else {
        format!("{existing}\\n\\n{addition}")
    }
}
"""
yuque_text = replace_once(yuque_text, old_append, new_append, "idempotent append_markdown")
yuque_text = replace_once(
    yuque_text,
    """    #[test]
    fn appends_without_destroying_existing_markdown() {
        assert_eq!(
            append_markdown(Some("原有正文"), "![图片](url)"),
            "原有正文\\n\\n![图片](url)"
        );
        assert_eq!(append_markdown(None, "![图片](url)"), "![图片](url)");
    }
""",
    """    #[test]
    fn appends_without_destroying_existing_markdown() {
        assert_eq!(
            append_markdown(Some("原有正文"), "![图片](url)"),
            "原有正文\\n\\n![图片](url)"
        );
        assert_eq!(append_markdown(None, "![图片](url)"), "![图片](url)");
    }

    #[test]
    fn does_not_append_duplicate_daily_batch() {
        let batch = "<!-- quepic-daily:12,18 -->\\n## 12:30:00\\n\\n![图片](url)";
        let existing = format!("原有正文\\n\\n{batch}");
        assert_eq!(append_markdown(Some(&existing), batch), existing);
    }
""",
    "append idempotency test",
)
yuque_path.write_text(yuque_text, encoding="utf-8")


# React queue: failed daily-document sync is returned to persistent queue for a deduplicated retry.
app_path = Path("src/App.tsx")
app_text = app_path.read_text(encoding="utf-8")
app_text = replace_once(
    app_text,
    "  CacheStats,\n  StoredUploadQueueItem,",
    "  CacheStats,\n  DailyDocumentImage,\n  StoredUploadQueueItem,",
    "DailyDocumentImage import",
)
helper_anchor = "  }, [markQueueItem, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles]);\n\n  const retryUploadOne"
helper_code = """  }, [markQueueItem, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles]);

  const persistDailyDocumentSyncFailure = useCallback(async (
    items: UploadQueueItem[],
    error: unknown,
  ) => {
    const reason = normalizeError(error);
    const ids = new Set(items.map((item) => item.id));
    const updated: UploadQueueItem[] = [];
    commitQueue((current) => current.map((item) => {
      if (!ids.has(item.id)) return item;
      const next: UploadQueueItem = {
        ...item,
        status: 'failed',
        scheduledAt: null,
        error: `图片已上传，但当天文档同步失败：${reason}。重试会复用现有链接。`,
      };
      updated.push(next);
      return next;
    }));
    try {
      await saveStoredQueueItems(updated.map(toStoredQueueItem));
      return reason;
    } catch (persistError) {
      return `${reason}；恢复持久队列失败：${normalizeError(persistError)}`;
    }
  }, [commitQueue]);

  const retryUploadOne"""
app_text = replace_once(app_text, helper_anchor, helper_code, "document sync persistence helper")
app_text = replace_once(
    app_text,
    """      const dailyDocument = await appendImagesToDailyDocument(item.accountName, [{
        file_name: item.file.name,
        remote_url: result.asset.remote_url,
      }]);""",
    """      const dailyDocument = await appendImagesToDailyDocument(item.accountName, [{
        asset_id: result.asset.id,
        file_name: item.file.name,
        remote_url: result.asset.remote_url,
      }]);""",
    "single retry asset id",
)
app_text = replace_once(
    app_text,
    """    } catch (error) {
      showToast('error', `图片上传成功，但当天文档同步失败：${normalizeError(error)}`);
    }
  }, [prepareUploadContextForAccount, showToast, uploadOne]);""",
    """    } catch (error) {
      const reason = await persistDailyDocumentSyncFailure([item], error);
      showToast('error', `图片上传成功，但当天文档同步失败：${reason}`);
    }
  }, [persistDailyDocumentSyncFailure, prepareUploadContextForAccount, showToast, uploadOne]);""",
    "single retry persistence",
)
app_text = app_text.replace(
    "      const dailyImages: Array<{ file_name: string; remote_url: string }> = [];",
    "      const dailyImages: DailyDocumentImage[] = [];\n      const dailyItems: UploadQueueItem[] = [];",
)
app_text = replace_once(
    app_text,
    """          dailyImages.push({ file_name: item.file.name, remote_url: result.asset.remote_url });""",
    """          dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
          dailyItems.push(item);""",
    "batch daily item collection",
)
app_text = replace_once(
    app_text,
    """        } catch (error) {
          dailyDocumentError = normalizeError(error);
        }""",
    """        } catch (error) {
          dailyDocumentError = await persistDailyDocumentSyncFailure(dailyItems, error);
        }""",
    "batch daily persistence",
)
app_text = replace_once(
    app_text,
    """          if (result) dailyImages.push({ file_name: item.file.name, remote_url: result.asset.remote_url });""",
    """          if (result) {
            dailyImages.push({ asset_id: result.asset.id, file_name: item.file.name, remote_url: result.asset.remote_url });
            dailyItems.push(item);
          }""",
    "auto daily item collection",
)
app_text = replace_once(
    app_text,
    """          } catch (error) {
            showToast('error', `账号“${account}”图片已上传，但当天文档同步失败：${normalizeError(error)}`);
          }""",
    """          } catch (error) {
            const reason = await persistDailyDocumentSyncFailure(dailyItems, error);
            showToast('error', `账号“${account}”图片已上传，但当天文档同步失败：${reason}`);
          }""",
    "auto daily persistence",
)
app_text = replace_once(
    app_text,
    "  }, [markQueueItem, prepareUploadContextForAccount, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles, rescheduleItems, showToast, uploadOne]);",
    "  }, [markQueueItem, persistDailyDocumentSyncFailure, prepareUploadContextForAccount, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles, rescheduleItems, showToast, uploadOne]);",
    "auto upload dependencies",
)
app_path.write_text(app_text, encoding="utf-8")

print("daily document consistency fixes applied")
