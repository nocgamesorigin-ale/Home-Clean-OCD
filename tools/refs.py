# Print every component that references a GameObject (by name or index): who drives it.
# usage: python3 tools/refs.py public/data/levels/L_X.json <index|name>
import json, sys
N = json.load(open(sys.argv[1]))['nodes']
a = sys.argv[2]
ids = [int(a)] if a.isdigit() else [i for i, n in enumerate(N) if n['name'] == a]
def has(o, t):
    if isinstance(o, dict):
        if o.get('go') in t and len(o) <= 2: return True
        return any(has(v, t) for v in o.values())
    if isinstance(o, list): return any(has(v, t) for v in o)
    return False
for i, n in enumerate(N):
    for c in n['comps']:
        if c and has(c, set(ids)):
            print(f"{n['name']}#{i} <{c['t']}>", json.dumps({k: v for k, v in c.items() if v not in (None, 0, [], '', {}) and k not in ('t', 'm_Enabled', 'm_Name', 'm_TweenChecker')})[:260])
