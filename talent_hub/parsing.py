import io
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path


def validate_file(name, data, max_bytes=20 * 1024 * 1024):
    ext = Path(name).suffix.lower()
    if not data or len(data) > max_bytes:
        raise ValueError("文件为空或超过上传大小限制")
    if ext == ".pdf" and not data.startswith(b"%PDF-"):
        raise ValueError("PDF 文件签名无效")
    if ext == ".docx":
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
            if (
                "word/document.xml" not in z.namelist()
                or sum(x.file_size for x in z.infolist()) > 100 * 1024 * 1024
            ):
                raise ValueError()
        except Exception:
            raise ValueError("DOCX 文件损坏或解压体积超限")
    if ext == ".txt":
        try:
            data.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise ValueError("TXT 请另存为 UTF-8 编码")
    if ext not in [".txt", ".pdf", ".docx"]:
        raise ValueError("仅支持 PDF / DOCX / UTF-8 TXT")
    return {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".txt": "text/plain",
    }[ext]


def extract(path, name, ocr=True, should_stop=None):
    if should_stop and should_stop():
        raise InterruptedError("服务停止，解析任务重新排队")
    ext = Path(name).suffix.lower()
    used_ocr = False
    if ext == ".txt":
        pages = [{"page": 1, "text": Path(path).read_text(encoding="utf-8-sig")}]
    elif ext == ".docx":
        from docx import Document

        d = Document(path)
        text = "\n".join(
            [p.text for p in d.paragraphs]
            + [" | ".join(c.text for c in row.cells) for t in d.tables for row in t.rows]
        )
        pages = [{"page": 1, "text": text}]
    elif ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(path)
        if len(reader.pages) > 100:
            raise ValueError("PDF 超过 100 页，请拆分后重试")
        pages = []
        for n, p in enumerate(reader.pages, 1):
            if should_stop and should_stop():
                raise InterruptedError("服务停止，解析任务重新排队")
            if p.get_contents() and len(p.get_contents().get_data()) > 20 * 1024 * 1024:
                raise ValueError("PDF 页内容解压后过大")
            text = p.extract_text() or ""
            if len(text.strip()) < 12:
                if not ocr:
                    raise ValueError("扫描 PDF 未启用 OCR；可开启后重试或手工建档")
                text = ocr_page(path, n - 1)
                used_ocr = True
            pages.append({"page": n, "text": text})
    else:
        raise ValueError("格式不支持")
    if should_stop and should_stop():
        raise InterruptedError("服务停止，解析任务重新排队")
    if not any(p["text"].strip() for p in pages):
        raise ValueError("未提取到文字，可手工建档")
    return pages, used_ocr


def ocr_page(path, index):
    import pypdfium2 as pdfium

    with tempfile.TemporaryDirectory(prefix="talent-ocr-") as temp:
        image = Path(temp) / "page.png"
        pdf = pdfium.PdfDocument(path)
        page = pdf[index]
        bitmap = page.render(scale=2)
        bitmap.to_pil().save(image)
        bitmap.close()
        page.close()
        pdf.close()
        if os.name == "nt":
            script = Path(__file__).with_name("ocr.ps1")
            r = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script),
                    str(image),
                ],
                capture_output=True,
                timeout=90,
            )
            if r.returncode:
                raise ValueError("Windows 本地 OCR 不可用；请安装系统 OCR 语言包或手工建档")
            return json.loads(r.stdout.decode("utf-8-sig"))["text"]
        r = subprocess.run(
            [
                "tesseract",
                str(image),
                "stdout",
                "-l",
                os.environ.get("TALENT_OCR_LANG", "chi_sim+eng"),
            ],
            capture_output=True,
            timeout=90,
        )
        if r.returncode:
            raise ValueError("本地 Tesseract OCR 失败，请检查语言包")
        return r.stdout.decode("utf-8")
