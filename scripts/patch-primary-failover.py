from pathlib import Path

COMPAT_QUEUE = r'''
text = replace_once(text, '  accountName: string;\n  category: string;', '  accountName: string;\n  uploadAccountName?: string;\n  category: string;', 'queue actual account')
'''

COMPAT_RESET = r'''
        assert_eq!(before_reset.reset_at.as_deref(), Some("2027-01-15T08:00:00+00:00"));
'''


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


path = Path('src/App.tsx')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    '''    if (item.result) {
      markQueueItem(id, {
        status: 'success',
        uploadAccountName: item.uploadAccountName || uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      await removeStoredQueueItem(id);
      return item.result;
    }''',
    '''    if (item.result) {
      const restored = markQueueItem(id, {
        status: 'success',
        uploadAccountName: item.uploadAccountName || uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      if (restored) await saveStoredQueueItem(toStoredQueueItem(restored));
      return item.result;
    }''',
    'persist restored upload result',
)
text = replace_once(
    text,
    '''      markQueueItem(id, {
        status: 'success',
        result,
        uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      await removeStoredQueueItem(id);''',
    '''      const succeeded = markQueueItem(id, {
        status: 'success',
        result,
        uploadAccountName,
        scheduledAt: null,
        error: undefined,
      });
      if (succeeded) await saveStoredQueueItem(toStoredQueueItem(succeeded));''',
    'persist new upload result',
)
text = replace_once(
    text,
    '''      try {
        dailyDocumentTitle = (await appendImagesToDailyDocument(targetPrimary, dailyImages))?.title || '';
      } catch (error) {
        dailyDocumentError = await persistDailyDocumentSyncFailure(dailyItems, error);
      }''',
    '''      try {
        const dailyDocument = await appendImagesToDailyDocument(targetPrimary, dailyImages);
        if (!dailyDocument) throw new Error('主账号当天文档未返回有效结果。');
        dailyDocumentTitle = dailyDocument.title;
        await Promise.all(dailyItems.map((item) => removeStoredQueueItem(item.id)));
      } catch (error) {
        dailyDocumentError = await persistDailyDocumentSyncFailure(dailyItems, error);
      }''',
    'remove stored items after document sync',
)
path.write_text(text, encoding='utf-8')
