"""Offline documentation/link and publication-hygiene checks for tracked source."""

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
SENSITIVE = [
    re.compile(r"sk-[A-Za-z0-9]{24,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]
FORBIDDEN = {".sqlite", ".sqlite3", ".db", ".docx", ".pdf", ".xlsx", ".csv", ".tsv", ".zip", ".log"}


def source_files():
    output = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT
    )
    return sorted({ROOT / name for name in output.decode("utf-8").split("\0") if name})


def anchors(text):
    result = set()
    counts = {}
    for heading in re.findall(r"^#{1,6}\s+(.+)$", text, re.MULTILINE):
        heading = re.sub(r"<[^>]+>", "", heading).lower().strip()
        slug = re.sub(r"[^\w\- ]", "", heading).replace(" ", "-")
        number = counts.get(slug, 0)
        result.add(slug + (f"-{number}" if number else ""))
        counts[slug] = number + 1
    return result


def check(files):
    errors = []
    for file in files:
        label = str(file.relative_to(ROOT))
        if not file.is_file():
            continue
        if file.is_symlink() or file.suffix.lower() in FORBIDDEN:
            errors.append(f"{label}: runtime/data/generated artifact must not be published")
        if file.stat().st_size > 5 * 1024 * 1024:
            errors.append(f"{label}: unexpected file larger than 5 MiB")
        try:
            text = file.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if any(pattern.search(text) for pattern in SENSITIVE):
            errors.append(f"{label}: possible credential/private key (value omitted)")
        # Upstream license notices are kept verbatim; their links refer to the upstream tree.
        if file.suffix.lower() != ".md" or "licenses" in file.relative_to(ROOT).parts:
            continue
        content = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
        for raw in LINK.findall(content):
            raw = raw.strip().strip("<>")
            url = urlsplit(raw)
            if url.scheme or url.netloc:
                continue
            target = file.parent / unquote(url.path) if url.path else file
            if not target.exists():
                errors.append(f"{label}: broken relative link: {raw}")
            elif url.fragment and target.suffix.lower() == ".md":
                if unquote(url.fragment) not in anchors(target.read_text(encoding="utf-8")):
                    errors.append(f"{label}: missing heading anchor: {raw}")
    return errors


def main():
    errors = check(source_files())
    for error in errors:
        print(error)
    print(f"Repository checks: {'FAILED' if errors else 'passed'}")
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
