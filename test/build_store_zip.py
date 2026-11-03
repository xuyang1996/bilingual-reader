#!/usr/bin/env python3
"""
Bilingual Reader — Chrome 应用商店发布包构建

商店上传的压缩包要求：
  · manifest.json 必须在**压缩包根目录**（不能像仓库里的 zip 那样带一层目录）
  · 不包含测试、文档、缓存文件
  · 保留 demo/ —— 审核员要靠它验证功能（审核备注里指向了这个页面）

用法:
    python3 test/build_store_zip.py --ext . --out ../bilingual-reader-store.zip
"""
import argparse
import os
import sys
import zipfile

# 不进包的目录
EXCLUDE_DIRS = {'__pycache__', '.git', 'node_modules', 'test', 'docs', 'store', '.idea', '.vscode'}
# 不进包的文件
EXCLUDE_FILES = {'.DS_Store', 'README.md', 'Thumbs.db'}


def build(src, out):
    src = os.path.abspath(src)
    out = os.path.abspath(out)
    if os.path.exists(out):
        os.remove(out)

    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, filenames in os.walk(src):
            rel = os.path.relpath(dirpath, src)
            # 顶层目录一律排除（test/docs/store…），子目录按同一规则
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for f in filenames:
                if f in EXCLUDE_FILES or f.endswith(('.pyc', '.pyo', '.swp')):
                    continue
                p = os.path.join(dirpath, f)
                # 压缩包内的路径就是相对 src 的路径 —— manifest.json 因此落在根目录
                z.write(p, os.path.relpath(p, src))
                count += 1
    return count


def verify(out):
    """校验发布包是否符合商店要求"""
    problems = []
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        if 'manifest.json' not in names:
            problems.append('manifest.json 不在压缩包根目录')
        for n in names:
            top = n.split('/')[0]
            if top in EXCLUDE_DIRS:
                problems.append('不该出现的目录：' + n)
            if n.endswith('.DS_Store') or '__pycache__' in n:
                problems.append('不该出现的文件：' + n)
        # manifest 必须能被解析
        import json
        try:
            m = json.loads(z.read('manifest.json'))
            if not m.get('version'):
                problems.append('manifest 缺少 version')
            if m.get('manifest_version') != 3:
                problems.append('manifest_version 不是 3')
        except Exception as e:
            problems.append('manifest.json 解析失败：%s' % e)
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ext", default=".")
    ap.add_argument("--out", default="../bilingual-reader-store.zip")
    args = ap.parse_args()

    n = build(args.ext, args.out)
    print("发布包：%s（%d 个文件，%.1f KB）" % (
        os.path.abspath(args.out), n, os.path.getsize(args.out) / 1024))

    problems = verify(args.out)
    if problems:
        print("\n❌ 发布包有问题：")
        for p in problems:
            print("   -", p)
        return 1

    with zipfile.ZipFile(args.out) as z:
        print("\n包内结构（前 12 项）：")
        for i in sorted(z.namelist())[:12]:
            print("   ", i)
        print("    ...")
    print("\n✅ 发布包校验通过：manifest.json 在根目录，无测试/文档/缓存文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
