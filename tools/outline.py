# Print a level's GameObject subtree with its components (refs shown by name).
# usage: python3 tools/outline.py public/data/levels/L_Sink.json TweenStep-CleanWater [depth]
import json, sys
L = json.load(open(sys.argv[1])); N = L['nodes']; root = sys.argv[2]; maxd = int(sys.argv[3]) if len(sys.argv) > 3 else 3
kids = {}
for i, n in enumerate(N): kids.setdefault(n['parent'], []).append(i)
def nm(r):
    if isinstance(r, dict):
        if 'go' in r:
            s = N[r['go']]['name']
            if 'comp' in r and N[r['go']]['comps'][r['comp']]: s += '<' + N[r['go']]['comps'][r['comp']]['t'] + '>'
            return s
        if len(r) == 1 and isinstance(next(iter(r.values())), str): return next(iter(r.values()))
        return {k: nm(v) for k, v in r.items() if v not in (None, 0, [], '', {})}
    if isinstance(r, list): return [nm(x) for x in r]
    return r
SKIP = {'SpriteRenderer', 'BoxCollider2D', 'Rigidbody2D', 'ParticleSystem', 'ParticleSystemRenderer', 'AudioSource', 'MeshFilter', 'CanvasRenderer'}
def walk(i, d):
    n = N[i]
    cs = [c['t'] + json.dumps(nm({k: v for k, v in c.items() if k not in ('t', 'm_Name', 'm_Enabled', 'm_TweenChecker', 'ACTIVE', 'namecode')}), ensure_ascii=False)[:280] for c in n['comps'] if c and c['t'] not in SKIP]
    print('  ' * d + n['name'] + ('' if n['active'] else ' [off]') + '  ' + ' | '.join(cs))
    if d < maxd:
        for k in kids.get(i, []): walk(k, d + 1)
for i, n in enumerate(N):
    if n['name'] == root:
        walk(i, 0)
        break
