from pathlib import Path

path = Path('src/App.tsx')
text = path.read_text(encoding='utf-8')
old = '  UploadCloud,\n  UserRound,\n  X,\n'
new = '  UploadCloud,\n  UserRound,\n  Users,\n  X,\n'
if old not in text:
    raise SystemExit('App icon import marker not found')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Added Users icon import.')
