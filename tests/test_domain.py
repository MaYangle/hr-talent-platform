import unittest

from talent_hub.domain import (
    criteria_from_job,
    duplicate_candidates,
    email,
    missing,
    parse_fields,
    phone,
    score,
    validate_candidate,
)


class FieldRulesTests(unittest.TestCase):
    def test_contact_normalization_is_format_independent(self):
        self.assertEqual(phone("+86 139-0000-0000"), phone("13900000000"))
        self.assertEqual(email("USER@EXAMPLE.INVALID "), "user@example.invalid")

    def test_placeholders_and_invalid_contacts_are_not_complete(self):
        value = validate_candidate(
            {"name": "record", "phone": "未知", "email": "invalid", "verified": True}
        )
        self.assertIn("phone", value["missing"])
        self.assertIn("email", value["missing"])
        self.assertFalse(value["verified"])

    def test_unemployed_status_does_not_require_fake_employer(self):
        value = {"employment": "未任职"}
        self.assertNotIn("company", missing(value))
        self.assertNotIn("role", missing(value))
        self.assertIn("company", missing({"employment": "在职"}))

    def test_salary_bounds_and_experience_are_validated(self):
        for field, value in [
            ("monthly", "30-20"),
            ("monthly", "-1"),
            ("annual", "1..2"),
            ("years", "-1"),
            ("years", "invalid"),
        ]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_candidate({"name": "record", field: value})

    def test_gender_and_age_cannot_become_scoring_conditions(self):
        for value in ["男性", "性别", "年龄限制"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                criteria_from_job({"criteria": [{"kind": "skill", "value": value}]})

    def test_same_name_alone_does_not_suggest_a_merge(self):
        self.assertEqual(
            duplicate_candidates({"name": "record"}, "hash", [{"id": "1", "name": "record"}], []),
            [],
        )

    def test_evidence_keeps_the_actual_page_line_and_quote(self):
        fields, evidence = parse_fields([{"page": 2, "text": "Heading\nSkills: SQL"}])
        self.assertEqual(fields["skills"], "SQL")
        self.assertEqual(evidence["skills"]["page"], 2)
        self.assertEqual(evidence["skills"]["line"], 2)
        self.assertEqual(evidence["skills"]["quote"], "Skills: SQL")


class ScoringTests(unittest.TestCase):
    def setUp(self):
        self.condition = {
            "id": "skill",
            "kind": "skill",
            "value": "SQL",
            "weight": 100,
            "hard": True,
        }
        self.version = {"criteria": [self.condition]}
        self.candidate = {"id": "record", "name": "record", "text": "Python", "verified": False}

    def test_unmentioned_skill_is_unknown_not_a_rejection(self):
        value = score(self.candidate, self.version)
        self.assertIsNone(value["score"])
        self.assertEqual(value["coverage"], 0)
        self.assertEqual(value["group"], "待确认")

    def test_model_cannot_use_a_different_skill_as_negative_evidence(self):
        output = [{"criterion_id": "skill", "status": "NOT_MET", "level": 0, "quote": "Python"}]
        self.assertEqual(
            score(self.candidate, self.version, model_results=output)["dimensions"][0]["status"],
            "UNKNOWN",
        )

    def test_fabricated_quote_does_not_contribute_to_coverage(self):
        output = [{"criterion_id": "skill", "status": "MET", "level": 100, "quote": "SQL"}]
        self.assertEqual(score(self.candidate, self.version, model_results=output)["coverage"], 0)

    def test_verified_years_cannot_be_overruled_by_model_label(self):
        condition = self.condition | {"kind": "years", "value": "5"}
        candidate = self.candidate | {"years": "2", "text": "2 years", "verified": True}
        output = [{"criterion_id": "skill", "status": "MET", "level": 100, "quote": "2 years"}]
        value = score(candidate, {"criteria": [condition]}, model_results=output)
        self.assertEqual(value["dimensions"][0]["status"], "NOT_MET")
        self.assertEqual(value["score"], 0)

    def test_score_snapshot_is_independent_of_later_edits(self):
        candidate = self.candidate | {"text": "SQL"}
        value = score(candidate, self.version)
        candidate["text"] = "changed"
        self.assertEqual(value["candidateSnapshot"]["text"], "SQL")
