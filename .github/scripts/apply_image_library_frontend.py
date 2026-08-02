from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding='utf-8')


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding='utf-8')


def replace_once(text: str, old: str, new: str, path: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}\n{old}')
    return text.replace(old, new, 1)


path = 'src/App.tsx'
text = read(path)
text = replace_once(
    text,
    '''  clearPreviewCache,
  deleteAsset,
  getCacheStats,''',
    '''  clearPreviewCache,
  createLibraryFolder,
  deleteAsset,
  getCacheStats,''',
    path,
)
text = replace_once(
    text,
    '''  listAssets,
  openYuqueLogin,''',
    '''  listAssetTags,
  listAssets,
  listLibraryFolders,
  openExternalUrl,
  openYuqueLogin,''',
    path,
)
text = replace_once(
    text,
    '''    clearStoredUploadContext,
    updateAssetCategory,

  uploadImage,''',
    '''    clearStoredUploadContext,
    updateAssetCategory,
    updateAssetTags,

  uploadImage,''',
    path,
)
text = replace_once(
    text,
    'async function createQueueItem(file: File, accountName: string, category: string): Promise<UploadQueueItem> {',
    'async function createQueueItem(file: File, accountName: string, category: string, tags: string[]): Promise<UploadQueueItem> {',
    path,
)
text = replace_once(text, '    tags: [],\n    createdAt:', '    tags,\n    createdAt:', path)

text = replace_once(
    text,
    '''  const [uploadCategory, setUploadCategory] = useState(
    () => localStorage.getItem('quepic-upload-category') || DEFAULT_CATEGORY,
  );
  const [categoryFilter, setCategoryFilter] = useState('全部');''',
    '''  const [uploadCategory, setUploadCategory] = useState(
    () => localStorage.getItem('quepic-upload-category') || DEFAULT_CATEGORY,
  );
  const [uploadTags, setUploadTags] = useState(() => localStorage.getItem('quepic-upload-tags') || '');
  const [libraryFolders, setLibraryFolders] = useState<string[]>([DEFAULT_CATEGORY]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [newFolderDraft, setNewFolderDraft] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('全部');
  const [tagFilter, setTagFilter] = useState('全部');''',
    path,
)
text = replace_once(
    text,
    '''  const [categoryDraft, setCategoryDraft] = useState(DEFAULT_CATEGORY);
  const [bulkCategory, setBulkCategory] = useState(DEFAULT_CATEGORY);''',
    '''  const [categoryDraft, setCategoryDraft] = useState(DEFAULT_CATEGORY);
  const [tagDraft, setTagDraft] = useState('');
  const [bulkCategory, setBulkCategory] = useState(DEFAULT_CATEGORY);''',
    path,
)
text = replace_once(
    text,
    '''  const refreshCacheStats = useCallback(async () => {''',
    '''  const refreshTaxonomy = useCallback(async () => {
    try {
      const [folders, tags] = await Promise.all([listLibraryFolders(), listAssetTags()]);
      setLibraryFolders(folders.length ? folders : [DEFAULT_CATEGORY]);
      setAvailableTags(tags);
    } catch (error) {
      showToast('error', normalizeError(error));
    }
  }, [showToast]);

  const refreshCacheStats = useCallback(async () => {''',
    path,
)
text = replace_once(
    text,
    '''      refreshAssets(),
      refreshCacheStats(),
      refreshAccountStatus(targetAccount),''',
    '''      refreshAssets(),
      refreshCacheStats(),
      refreshTaxonomy(),
      refreshAccountStatus(targetAccount),''',
    path,
)
text = replace_once(
    text,
    '  }, [refreshAccountStatus, refreshAssets, refreshCacheStats]);',
    '  }, [refreshAccountStatus, refreshAssets, refreshCacheStats, refreshTaxonomy]);',
    path,
)
text = replace_once(
    text,
    '''    setCategoryDraft(selected.category || DEFAULT_CATEGORY);
    const handleKeyDown''',
    '''    setCategoryDraft(selected.category || DEFAULT_CATEGORY);
    setTagDraft((selected.tags || []).join(', '));
    const handleKeyDown''',
    path,
)
text = replace_once(
    text,
    '''  const categories = useMemo(() => {
    const values = new Set<string>(assets.map((asset) => asset.category || DEFAULT_CATEGORY));
    return Array.from(values).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [assets]);''',
    '''  const categories = useMemo(() => {
    const values = new Set<string>([DEFAULT_CATEGORY, ...libraryFolders, ...assets.map((asset) => asset.category || DEFAULT_CATEGORY)]);
    return Array.from(values).sort((left, right) => left === DEFAULT_CATEGORY ? -1 : right === DEFAULT_CATEGORY ? 1 : left.localeCompare(right, 'zh-CN'));
  }, [assets, libraryFolders]);''',
    path,
)
text = replace_once(
    text,
    '''      const categoryMatches = categoryFilter === '全部' || asset.category === categoryFilter;
      if (!categoryMatches) return false;
      if (!keyword) return true;
      return [asset.file_name, asset.remote_url, asset.mime_type, asset.account_name, asset.category]
        .some((value) => value.toLowerCase().includes(keyword));''',
    '''      const categoryMatches = categoryFilter === '全部' || asset.category === categoryFilter;
      const tagMatches = tagFilter === '全部' || (asset.tags || []).includes(tagFilter);
      if (!categoryMatches || !tagMatches) return false;
      if (!keyword) return true;
      return [asset.file_name, asset.remote_url, asset.mime_type, asset.account_name, asset.category, ...(asset.tags || [])]
        .some((value) => value.toLowerCase().includes(keyword));''',
    path,
)
text = replace_once(
    text,
    '  }, [assets, categoryFilter, librarySort, search]);',
    '  }, [assets, categoryFilter, librarySort, search, tagFilter]);',
    path,
)
text = replace_once(
    text,
    '''    const category = uploadCategory.trim() || DEFAULT_CATEGORY;
    localStorage.setItem('quepic-upload-category', category);
    const items = await mapWithConcurrency(
      accepted,
      QUEUE_PREVIEW_CONCURRENCY,
      (file) => createQueueItem(file, account, category),
    );''',
    '''    const category = uploadCategory.trim() || DEFAULT_CATEGORY;
    const tags = parseTags(uploadTags);
    localStorage.setItem('quepic-upload-category', category);
    localStorage.setItem('quepic-upload-tags', uploadTags);
    const items = await mapWithConcurrency(
      accepted,
      QUEUE_PREVIEW_CONCURRENCY,
      (file) => createQueueItem(file, account, category, tags),
    );''',
    path,
)

# Insert folder/tag handlers before bulk deletion.
text = replace_once(
    text,
    '''  const handleBulkDelete = async () => {''',
    '''  const handleCreateFolder = async () => {
    const name = newFolderDraft.trim();
    if (!name) return;
    setLibraryBusy(true);
    try {
      const created = await createLibraryFolder(name);
      setNewFolderDraft('');
      setUploadCategory(created);
      await refreshTaxonomy();
      showToast('success', `已创建文件夹“${created}”。`);
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const handleSaveTags = async () => {
    if (!selected) return;
    setLibraryBusy(true);
    try {
      const updated = await updateAssetTags(selected.id, parseTags(tagDraft));
      setSelected(updated);
      await Promise.all([refreshAssets(), refreshTaxonomy()]);
      showToast('success', '图片标签已保存。');
    } catch (error) {
      showToast('error', normalizeError(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const handleBulkDelete = async () => {''',
    path,
)

# Upload organization fields.
text = replace_once(
    text,
    '''                <label className="upload-category-field">
                  <Tags size={16} />
                  <input value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value)} placeholder="上传分类" list="category-options" />
                </label>
                <datalist id="category-options">{categories.map((category) => <option value={category} key={category} />)}</datalist>''',
    '''                <div className="upload-organization-fields">
                  <label className="upload-category-field">
                    <FolderUp size={16} />
                    <select value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value)}>
                      {categories.map((category) => <option value={category} key={category}>{category}</option>)}
                    </select>
                  </label>
                  <label className="upload-category-field">
                    <Tags size={16} />
                    <input value={uploadTags} onChange={(event) => setUploadTags(event.target.value)} placeholder="标签，用逗号分隔" list="tag-options" />
                  </label>
                </div>
                <datalist id="category-options">{categories.map((category) => <option value={category} key={category} />)}</datalist>
                <datalist id="tag-options">{availableTags.map((tag) => <option value={tag} key={tag} />)}</datalist>''',
    path,
)

# Library taxonomy sidebar.
text = replace_once(
    text,
    '''            <div className="library-layout">
              <div className={libraryViewMode === 'original' ? 'library-main original-ratio-view' : 'library-main square-view'}>''',
    '''            <div className="library-layout">
              <aside className="library-taxonomy">
                <div className="taxonomy-section">
                  <div className="taxonomy-title"><FolderUp size={15} /><strong>文件夹</strong></div>
                  <button className={categoryFilter === '全部' ? 'active' : ''} onClick={() => setCategoryFilter('全部')}><span>全部图片</span><em>{assets.length}</em></button>
                  {categories.map((category) => <button key={category} className={categoryFilter === category ? 'active' : ''} onClick={() => setCategoryFilter(category)}><span>{category}</span><em>{categoryCounts.get(category) || 0}</em></button>)}
                  <div className="taxonomy-create"><input value={newFolderDraft} onChange={(event) => setNewFolderDraft(event.target.value)} placeholder="新建文件夹" /><button disabled={libraryBusy || !newFolderDraft.trim()} onClick={() => void handleCreateFolder()}><Plus size={14} /></button></div>
                </div>
                <div className="taxonomy-section">
                  <div className="taxonomy-title"><Tags size={15} /><strong>标签</strong></div>
                  <button className={tagFilter === '全部' ? 'active' : ''} onClick={() => setTagFilter('全部')}><span>全部标签</span></button>
                  {availableTags.map((tag) => <button key={tag} className={tagFilter === tag ? 'active' : ''} onClick={() => setTagFilter(tag)}><span>#{tag}</span></button>)}
                </div>
              </aside>
              <div className={libraryViewMode === 'original' ? 'library-main original-ratio-view' : 'library-main square-view'}>''',
    path,
)
text = text.replace('<div className="category-filter">', '<div className="category-filter legacy-category-filter">', 1)
text = replace_once(text, '<div className="asset-grid">', '<div className={`asset-grid ${libraryViewMode}`}>', path)
text = replace_once(
    text,
    '''                            <span className="asset-category-tag">{asset.category || DEFAULT_CATEGORY}</span>
                            <span className={asset.cache_status''',
    '''                            <span className="asset-category-tag">{asset.category || DEFAULT_CATEGORY}</span>
                            {(asset.tags || []).length > 0 && <span className="asset-tag-summary">#{asset.tags.slice(0, 2).join(' #')}</span>}
                            <span className={asset.cache_status''',
    path,
)

# Detail metadata, tags and opener.
text = replace_once(
    text,
    '''                        <div><dt>分类</dt><dd>{selected.category}</dd></div>
                        <div><dt>来源账号</dt>''',
    '''                        <div><dt>文件夹</dt><dd>{selected.category}</dd></div>
                        <div><dt>标签</dt><dd>{selected.tags?.length ? selected.tags.map((tag) => `#${tag}`).join(' ') : '无'}</dd></div>
                        <div><dt>来源账号</dt>''',
    path,
)
text = replace_once(
    text,
    '''                      <label className="field detail-category-field"><span>图片分类</span><input value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)} list="category-options" placeholder="未分类" /></label>
                      <button className="button primary" onClick={() => void handleSaveCategory()}><Save size={16} />保存分类</button>''',
    '''                      <label className="field detail-category-field"><span>所属文件夹</span><select value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)}>{categories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
                      <button className="button primary" disabled={libraryBusy} onClick={() => void handleSaveCategory()}><Save size={16} />保存文件夹</button>
                      <label className="field detail-category-field"><span>图片标签</span><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="标签，用逗号分隔" list="tag-options" /></label>
                      <button className="button secondary" disabled={libraryBusy} onClick={() => void handleSaveTags()}><Tags size={16} />保存标签</button>''',
    path,
)
text = replace_once(
    text,
    '''                      <button className="button secondary" onClick={() => window.open(selected.remote_url, '_blank')}><ExternalLink size={16} />浏览器打开（可能下载）</button>''',
    '''                      <button className="button secondary" onClick={() => void openExternalUrl(selected.remote_url).catch((error) => showToast('error', normalizeError(error)))}><ExternalLink size={16} />使用系统浏览器打开</button>''',
    path,
)
write(path, text)

# Helper for tag normalization.
text = read(path)
insert_marker = '\nfunction normalizeError(error: unknown): string {'
if insert_marker not in text:
    raise SystemExit('src/App.tsx: normalizeError marker missing')
text = text.replace(
    insert_marker,
    '''
function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(/[,，;；\\n]/).map((item) => item.trim()).filter(Boolean))).slice(0, 20);
}

function normalizeError(error: unknown): string {''',
    1,
)
write(path, text)

# Make detail preview always contain and add responsive taxonomy + masonry rules.
path = 'src/library-overhaul.css'
write(path, '''
.upload-organization-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; width: min(560px, 90%); margin-bottom: 10px; }
.upload-category-field select { width: 100%; border: 0; outline: 0; background: transparent; color: var(--text); }
.library-layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 18px; align-items: start; }
.library-taxonomy { position: sticky; top: 112px; display: grid; gap: 14px; max-height: calc(100vh - 140px); overflow: auto; padding: 14px; border: 1px solid var(--border); border-radius: 18px; background: rgba(255,255,255,.82); box-shadow: var(--shadow-sm); }
.taxonomy-section { display: grid; gap: 5px; }
.taxonomy-title { display: flex; align-items: center; gap: 7px; padding: 5px 7px 8px; color: var(--muted); font-size: 10px; }
.taxonomy-section > button { display: flex; align-items: center; justify-content: space-between; min-width: 0; padding: 8px 9px; border: 0; border-radius: 10px; background: transparent; color: #667188; text-align: left; cursor: pointer; }
.taxonomy-section > button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.taxonomy-section > button em { font-size: 9px; font-style: normal; }
.taxonomy-section > button:hover, .taxonomy-section > button.active { color: var(--primary-dark); background: var(--primary-soft); font-weight: 700; }
.taxonomy-create { display: grid; grid-template-columns: minmax(0,1fr) 30px; gap: 5px; margin-top: 4px; }
.taxonomy-create input { min-width: 0; padding: 7px 8px; border: 1px solid var(--border); border-radius: 9px; background: white; }
.taxonomy-create button { display: grid; place-items: center; border: 0; border-radius: 9px; color: white; background: var(--primary); cursor: pointer; }
.legacy-category-filter { display: none !important; }
.asset-grid.original { display: block; columns: 260px; column-gap: 15px; }
.asset-grid.original .asset-card { display: inline-block; width: 100%; margin: 0 0 15px; break-inside: avoid; vertical-align: top; }
.asset-grid.original .asset-card > .asset-preview { width: 100%; height: auto; min-height: 120px; aspect-ratio: auto; object-fit: contain; background: #f4f5f8; }
.asset-grid.square { display: grid; grid-template-columns: repeat(auto-fill, minmax(205px, 1fr)); gap: 16px; }
.asset-grid.square .asset-card > .asset-preview { aspect-ratio: 1; object-fit: cover; }
.asset-tag-summary { display: block; margin-top: 5px; color: var(--primary); font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail { display: flex; flex-direction: column; overflow: hidden; }
.detail > .detail-preview { width: 100%; height: min(46vh, 440px); flex: 0 0 auto; object-fit: contain !important; background: #eef0f5; }
.detail-body { overflow: auto; }
.detail-category-field select { width: 100%; min-height: 40px; padding: 0 10px; border: 1px solid var(--border); border-radius: 10px; background: white; }
@media (max-width: 1180px) { .library-layout { grid-template-columns: 180px minmax(0,1fr); } .asset-grid.original { columns: 220px; } }
@media (max-width: 900px) { .library-layout { grid-template-columns: 1fr; } .library-taxonomy { position: static; grid-template-columns: repeat(2, minmax(0,1fr)); max-height: none; } .upload-organization-fields { grid-template-columns: 1fr; } }
''')

path = 'src/main.tsx'
text = read(path)
text = replace_once(text, "import './queue-library.css';\n", "import './queue-library.css';\nimport './library-overhaul.css';\n", path)
write(path, text)

print('frontend patch applied')
