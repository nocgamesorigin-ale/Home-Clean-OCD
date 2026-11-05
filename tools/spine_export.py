# Export the Spine skeletons that share a name but differ (one file per variant) and the
# GameObject -> variant mapping; then run tools/apply_spine_variants.py <out dir>.
# usage: <venv with UnityPy 1.25.4 + TypeTreeGeneratorAPI>/bin/python -I tools/spine_export.py <unzipped xapk dir> <out dir>
import hashlib, json, os, sys
import UnityPy
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator, TypeTreeNode

X = sys.argv[1]
MAIN = f"{X}/homecleaning.makeover.asmr/assets/bin/Data"
PACK = f"{X}/UnityDataAssetPack/assets/bin/Data"
gen = TypeTreeGenerator("6000.2.7f2")
gen.load_il2cpp(open(f"{X}/config.arm64_v8a/lib/arm64-v8a/libil2cpp.so", "rb").read(), open(f"{MAIN}/Managed/Metadata/global-metadata.dat", "rb").read())


def _up(assembly, fullname, _g=gen):
    assembly = assembly[:-4] if assembly.endswith(".dll") else assembly
    key = (assembly, fullname)
    if key in _g.cache:
        return _g.cache[key]
    base = _g.get_nodes(assembly, fullname)
    node = TypeTreeNode.from_list([TypeTreeNode(b.m_Level, b.m_Type, b.m_Name, 0, 0, m_MetaFlag=b.m_MetaFlag) for b in base])
    _g.cache[key] = node
    return node


gen.get_nodes_up = _up
env = UnityPy.load(MAIN, PACK)
env.typetree_generator = gen
OBJ = {}
for o in env.objects:
    OBJ[(os.path.basename(o.assets_file.name).lower(), o.path_id)] = o


def resolve(o, ref):
    fid, pid = ref.get("m_FileID", 0), ref.get("m_PathID", 0)
    if not pid:
        return None
    try:
        b = os.path.basename(o.assets_file.name) if fid == 0 else os.path.basename(o.assets_file.externals[fid - 1].path)
    except IndexError:
        return None
    return OBJ.get((b.lower(), pid))


def script_name(o):
    try:
        d = o.read_typetree()
    except Exception:
        return None, None
    if "skeletonJSON" in d and "atlasAssets" in d:
        return "SkeletonDataAsset", d
    if "skeletonDataAsset" in d and "_animationName" in d:
        return "SkeletonAnimation", d
    return None, d


def key_of(o):
    return f"{os.path.basename(o.assets_file.name).lower()}:{o.path_id}"


assets = {}  # key -> info
anims = []  # (skeleton data key, root name, go path)


def go_path(go):
    names = []
    t = go.read().m_Transform.read()
    while t is not None:
        names.append(t.m_GameObject.read().m_Name)
        t = t.m_Father.read() if t.m_Father and t.m_Father.path_id else None
    return list(reversed(names))


for o in env.objects:
    if o.type.name != "MonoBehaviour":
        continue
    cls, d = script_name(o)
    if cls == "SkeletonDataAsset":
        js = resolve(o, d.get("skeletonJSON", {}))
        raw, jname = b"", None
        if js:
            t = js.read()
            jname = t.m_Name
            raw = t.m_Script.encode("utf-8", "surrogateescape") if isinstance(t.m_Script, str) else bytes(t.m_Script)
        assets[key_of(o)] = {"name": jname, "hash": hashlib.md5(raw).hexdigest()[:8], "scale": d.get("scale"), "atlas": d.get("atlasAssets", []), "obj": o, "raw": raw}
    elif cls == "SkeletonAnimation":
        sd = resolve(o, d.get("skeletonDataAsset", {}))
        go = resolve(o, d.get("m_GameObject", {}))
        if sd and go:
            path = go_path(go)
            anims.append((key_of(sd), path[0], "/".join(path)))

# variants: same TextAsset name (case-insensitive: macOS file names) with different bytes
byname = {}
for k, a in assets.items():
    if a["name"]:
        byname.setdefault(a["name"].lower(), {}).setdefault(a["hash"], []).append(k)
dup = {n for n, v in byname.items() if len(v) > 1}
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
done = {}
mapping = {}  # "L_x|path" -> new key
for sk, root, path in anims:
    a = assets.get(sk)
    if not a or not a["name"] or a["name"].lower() not in dup:
        continue
    newkey = f"{a['name']}__{a['hash']}"
    mapping[f"{root}|{path}"] = newkey
    if newkey in done:
        continue
    done[newkey] = a
# write the variant files: .skel, .atlas (pages renamed), page images as lossless webp
meta = {}
for newkey, a in done.items():
    open(f"{OUT}/{newkey}.skel", "wb").write(a["raw"])
    meta[newkey] = {"scale": a["scale"] or 0.01}
    for aref in a["atlas"]:
        ao = resolve(a["obj"], aref)
        if not ao:
            continue
        ad = ao.read_typetree()
        af = resolve(ao, ad.get("atlasFile", {}))
        text = af.read().m_Script
        text = text.decode("utf-8") if isinstance(text, bytes) else text
        pages = {}
        for mref in ad.get("materials", []):
            mo = resolve(ao, mref)
            if not mo:
                continue
            mat = mo.read()
            for name, tex in mat.m_SavedProperties.m_TexEnvs:
                if name == "_MainTex" and tex.m_Texture and tex.m_Texture.path_id:
                    img = tex.m_Texture.read()
                    pages[img.m_Name] = img.image
        lines = text.replace("\r", "").split("\n")
        out = []
        prev_blank = True
        for ln in lines:
            st = ln.strip()
            if prev_blank and st and ":" not in st and (st.endswith(".png") or st.endswith(".jpg")):
                base = os.path.splitext(st)[0]
                img = pages.get(base) or (list(pages.values())[0] if len(pages) == 1 else None)
                fn = f"{newkey}__{base}.webp"
                if img is not None:
                    # Spine pages are drawn premultiplied (atlas pma:true); exact keeps hidden pixels black
                    from PIL import Image, ImageChops
                    r, g, b, a = img.convert("RGBA").split()
                    pm = Image.merge("RGBA", [ImageChops.multiply(ch, a) for ch in (r, g, b)] + [a])
                    pm.save(f"{OUT}/{fn}", lossless=True, quality=100, exact=True)
                out.append(fn)
            else:
                out.append(ln)
            prev_blank = st == ""
        open(f"{OUT}/{newkey}.atlas", "w").write("\n".join(out))
json.dump({"mapping": mapping, "meta": meta}, open(f"{OUT}/variants.json", "w"), indent=1)
print(len(assets), "assets;", len(dup), "names with variants;", len(done), "variant files;", len(mapping), "objects remapped")
print(sorted(done))
