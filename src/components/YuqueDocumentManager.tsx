import {
  BookOpen,
  Check,
  ExternalLink,
  FileText,
  LibraryBig,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  deleteYuqueDocument,
  ensureQuePicRepository,
  listYuqueDocuments,
  listYuqueRepositories,
} from '../lib/tauri';
import type { YuqueDocumentSummary, YuqueRepositorySummary } from '../types';

interface YuqueDocumentManagerProps {
  accountName: string;
  tokenReady: boolean;
  disabled?: boolean;
  knowledgeBaseUrl: string;
  documentUrl: string;
  onKnowledgeBaseUrlChange: (value: string) => void;
  onDocumentUrlChange: (value: string) => void;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '读取语雀知识库失败，请检查 Token 和网络连接。';
}

export function YuqueDocumentManager({
  accountName,
  tokenReady,
  disabled = false,
  knowledgeBaseUrl,
  documentUrl,
  onKnowledgeBaseUrlChange,
  onDocumentUrlChange,
}: YuqueDocumentManagerProps) {
  const [repositories, setRepositories] = useState<YuqueRepositorySummary[]>([]);
  const [documents, setDocuments] = useState<YuqueDocumentSummary[]>([]);
  const [selectedNamespace, setSelectedNamespace] = useState('');
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [creatingRepository, setCreatingRepository] = useState(false);
  const [deletingDocumentId, setDeletingDocumentId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const selectedRepository = useMemo(
    () => repositories.find((repository) => repository.namespace === selectedNamespace) || null,
    [repositories, selectedNamespace],
  );

  const refreshRepositories = useCallback(async () => {
    if (!tokenReady) {
      setRepositories([]);
      setDocuments([]);
      setSelectedNamespace('');
      return;
    }
    setLoadingRepositories(true);
    setError('');
    try {
      const next = await listYuqueRepositories(accountName);
      setRepositories(next);
      const parsedNamespace = (() => {
        try {
          const parsed = new URL(knowledgeBaseUrl);
          return parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
        } catch {
          return '';
        }
      })();
      const preferred = next.find((repository) => repository.namespace === parsedNamespace)
        || next.find((repository) => repository.managed)
        || next[0]
        || null;
      setSelectedNamespace(preferred?.namespace || '');
      if (preferred && !knowledgeBaseUrl.trim()) onKnowledgeBaseUrlChange(preferred.url);
    } catch (requestError) {
      setError(normalizeError(requestError));
    } finally {
      setLoadingRepositories(false);
    }
  }, [accountName, knowledgeBaseUrl, onKnowledgeBaseUrlChange, tokenReady]);

  const refreshDocuments = useCallback(async (namespace: string) => {
    if (!namespace || !tokenReady) {
      setDocuments([]);
      return;
    }
    setLoadingDocuments(true);
    setError('');
    try {
      setDocuments(await listYuqueDocuments(accountName, namespace));
    } catch (requestError) {
      setDocuments([]);
      setError(normalizeError(requestError));
    } finally {
      setLoadingDocuments(false);
    }
  }, [accountName, tokenReady]);

  useEffect(() => {
    void refreshRepositories();
  }, [refreshRepositories]);

  useEffect(() => {
    void refreshDocuments(selectedNamespace);
  }, [refreshDocuments, selectedNamespace]);

  const selectRepository = (namespace: string) => {
    const repository = repositories.find((candidate) => candidate.namespace === namespace);
    setSelectedNamespace(namespace);
    setDocuments([]);
    onDocumentUrlChange('');
    if (repository) onKnowledgeBaseUrlChange(repository.url);
  };

  const selectDocument = (url: string) => {
    onDocumentUrlChange(url);
  };

  const createManagedRepository = async () => {
    setCreatingRepository(true);
    setError('');
    try {
      const repository = await ensureQuePicRepository(accountName);
      const next = await listYuqueRepositories(accountName);
      setRepositories(next);
      setSelectedNamespace(repository.namespace);
      onKnowledgeBaseUrlChange(repository.url);
      onDocumentUrlChange('');
    } catch (requestError) {
      setError(normalizeError(requestError));
    } finally {
      setCreatingRepository(false);
    }
  };

  const removeDocument = async (document: YuqueDocumentSummary) => {
    if (!selectedRepository) return;
    if (!window.confirm(`确认删除语雀文档“${document.title}”吗？此操作会删除远程文档，无法通过 QuePic 撤销。`)) return;
    setDeletingDocumentId(document.id);
    setError('');
    try {
      await deleteYuqueDocument(accountName, selectedRepository.id, document.id);
      if (documentUrl === document.url) onDocumentUrlChange('');
      await refreshDocuments(selectedRepository.namespace);
    } catch (requestError) {
      setError(normalizeError(requestError));
    } finally {
      setDeletingDocumentId(null);
    }
  };

  if (!tokenReady) {
    return (
      <div className="yuque-manager-empty">
        <LibraryBig size={20} />
        <div>
          <strong>保存 OpenAPI Token 后可浏览和管理知识库</strong>
          <p>当前仍可在下方手动填写知识库与文档 URL；图片上传上限为 10 MB。</p>
        </div>
      </div>
    );
  }

  return (
    <section className="yuque-document-manager" aria-label="语雀知识库与文档管理">
      <div className="yuque-manager-heading">
        <div>
          <span>YUQUE OPENAPI LIBRARY</span>
          <h3>知识库与文档</h3>
          <p>直接选择目标知识库和文档，或创建 QuePic 专用知识库存放文件夹转出的文档。</p>
        </div>
        <div className="yuque-manager-actions">
          <button type="button" disabled={disabled || loadingRepositories} onClick={() => void refreshRepositories()}>
            {loadingRepositories ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            刷新
          </button>
          <button type="button" className="primary" disabled={disabled || creatingRepository} onClick={() => void createManagedRepository()}>
            {creatingRepository ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
            创建专用知识库
          </button>
        </div>
      </div>

      {error && <div className="yuque-manager-error">{error}</div>}

      <div className="yuque-manager-grid">
        <div className="yuque-manager-column">
          <div className="yuque-manager-column-title">
            <LibraryBig size={16} />
            <strong>知识库</strong>
            <small>{repositories.length}</small>
          </div>
          <div className="yuque-manager-list">
            {repositories.length === 0 && !loadingRepositories ? (
              <p className="yuque-manager-placeholder">当前 Token 没有读取到知识库。</p>
            ) : repositories.map((repository) => (
              <button
                type="button"
                key={repository.id}
                className={repository.namespace === selectedNamespace ? 'yuque-manager-item active' : 'yuque-manager-item'}
                disabled={disabled}
                onClick={() => selectRepository(repository.namespace)}
              >
                <span>
                  <strong>{repository.name}</strong>
                  {repository.managed && <b>QuePic</b>}
                </span>
                <small>{repository.namespace} · {repository.items_count} 篇</small>
                {repository.namespace === selectedNamespace && <Check size={15} />}
              </button>
            ))}
          </div>
        </div>

        <div className="yuque-manager-column documents">
          <div className="yuque-manager-column-title">
            <FileText size={16} />
            <strong>文档</strong>
            <small>{documents.length}</small>
          </div>
          <div className="yuque-manager-list">
            {selectedRepository && (
              <button
                type="button"
                className={!documentUrl.trim() ? 'yuque-manager-item active' : 'yuque-manager-item'}
                disabled={disabled}
                onClick={() => selectDocument('')}
              >
                <span><strong>新建文件夹同名文档</strong><b>推荐</b></span>
                <small>本次上传完成后在此知识库创建 Markdown 文档</small>
                {!documentUrl.trim() && <Check size={15} />}
              </button>
            )}
            {!selectedRepository && <p className="yuque-manager-placeholder">请先选择一个知识库。</p>}
            {selectedRepository && loadingDocuments && <p className="yuque-manager-placeholder">正在读取文档……</p>}
            {selectedRepository && !loadingDocuments && documents.map((document) => (
              <div key={document.id} className={document.url === documentUrl ? 'yuque-document-row active' : 'yuque-document-row'}>
                <button type="button" disabled={disabled} onClick={() => selectDocument(document.url)}>
                  <span><strong>{document.title}</strong><small>{document.format || '未知格式'}</small></span>
                  <small>{document.updated_at ? new Date(document.updated_at).toLocaleString() : document.slug}</small>
                  {document.url === documentUrl && <Check size={15} />}
                </button>
                <a href={document.url} target="_blank" rel="noreferrer" title="浏览器打开"><ExternalLink size={14} /></a>
                <button
                  type="button"
                  className="danger"
                  title="删除远程文档"
                  disabled={disabled || deletingDocumentId === document.id}
                  onClick={() => void removeDocument(document)}
                >
                  {deletingDocumentId === document.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {selectedRepository && (
        <div className="yuque-manager-selection">
          <BookOpen size={16} />
          <span>当前目标：<strong>{selectedRepository.name}</strong>{documentUrl.trim() ? ' · 追加到已选文档' : ' · 新建文件夹同名文档'}</span>
          <a href={selectedRepository.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开知识库</a>
        </div>
      )}
    </section>
  );
}
