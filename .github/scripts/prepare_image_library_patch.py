from pathlib import Path

path = Path('.github/scripts/apply_image_library_backend.py')
text = path.read_text(encoding='utf-8')

first = '''text = replace_once(
    text,
    ''' + "'''            existing,\n            category,\n            sha256,'''," + '''
    ''' + "'''            existing,\n            category,\n            input.tags.clone(),\n            sha256,'''," + '''
    path,
)
'''
second = '''text = replace_once(
    text,
    ''' + "'''            existing,\n            category,\n            sha256,\n            input.mime_type,'''," + '''
    ''' + "'''            existing,\n            category,\n            input.tags.clone(),\n            sha256,\n            input.mime_type,'''," + '''
    path,
)
'''
replacement = '''old_reuse_call = """            existing,
            category,
            sha256,"""
if text.count(old_reuse_call) != 2:
    raise SystemExit(f"src-tauri/src/lib.rs: expected two reuse calls, found {text.count(old_reuse_call)}")
text = text.replace(
    old_reuse_call,
    """            existing,
            category,
            input.tags.clone(),
            sha256,""",
)
'''
if first not in text or second not in text:
    raise SystemExit('unable to locate reuse call patch blocks')
text = text.replace(first, replacement).replace(second, '')

queue_block = """text = replace_once(
    text,
    '  category: string;\\n  createdAt: number;',
    '  category: string;\\n  tags: string[];\\n  createdAt: number;',
    path,
)
"""
if text.count(queue_block) != 2:
    raise SystemExit(f'unable to locate two queue shape blocks: {text.count(queue_block)}')
queue_replacement = """old_queue_shape = '  category: string;\\n  createdAt: number;'
if text.count(old_queue_shape) != 2:
    raise SystemExit(f"src/types.ts: expected two queue shapes, found {text.count(old_queue_shape)}")
text = text.replace(
    old_queue_shape,
    '  category: string;\\n  tags: string[];\\n  createdAt: number;',
)
"""
text = text.replace(queue_block, queue_replacement, 1)
text = text.replace(queue_block, '', 1)
path.write_text(text, encoding='utf-8')
