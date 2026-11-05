# Point each SkeletonAnimation of the levels at its own Spine variant when several
# skeletons share one name (they overwrote each other in the first export).
# usage: python3 tools/apply_spine_variants.py <spine_out dir>   (run from the project root)
import glob, json, os, shutil, sys

src = sys.argv[1]
v = json.load(open(os.path.join(src, 'variants.json')))
mapping, meta = v['mapping'], v['meta']

# variant files next to the others
for f in os.listdir(src):
    if f != 'variants.json':
        shutil.copy(os.path.join(src, f), os.path.join('public/data/spine', f))
mp = 'public/data/spine/meta.json'
m = json.load(open(mp))
m.update(meta)
json.dump(m, open(mp, 'w'))

# skeleton binaries, to find the right one for components the export could not read
SKEL = {os.path.basename(f)[:-5]: open(f, 'rb').read() for f in glob.glob('public/data/spine/*.skel')}


def fits(key, names):
    b = SKEL.get(key, b'')
    return all(bytes([len(x) + 1]) + x.encode() in b for x in names)


changed = 0
for f in sorted(glob.glob('public/data/levels/L_*.json')):
    L = json.load(open(f))
    N = L['nodes']

    def path(i):
        p = []
        while i is not None and i >= 0:
            p.append(N[i]['name'])
            i = N[i]['parent']
        return list(reversed(p))

    used = {}
    for node in N:
        for c in node['comps']:
            if not c:
                continue
            if c.get('t') == 'RemoteRunAnimation' and isinstance(c.get('m_SkeletonAnimation'), dict):
                used.setdefault(c['m_SkeletonAnimation'].get('go'), set()).update(s.get('name') for s in c.get('m_ListAnimStep') or [] if s and s.get('name'))
            if c.get('t') == 'RunAnimation':
                for r in c.get('skeletonAnimation') or []:
                    if isinstance(r, dict) and c.get('anim_name'):
                        used.setdefault(r.get('go'), set()).add(c['anim_name'])
    n = 0
    for i, node in enumerate(N):
        for c in node['comps']:
            if not c or c.get('t') != 'SkeletonAnimation':
                continue
            p = path(i)
            key = mapping.get(f"{p[0]}|{'/'.join(p)}")
            sda = c.get('skeletonDataAsset')
            if key and isinstance(sda, dict) and sda.get('skeleton') != key:
                sda['skeleton'] = key
                n += 1
            # unreadable component: the skeleton that has every animation the script plays on it
            names = used.get(i)
            if 'err' in c and isinstance(sda, dict) and names and not fits(sda.get('skeleton'), names):
                # prefer a skeleton named like the object ("Insects/Insect" -> Insect_skel)
                words = {w.lower() for seg in p for w in seg.replace('(', ' ').replace(')', ' ').split()}
                cands = sorted((k for k in SKEL if fits(k, names)), key=lambda k: (k.split('_skel')[0].lower() not in words, len(SKEL[k])))
                if cands:
                    print('  ', node['name'], sda.get('skeleton'), '->', cands[0])
                    sda['skeleton'] = cands[0]
                    n += 1
    if n:
        json.dump(L, open(f, 'w'), separators=(',', ':'))
        print(os.path.basename(f), n)
        changed += n
print('remapped', changed)
