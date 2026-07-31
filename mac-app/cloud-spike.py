#!/usr/bin/env python3
"""
Throwaway spike: log into Supernote Cloud and print the folder tree, so we can
answer the make-or-break question for the Mac app --

  * Does Cloud sync MyStyle/ (where the plugin's registry lives)?
  * Do the plugin's files (checklist-registry.json, config.json) show up?
  * What DOES sync (Note/, Document/, ...)?

Your password is typed at a hidden prompt and is NOT stored or printed. This
uses the unofficial `sncloud` library (reverse-engineered Supernote Cloud API).

Run:
    pip3 install sncloud
    python3 mac-app/cloud-spike.py
    # (optionally: export SN_EMAIL=you@example.com  to skip the email prompt)
"""
import os
import sys
import getpass

try:
    from sncloud import SNClient
except ImportError:
    sys.exit("Missing dependency. Run:  pip3 install sncloud")

MAX_DEPTH = 3          # how deep to walk the tree
INTERESTING = ("mystyle", "ink2task", "checklist-registry", "config.json")


def name_of(item):
    """Best-effort file/folder name from whatever shape sncloud returns."""
    for attr in ("name", "fileName", "file_name", "filename"):
        v = getattr(item, attr, None)
        if v is None and isinstance(item, dict):
            v = item.get(attr)
        if v:
            return str(v)
    return str(item)


def is_folder(item):
    for attr in ("is_folder", "isFolder", "is_dir", "isDir", "directoryFlag", "folder"):
        v = getattr(item, attr, None)
        if v is None and isinstance(item, dict):
            v = item.get(attr)
        if v is not None:
            return bool(v)
    # Heuristic fallback: folders have no file extension.
    return "." not in name_of(item)


def walk(client, path, depth):
    try:
        items = client.ls(path if path else "/")
    except Exception as e:  # noqa: BLE001 - spike, show whatever broke
        print(f"{'  ' * depth}  ! could not list {path or '/'}: {e}")
        return
    for item in items:
        name = name_of(item)
        folder = is_folder(item)
        mark = ""
        low = name.lower()
        if any(k in low for k in INTERESTING):
            mark = "   <-- INTERESTING"
        print(f"{'  ' * depth}{'[DIR] ' if folder else '      '}{name}{mark}")
        if folder and depth < MAX_DEPTH:
            child = f"{path}/{name}" if path else f"/{name}"
            walk(client, child, depth + 1)


def main():
    email = os.environ.get("SN_EMAIL") or input("Supernote email: ").strip()
    password = os.environ.get("SN_PASSWORD") or getpass.getpass("Supernote password (hidden): ")

    client = SNClient()
    try:
        client.login(email, password)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Login failed: {e}")

    print("\nLogin OK. Supernote Cloud folder tree (depth "
          f"{MAX_DEPTH}), interesting names flagged:\n")
    print("[DIR] /")
    walk(client, "", 1)
    print("\nDone. Tell me:")
    print("  - Is there a MyStyle folder, and does it contain Ink2Task/ +")
    print("    checklist-registry.json / config.json?")
    print("  - If not, which folders DID show up (Note, Document, ...)?")


if __name__ == "__main__":
    main()
