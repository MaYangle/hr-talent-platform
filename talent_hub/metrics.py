"""Cohort based metrics with explicit denominators and drilldown IDs."""

import datetime as dt
from collections import Counter, defaultdict

from .domain import STAGES, missing, utc


def calculate(store, db, filters):
    now = dt.datetime.now(dt.timezone.utc)
    start = filters.get("start", "")
    end = filters.get("end", "")
    source = filters.get("source", "")
    job = filters.get("jobId", "")
    if start and end and start > end:
        raise ValueError("开始日期不能晚于结束日期")

    def in_dates(s):
        # Business dates use Asia/Shanghai UTC+8 rather than host local timezone.
        value = (
            dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
            .astimezone(dt.timezone(dt.timedelta(hours=8)))
            .date()
            .isoformat()
        )
        return (not start or value >= start) and (not end or value <= end)

    cs = [
        c
        for c in store.all(db, "candidates")
        if in_dates(c["created"]) and (not source or c.get("source") == source)
    ]
    ids = {c["id"] for c in cs}
    apps = [
        a
        for a in store.all(db, "applications")
        if a["candidateId"] in ids and (not job or a["jobId"] == job)
    ]
    if job:
        ids = {a["candidateId"] for a in apps}
        cs = [c for c in cs if c["id"] in ids]
    interviews = [
        i
        for i in store.all(db, "interviews")
        if i["candidateId"] in ids and (not job or i["jobId"] == job)
    ]
    imports = [
        i
        for i in store.all(db, "imports")
        if in_dates(i["created"]) and (not source or i.get("source") == source)
    ]
    elapsed = defaultdict(list)
    visited = {s: set() for s in STAGES}
    for a in apps:
        history = a.get("history", [])
        for n, h in enumerate(history):
            visited[h["stage"]].add(a["id"])
            begin = dt.datetime.fromisoformat(h["at"])
            finish = (
                dt.datetime.fromisoformat(history[n + 1]["at"]) if n + 1 < len(history) else now
            )
            elapsed[h["stage"]].append(max(0, (finish - begin).total_seconds() / 86400))
    stageRows = []
    for n, s in enumerate(STAGES):
        reached = visited[s]
        next_ids = visited[STAGES[n + 1]] if n + 1 < len(STAGES) else set()
        advanced = reached & next_ids
        stageRows.append(
            {
                "stage": s,
                "current": sum(a["stage"] == s for a in apps),
                "reached": len(reached),
                "advanced": len(advanced),
                "conversion": round(len(advanced) / len(reached) * 100, 1)
                if reached and n + 1 < len(STAGES)
                else None,
                "averageDays": round(sum(elapsed[s]) / len(elapsed[s]), 2) if elapsed[s] else None,
                "candidateIds": sorted({a["candidateId"] for a in apps if a["stage"] == s}),
            }
        )
    sourceRows = []
    for s, count in Counter(c.get("source", "未知") for c in cs).most_common():
        group = {c["id"] for c in cs if c.get("source", "未知") == s}
        interviewed = {
            i["candidateId"]
            for i in interviews
            if i["candidateId"] in group and i["status"] != "已取消"
        }
        hired = {
            a["candidateId"] for a in apps if a["candidateId"] in group and a["stage"] == "已录用"
        }
        sourceRows.append(
            {
                "source": s,
                "candidates": count,
                "interviewed": len(interviewed),
                "hired": len(hired),
                "interviewRate": round(len(interviewed) / count * 100, 1),
                "hireRate": round(len(hired) / count * 100, 1),
                "candidateIds": sorted(group),
            }
        )
    trends = Counter()
    for c in cs:
        month = (
            dt.datetime.fromisoformat(c["created"])
            .astimezone(dt.timezone(dt.timedelta(hours=8)))
            .strftime("%Y-%m")
        )
        trends[month] += 1
    active = [a for a in apps if a["stage"] not in ["已录用", "已结束"]]
    overdue = [
        a
        for a in active
        if a.get("due") and dt.datetime.fromisoformat(a["due"].replace("Z", "+00:00")) < now
    ]
    feedback = [
        i
        for i in interviews
        if i.get("due")
        and i["status"] not in ["已完成", "已取消"]
        and dt.datetime.fromisoformat(i["due"].replace("Z", "+00:00")) < now
    ]
    terminal = [i for i in imports if i.get("parsed") or i["state"] == "failed"]
    parsed = sum(bool(i.get("parsed")) for i in terminal)
    return {
        "asOf": utc(),
        "cohort": filters,
        "definitions": "按候选人入库日期形成队列，岗位筛选取已加入该岗位的人才；阶段转化=访问本阶段且访问下一阶段的岗位申请数 / 访问本阶段的申请数（跳阶段不推定通过）；停留天数含进行中的区间；渠道率按去重人才计数。导入解析率独立按上传日期、来源统计，尚未处理的任务不入分母。",
        "total": len(cs),
        "incomplete": sum(bool(missing(c)) for c in cs),
        "unverified": sum(not c.get("verified") for c in cs),
        "applications": len(apps),
        "overdue": len(overdue),
        "feedbackOverdue": len(feedback),
        "parseRate": round(parsed / len(terminal) * 100, 1) if terminal else None,
        "parseDenominator": len(terminal),
        "duplicateCount": sum(bool(i.get("duplicates")) for i in imports),
        "stages": stageRows,
        "channels": sourceRows,
        "trends": sorted(trends.items()),
        "candidateIds": sorted(ids),
        "overdueIds": sorted({a["candidateId"] for a in overdue}),
        "feedbackIds": sorted({i["candidateId"] for i in feedback}),
    }
