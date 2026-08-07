#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-skill-zips.py — 构建 Skill 单卡 ZIP 与合集 ZIP。

产物（写入 skills/files/）：
  - skill-12-manager-ai-audit-week.zip      单卡：管理者 AI 效率审计
  - skill-01-ai-meeting-notes-4columns.zip  单卡：AI 会议纪要·四栏法
  - skill-04-ai-weekly-report.zip           单卡：AI 写周报法
  - skill-collection-premium.zip            合集：3 个 Skill 子目录打包（全集包邮件附件）

每个单卡 ZIP 内含（对齐 RedSkill 交付规范：SKILL.md + README.md + 配套文件）：
  - SKILL.md               可安装进 AI 助手的技能定义
  - README.md              使用说明（30 秒跑通）
  - 方法卡（中文名 .md）     阅读版精品方法卡
  - （skill-12 额外）system-prompt.md + audit-template.md

用法：python3 scripts/build-skill-zips.py   （在仓库根目录运行）
"""

import os
import zipfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FILES_DIR = os.path.join(REPO, 'skills', 'files')

# skillId → (源目录, 合集子目录名, ZIP 文件名)
SPEC = [
    ('skill-12-manager-ai-audit-week', '01-管理者AI效率审计', 'skill-12-manager-ai-audit-week.zip'),
    ('skill-01-ai-meeting-notes-4columns', '02-AI会议纪要四栏法', 'skill-01-ai-meeting-notes-4columns.zip'),
    ('skill-04-ai-weekly-report', '03-AI写周报法', 'skill-04-ai-weekly-report.zip'),
]


def build_zip(src_dir, arc_root, zip_path):
    """把 src_dir 下所有文件打包；arc_root 为 zip 内根目录名（None 表示文件放顶层）"""
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(os.listdir(src_dir)):
            full = os.path.join(src_dir, name)
            if not os.path.isfile(full):
                continue
            arc = name if arc_root is None else os.path.join(arc_root, name)
            zf.write(full, arc)
    return os.path.getsize(zip_path)


def main():
    os.makedirs(FILES_DIR, exist_ok=True)

    # 单卡 ZIP
    for src_dir_name, arc_root, zip_name in SPEC:
        src_dir = os.path.join(FILES_DIR, src_dir_name)
        if not os.path.isdir(src_dir):
            print('⚠️ 跳过（缺源目录）: %s' % src_dir_name)
            continue
        zip_path = os.path.join(FILES_DIR, zip_name)
        size = build_zip(src_dir, None, zip_path)
        n = len([f for f in os.listdir(src_dir) if os.path.isfile(os.path.join(src_dir, f))])
        print('✅ 单卡 ZIP: %s（%d 个文件，%d KB）' % (zip_name, n, size // 1024))

    # 合集 ZIP：3 个 Skill 子目录
    coll_zip = os.path.join(FILES_DIR, 'skill-collection-premium.zip')
    with zipfile.ZipFile(coll_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
        total = 0
        for src_dir_name, arc_root, _ in SPEC:
            src_dir = os.path.join(FILES_DIR, src_dir_name)
            if not os.path.isdir(src_dir):
                continue
            for name in sorted(os.listdir(src_dir)):
                full = os.path.join(src_dir, name)
                if os.path.isfile(full):
                    zf.write(full, os.path.join(arc_root, name))
                    total += 1
    size = os.path.getsize(coll_zip)
    print('✅ 合集 ZIP: skill-collection-premium.zip（%d 个文件，%d KB）' % (total, size // 1024))


if __name__ == '__main__':
    main()
