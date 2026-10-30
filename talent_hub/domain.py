"""Validation, evidence extraction and reproducible scoring; no network side effects."""

import copy
import datetime as dt
import re
import uuid

STAGES = ["待联系", "电话初筛", "业务面试", "综合面试", "待决策", "已录用", "已结束"]
RULE_VERSION = "evidence-v2.1"
STATUSES = ["新入库", "待联系", "可推荐", "面试中", "人才储备", "暂不考虑"]
FIELDS = {
    "name": "姓名",
    "phone": "电话",
    "email": "邮箱",
    "city": "当前城市",
    "targetCity": "目标城市",
    "company": "当前公司",
    "role": "当前岗位",
    "targetRole": "目标岗位",
    "years": "工作年限",
    "education": "教育经历",
    "english": "英语能力",
    "skills": "技能",
    "industry": "行业",
    "monthly": "月薪期望（千元）",
    "annual": "年薪期望（万元）",
    "source": "来源",
    "text": "履历原文",
}
REQUIRED = [
    "name",
    "phone",
    "email",
    "city",
    "targetCity",
    "targetRole",
    "years",
    "education",
    "english",
]
PLACEHOLDERS = {
    "未知",
    "待补全",
    "待确认",
    "未填写",
    "未提供",
    "不详",
    "暂无",
    "n/a",
    "unknown",
    "-",
    "null",
    "none",
}
PERMISSIONS = {
    "管理员": {
        "read",
        "write",
        "salary",
        "files",
        "export",
        "admin",
        "audit",
        "interview",
        "pipeline",
    },
    "HR": {"read", "write", "salary", "files", "export", "interview", "pipeline"},
    "招聘经理": {"read", "interview", "pipeline"},
    "面试官": {"read", "interview"},
}


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def uid():
    return str(uuid.uuid4())


def valid(v):
    return (
        v is not None
        and str(v).strip().lower() not in PLACEHOLDERS | {""}
        and not re.search(r"待补全|待确认|待核实|未提供", str(v))
    )


def phone(v):
    p = re.sub(r"[^\d+]", "", str(v or ""))
    if p.startswith("+86") and len(p) == 14:
        p = p[3:]
    if p.startswith("0086") and len(p) == 15:
        p = p[4:]
    return p


def email(v):
    return str(v or "").strip().casefold()


def missing(c):
    out = [k for k in REQUIRED if not valid(c.get(k))]
    if c.get("employment", "在职") != "未任职":
        out += [k for k in ["company", "role"] if not valid(c.get(k))]
    if "phone" not in out and not re.fullmatch(r"\+?\d{7,15}", phone(c.get("phone"))):
        out.append("phone")
    if "email" not in out and not re.fullmatch(
        r"[^\s@]+@[^\s@]+\.[^\s@]+", str(c.get("email", ""))
    ):
        out.append("email")
    try:
        if float(c.get("years", "")) < 0 or float(c.get("years", "")) > 60:
            raise ValueError()
    except (ValueError, TypeError):
        if "years" not in out:
            out.append("years")
    return out


def validate_candidate(data, old=None):
    c = copy.deepcopy(old or {})
    for k in FIELDS:
        if k in data:
            c[k] = str(data[k] if data[k] is not None else "").strip()[
                : 200000 if k == "text" else 2000
            ]
    for k in ["employment", "status"]:
        if k in data:
            c[k] = str(data[k])
    c.setdefault("employment", "在职")
    c.setdefault("status", "新入库")
    if c["employment"] not in ["在职", "未任职"]:
        raise ValueError("任职状态无效")
    if c["status"] not in STATUSES:
        raise ValueError("人才状态无效")
    if not valid(c.get("name")):
        raise ValueError("请填写有效姓名")
    if c.get("years"):
        try:
            if not 0 <= float(c["years"]) <= 60:
                raise ValueError()
        except ValueError:
            raise ValueError("工作年限必须为 0–60 的数字")
    for k in ["monthly", "annual"]:
        value = c.get(k, "")
        if value:
            match = re.fullmatch(r"(\d+(?:\.\d+)?)(?:\s*[-–—~至]\s*(\d+(?:\.\d+)?))?", value)
            if match is None:
                raise ValueError("薪资请输入非负数字或范围")
            from decimal import Decimal

            if match[2] is not None and Decimal(match[1]) > Decimal(match[2]):
                raise ValueError("薪资下限不能大于上限")
    c["missing"] = missing(c)
    # Verification is independent of parsing and non-empty completeness.
    if "verified" in data:
        c["verified"] = bool(data.get("verified")) and not c["missing"]
    elif c["missing"] or any(
        c.get(k) != old.get(k) for k in REQUIRED + ["company", "role", "employment"] if old
    ):
        c["verified"] = False
    else:
        c.setdefault("verified", False)
    c["updated"] = utc()
    c.setdefault("created", c["updated"])
    c.setdefault("resumeIds", [])
    c["phoneNormalized"] = phone(c.get("phone"))
    c["emailNormalized"] = email(c.get("email"))
    return c


def parse_fields(pages):
    evidence = {}
    out = {}
    lines = []
    aliases = {
        "name": "姓名|Name|Full name",
        "phone": "电话|手机|Phone|Mobile",
        "email": "邮箱|Email|E-mail",
        "city": "当前城市|现居|城市|City",
        "targetCity": "目标城市|意向城市|Target city",
        "company": "当前公司|公司|Company",
        "role": "当前岗位|岗位|职位|Current role|Title",
        "targetRole": "目标岗位|意向岗位|Target role",
        "years": "工作年限|工作经验|Experience",
        "education": "教育经历|学历|Education",
        "english": "英语能力|英语|English",
        "skills": "技能|标签|Skills",
        "industry": "行业|Industry",
    }
    for page in pages:
        for n, line in enumerate(page["text"].splitlines(), 1):
            if line.strip():
                lines.append((page["page"], n, line.strip()))
    for k, a in aliases.items():
        for page, n, line in lines:
            m = re.search(r"(?:^|\s)(?:" + a + r")\s*[:：]\s*(.+)", line, re.I)
            if m:
                value = m.group(1).strip()
                if k == "years":
                    value = (re.search(r"\d+(?:\.\d+)?", value) or [""])[0]
                out[k] = value
                evidence[k] = {
                    "page": page,
                    "line": n,
                    "quote": line,
                    "raw": m.group(1),
                    "confirmed": False,
                }
                break
    for k, pattern in [
        ("phone", r"(?<!\d)(?:\+86[ -]?)?1[3-9][\d -]{9,13}(?!\d)"),
        ("email", r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"),
    ]:
        if k not in out:
            for page, n, line in lines:
                m = re.search(pattern, line, re.I)
                if m:
                    out[k] = m.group()
                    evidence[k] = {
                        "page": page,
                        "line": n,
                        "quote": line,
                        "raw": m.group(),
                        "confirmed": False,
                    }
                    break
    out["text"] = "\n\n".join(p["text"] for p in pages)
    return out, evidence


def duplicate_candidates(parsed, hash_value, candidates, resumes):
    matches = []
    for c in candidates:
        reasons = []
        if any(r.get("hash") == hash_value and r["id"] in c.get("resumeIds", []) for r in resumes):
            reasons.append("相同文件 SHA-256")
        if phone(parsed.get("phone")) and phone(parsed.get("phone")) == phone(c.get("phone")):
            reasons.append("标准化电话一致")
        if email(parsed.get("email")) and email(parsed.get("email")) == email(c.get("email")):
            reasons.append("标准化邮箱一致")
        if (
            parsed.get("name") == c.get("name")
            and valid(parsed.get("company"))
            and parsed.get("company") == c.get("company")
        ):
            reasons.append("姓名和公司一致（需人工核查）")
        if reasons:
            matches.append(
                {
                    "id": c["id"],
                    "name": c["name"],
                    "reasons": reasons,
                    "fields": {
                        k: c.get(k, "") for k in ["name", "phone", "email", "company", "role"]
                    },
                }
            )
    return matches


def criteria_from_job(data):
    rows = data.get("criteria", [])
    if not isinstance(rows, list) or not rows:
        raise ValueError("至少确认一项岗位要求")
    if len(rows) > 30:
        raise ValueError("最多 30 项岗位要求")
    result = []
    for row in rows:
        kind = row.get("kind", "skill")
        value = str(row.get("value", "")).strip()
        if (
            kind not in ["skill", "years", "city", "education", "industry", "english", "role"]
            or not value
        ):
            raise ValueError("岗位要求类型或值无效")
        if re.search(
            r"性别|年龄|婚育|已婚|未婚|限男|限女|gender|male|female|date of birth", value, re.I
        ) or value in ["男", "女", "男性", "女性"]:
            raise ValueError("岗位评分不接受性别、年龄或婚育条件")
        weight = float(row.get("weight", 1))
        if not 0 < weight <= 100:
            raise ValueError("权重必须大于 0 且不超过 100")
        if kind == "years" and not 0 <= float(value) <= 60:
            raise ValueError("最低年限无效")
        result.append(
            {
                "id": uid(),
                "kind": kind,
                "value": value,
                "hard": bool(row.get("hard", False)),
                "weight": weight,
            }
        )
    return result


def score(candidate, version, resume=None, model_results=None):
    dims = []
    text = candidate.get("text", "")
    for criterion in version["criteria"]:
        k = criterion["kind"]
        v = criterion["value"]
        status = "UNKNOWN"
        level = None
        quote = ""
        location = None
        if model_results is not None:
            m = next((x for x in model_results if x.get("criterion_id") == criterion["id"]), None)
            if m and m.get("status") in ["MET", "PARTIAL", "NOT_MET", "UNKNOWN"]:
                quote = str(m.get("quote", ""))
                if (
                    quote
                    and quote in text
                    and m["status"] != "UNKNOWN"
                    and m.get("level") in [0, 25, 50, 75, 100]
                ):
                    status = m["status"]
                    level = m["level"]
                else:
                    quote = ""
                # A different skill is not evidence that the required skill is absent.
                if status == "NOT_MET" and k not in ["years", "city"]:
                    explicit_no = re.search(
                        r"(?:不具备|不掌握|不会|没有|无|不熟悉|no experience (?:with|in)|not proficient (?:with|in))\s*"
                        + re.escape(v),
                        quote,
                        re.I,
                    )
                    if not explicit_no:
                        status = "UNKNOWN"
                        level = None
                        quote = ""
                # Numeric/location facts confirmed by HR override an inconsistent model label.
                if (
                    quote
                    and candidate.get("verified")
                    and k == "years"
                    and valid(candidate.get("years"))
                ):
                    status = "MET" if float(candidate["years"]) >= float(v) else "NOT_MET"
                    level = 100 if status == "MET" else 0
                if (
                    quote
                    and candidate.get("verified")
                    and k == "city"
                    and valid(candidate.get("targetCity"))
                ):
                    status = (
                        "MET" if v.casefold() in candidate["targetCity"].casefold() else "NOT_MET"
                    )
                    level = 100 if status == "MET" else 0
        elif k == "years":
            if valid(candidate.get("years")):
                status = "MET" if float(candidate["years"]) >= float(v) else "NOT_MET"
                level = 100 if status == "MET" else 0
                quote = (
                    f"HR 已确认工作年限：{candidate['years']} 年"
                    if candidate.get("verified")
                    else ""
                )
        elif k == "city":
            actual = candidate.get("targetCity", "")
            if valid(actual):
                status = "MET" if v.casefold() in actual.casefold() else "NOT_MET"
                level = 100 if status == "MET" else 0
                quote = "HR 已确认目标城市：" + actual if candidate.get("verified") else ""
        else:
            field = {
                "skill": "skills",
                "education": "education",
                "industry": "industry",
                "english": "english",
                "role": "role",
            }[k]
            for page in (resume or {}).get("pages", [{"page": 1, "text": text}]):
                for n, line in enumerate(page["text"].splitlines(), 1):
                    if v.casefold() in line.casefold():
                        quote = line
                        location = {"page": page["page"], "line": n}
                        break
                if quote:
                    break
            if quote:
                status = "MET"
                level = 100
            elif (
                candidate.get("verified")
                and v.casefold() in str(candidate.get(field, "")).casefold()
            ):
                status = "MET"
                level = 100
                quote = "HR 已确认字段：" + str(candidate.get(field))
        if not quote:
            status = "UNKNOWN"
            level = None
        if quote and location is None and not quote.startswith("HR 已确认"):
            for page in (resume or {}).get("pages", [{"page": 1, "text": text}]):
                for n, line in enumerate(page["text"].splitlines(), 1):
                    if quote in line:
                        location = {"page": page["page"], "line": n}
                        break
                if location:
                    break
        dims.append(
            {
                **criterion,
                "status": status,
                "level": level,
                "quote": quote,
                "location": location,
                "resumeId": resume.get("id") if resume else None,
                "reason": "缺少已核实证据，需确认" if status == "UNKNOWN" else "按固定岗位条件核验",
            }
        )
    total = sum(d["weight"] for d in dims)
    known = sum(d["weight"] for d in dims if d["level"] is not None)
    points = (
        round(sum(d["weight"] * d["level"] for d in dims if d["level"] is not None) / known, 1)
        if known
        else None
    )
    coverage = round(known / total * 100, 1) if total else 0
    hard = [d for d in dims if d["hard"]]
    group = (
        "存在明确差距"
        if any(d["status"] == "NOT_MET" for d in hard)
        else "待确认"
        if any(d["status"] in ["UNKNOWN", "PARTIAL"] for d in hard)
        else "满足已确认条件"
    )
    return {
        "candidateId": candidate["id"],
        "name": candidate["name"],
        "score": points,
        "coverage": coverage,
        "provisional": coverage < 70,
        "group": group,
        "dimensions": dims,
        "candidateSnapshot": copy.deepcopy(candidate),
        "resumeSnapshot": copy.deepcopy(resume),
        "ruleVersion": RULE_VERSION,
    }
