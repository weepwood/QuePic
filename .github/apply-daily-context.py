from pathlib import Path

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'未找到待替换内容: {path}: {old[:120]!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')

# Tauri bridge: create/find today's Markdown document before uploading and bind it as context.
replace_once(
    'src/lib/tauri.ts',
    "export async function appendImagesToDailyDocument(\n  accountName: string,\n  images: DailyDocumentImage[],\n): Promise<YuqueDocumentResult | null> {\n  if (images.length === 0) return null;\n  const token = await getOpenApiTokenStatus(accountName);\n  if (!token.configured) return null;\n\n  const repository = await ensureQuePicRepository(accountName);\n  const documents = await listYuqueDocuments(accountName, repository.namespace);\n  const title = localDateKey();\n  const existing = documents.find((document) => document.title.trim() === title);\n  const time = new Date().toLocaleTimeString('zh-CN', {\n    hour: '2-digit',\n    minute: '2-digit',\n    second: '2-digit',\n    hour12: false,\n  });\n  const body = [\n    `## ${time}`,\n    '',\n    ...images.flatMap((image) => [\n      `![${escapeMarkdownAlt(image.file_name)}](${image.remote_url})`,\n      '',\n    ]),\n  ].join('\\n').trim();\n\n  return saveYuqueDocument({\n    account_name: accountName,\n    knowledge_base_url: repository.url,\n    document_url: existing?.url || null,\n    title,\n    body,\n  });\n}\n",
    "export async function ensureDailyImageDocument(\n  accountName: string,\n): Promise<YuqueDocumentResult | null> {\n  const token = await getOpenApiTokenStatus(accountName);\n  if (!token.configured) return null;\n\n  const repository = await ensureQuePicRepository(accountName);\n  const documents = await listYuqueDocuments(accountName, repository.namespace);\n  const title = localDateKey();\n  const existing = documents.find((document) => document.title.trim() === title);\n  const document: YuqueDocumentResult = existing\n    ? {\n        id: existing.id,\n        title: existing.title,\n        slug: existing.slug,\n        url: existing.url,\n        created: false,\n        namespace: repository.namespace,\n      }\n    : await saveYuqueDocument({\n        account_name: accountName,\n        knowledge_base_url: repository.url,\n        document_url: null,\n        title,\n        body: `# ${title}\\n\\n> QuePic 每日图片记录`,\n      });\n\n  if (!document.url) throw new Error('当天语雀文档没有可用 URL。');\n  const context = await resolveUploadContext(accountName, document.url);\n  saveStoredUploadContext(context);\n  return document;\n}\n\nexport async function appendImagesToDailyDocument(\n  accountName: string,\n  images: DailyDocumentImage[],\n): Promise<YuqueDocumentResult | null> {\n  if (images.length === 0) return null;\n  const document = await ensureDailyImageDocument(accountName);\n  if (!document?.url) return null;\n  const repositoryUrl = new URL(document.url);\n  const segments = repositoryUrl.pathname.split('/').filter(Boolean);\n  if (segments.length < 2) throw new Error('无法从当天文档解析知识库 URL。');\n  const knowledgeBaseUrl = `${repositoryUrl.origin}/${segments[0]}/${segments[1]}`;\n  const time = new Date().toLocaleTimeString('zh-CN', {\n    hour: '2-digit',\n    minute: '2-digit',\n    second: '2-digit',\n    hour12: false,\n  });\n  const body = [\n    `## ${time}`,\n    '',\n    ...images.flatMap((image) => [\n      `![${escapeMarkdownAlt(image.file_name)}](${image.remote_url})`,\n      '',\n    ]),\n  ].join('\\n').trim();\n\n  return saveYuqueDocument({\n    account_name: accountName,\n    knowledge_base_url: knowledgeBaseUrl,\n    document_url: document.url,\n    title: document.title,\n    body,\n  });\n}\n",
)

# App imports and reusable context preparation.
replace_once(
    'src/App.tsx',
    "  appendImagesToDailyDocument,\n  captureYuqueLogin,\n",
    "  appendImagesToDailyDocument,\n  ensureDailyImageDocument,\n  captureYuqueLogin,\n",
)
replace_once(
    'src/App.tsx',
    "  const uploadOne = useCallback(async (id: string, deferRefresh = false) => {\n",
    "  const prepareUploadContextForAccount = useCallback(async (targetAccount: string) => {\n    const token = await getOpenApiTokenStatus(targetAccount);\n    if (token.configured) {\n      const document = await ensureDailyImageDocument(targetAccount);\n      const context = getStoredUploadContext(targetAccount);\n      if (!document || !context) return false;\n      if (activeAccountRef.current === targetAccount) {\n        setUploadContext(context);\n        setUploadContextInput(context.document_url);\n      }\n      return true;\n    }\n    return Boolean(getStoredUploadContext(targetAccount));\n  }, []);\n\n  const uploadOne = useCallback(async (id: string, deferRefresh = false) => {\n",
)
replace_once(
    'src/App.tsx',
    "    const item = queueRef.current.find((candidate) => candidate.id === id);\n    const result = await uploadOne(id);\n",
    "    const item = queueRef.current.find((candidate) => candidate.id === id);\n    if (!item) return;\n    try {\n      if (!(await prepareUploadContextForAccount(item.accountName))) {\n        showToast('error', `账号“${item.accountName}”没有 Token，也未配置手动上传上下文。`);\n        return;\n      }\n    } catch (error) {\n      showToast('error', `准备当天文档失败：${normalizeError(error)}`);\n      return;\n    }\n    const result = await uploadOne(id);\n",
)
replace_once(
    'src/App.tsx',
    "  }, [showToast, uploadOne]);\n\n  const uploadAll = async () => {\n",
    "  }, [prepareUploadContextForAccount, showToast, uploadOne]);\n\n  const uploadAll = async () => {\n",
)
replace_once(
    'src/App.tsx',
    "    if (!uploadContext) {\n      setView('settings');\n      return showToast('error', '请先为当前账号配置一个有权限的语雀文档作为上传上下文。');\n    }\n\n    const pendingItems = queueRef.current.filter(\n",
    "    try {\n      if (!(await prepareUploadContextForAccount(accountName))) {\n        setView('settings');\n        return showToast('error', '当前账号没有 Token，请先手动配置一个有权限的语雀文档作为上传上下文。');\n      }\n    } catch (error) {\n      return showToast('error', `自动创建当天文档失败：${normalizeError(error)}`);\n    }\n\n    const pendingItems = queueRef.current.filter(\n",
)
replace_once(
    'src/App.tsx',
    "        const accountQuota = await getUploadQuotaStatus(account);\n",
    "        try {\n          if (!(await prepareUploadContextForAccount(account))) {\n            for (const item of accountItems) {\n              const failed = markQueueItem(item.id, {\n                status: 'failed',\n                scheduledAt: null,\n                error: `账号“${account}”没有 Token，也未配置手动上传上下文。`,\n              });\n              if (failed) await saveStoredQueueItem(toStoredQueueItem(failed));\n            }\n            continue;\n          }\n        } catch (error) {\n          await rescheduleItems(accountItems, Date.now() + 5 * 60 * 1000, `准备当天文档失败：${normalizeError(error)}`);\n          continue;\n        }\n        const accountQuota = await getUploadQuotaStatus(account);\n",
)
replace_once(
    'src/App.tsx',
    "  }, [markQueueItem, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles, rescheduleItems, showToast, uploadOne]);\n",
    "  }, [markQueueItem, prepareUploadContextForAccount, refreshAccountStatus, refreshAssets, refreshCacheStats, refreshProfiles, rescheduleItems, showToast, uploadOne]);\n",
)
replace_once(
    'src/App.tsx',
    "disabled={!credentialReady || !uploadContext || pendingUploadCount === 0}",
    "disabled={!credentialReady || (!uploadContext && !tokenReady) || pendingUploadCount === 0}",
)
replace_once(
    'src/App.tsx',
    "{credentialReady && !uploadContext && <div className=\"warning\">当前账号尚未配置上传上下文文档。请在设置中验证一个该账号有权限访问的语雀文档 URL。</div>}",
    "{credentialReady && !uploadContext && !tokenReady && <div className=\"warning\">当前账号没有 Token，请在设置中手动验证一个有权限访问的语雀文档 URL。</div>}\n                {credentialReady && !uploadContext && tokenReady && <div className=\"queue-auto-context-note\">首次上传时会自动创建今天日期的 Markdown 文档，并将其绑定为上传上下文。</div>}",
)

# Add a small visual note style.
css = ROOT / 'src/original-viewer.css'
css.write_text(css.read_text(encoding='utf-8') + '''\n.queue-auto-context-note {\n  margin-bottom: 12px;\n  padding: 10px 12px;\n  border: 1px solid #b7eb8f;\n  border-radius: 8px;\n  color: #168f4d;\n  background: #f6ffed;\n  font-size: 12px;\n}\n''', encoding='utf-8')

# Cleanup and restore CI.
for temporary in [ROOT / '.github/apply-daily-context.py', ROOT / '.github/apply-daily-context.trigger']:
    if temporary.exists():
        temporary.unlink()

ci = ROOT / '.github/workflows/ci.yml'
ci_text = ci.read_text(encoding='utf-8')
start = ci_text.find('  apply_daily_context:\n')
if start >= 0:
    end = ci_text.find('  frontend:\n', start)
    if end < 0:
        raise SystemExit('无法恢复 CI')
    ci_text = ci_text[:start] + ci_text[end:]
ci_text = ci_text.replace('permissions:\n  contents: write\n', 'permissions:\n  contents: read\n', 1)
ci.write_text(ci_text, encoding='utf-8')
