# Print a GameObject subtree by node index or name, refs as name#index.
# usage: python3 tools/tree.py public/data/levels/L_X.json <index|name> [depth] [width]
import json, sys
N = json.load(open(sys.argv[1]))['nodes']
kids = {}
for i, n in enumerate(N): kids.setdefault(n['parent'], []).append(i)
def nm(r):
    if isinstance(r, dict) and 'go' in r and isinstance(r['go'], int):
        c = N[r['go']]['comps'][r['comp']] if 'comp' in r and r['comp'] < len(N[r['go']]['comps']) else None
        return f"{N[r['go']]['name']}#{r['go']}" + (f"<{c['t']}>" if c else '')
    if isinstance(r, list): return [nm(x) for x in r]
    if isinstance(r, dict): return {k: nm(v) for k, v in r.items() if v not in (None, 0, [], '', {})}
    return r
W = int(sys.argv[4]) if len(sys.argv) > 4 else 600
SKIP = {'AudioSource', 'CanvasRenderer', 'MeshFilter'}
def tree(i, d, maxd):
    n = N[i]
    cs = [c['t'] + json.dumps(nm({k: v for k, v in c.items() if k not in ('t', 'm_Name', 'm_Enabled', 'm_TweenChecker')}), ensure_ascii=False)[:W] for c in n['comps'] if c and c['t'] not in SKIP]
    print('  ' * d + f"{n['name']}#{i}" + ('' if n['active'] else ' [off]') + '  ' + ' | '.join(cs))
    if d < maxd:
        for k in kids.get(i, []): tree(k, d + 1, maxd)
a = sys.argv[2]
idx = int(a) if a.isdigit() else next(i for i, n in enumerate(N) if n['name'] == a)
tree(idx, 0, int(sys.argv[3]) if len(sys.argv) > 3 else 3)
