"""
Authorization tests for the Claims handler.

Covers the per-claimant ownership checks on the read paths (list_claims,
get_claim): an ordinary Claimant must only ever see their own claims, while
Adjusters and BusinessUsers see every claim. Mirrors the reported PoC where
claimant "Alice" must not be able to list or read claimant "Carol"'s claim.

Dependency-free: the DynamoDB table is replaced with an in-memory fake, so the
test runs anywhere with no AWS access, moto, or network.

Run:
    PYTHONPATH=backend/lambda/claims python3 -m pytest tests/test_claims_authorization.py -v
or without pytest:
    PYTHONPATH=backend/lambda/claims python3 tests/test_claims_authorization.py
"""
import importlib
import json
import os
import sys

# The handler reads these at import time and builds a boto3 resource; set them
# before import and point the module at an in-memory fake table afterwards.
os.environ.setdefault("CLAIMS_TABLE", "test-claims-table")
os.environ.setdefault("DOCUMENTS_BUCKET", "test-documents-bucket")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "backend", "lambda", "claims"),
)

claims_handler = importlib.import_module("claims_handler")


# ── In-memory fake DynamoDB table ─────────────────────────────────────
class FakeTable:
    """Minimal stand-in for the DynamoDB Table used by the handler."""

    def __init__(self, items):
        # items: list of claim dicts
        self._items = list(items)

    def scan(self, **kwargs):
        # No pagination needed for the test dataset.
        return {"Items": list(self._items)}

    def query(self, KeyConditionExpression=None, Limit=None, **kwargs):
        # The handler only queries by claimId equality via _get_claim_item.
        # KeyConditionExpression is a boto3 condition object; we don't parse it
        # here — _get_claim_item is exercised through get_claim, which passes
        # the claimId, so we match on the handler's documented behaviour by
        # scanning our items for the id embedded in the condition's values.
        target = getattr(KeyConditionExpression, "_values", [None, None])[1]
        matches = [i for i in self._items if i.get("claimId") == target]
        return {"Items": matches[:Limit] if Limit else matches}


# ── Test fixtures: Alice's claim and Carol's claim ────────────────────
ALICE_CLAIM = {
    "claimId": "CLM-AAAA-ALICE",
    "timestamp": 1000,
    "submittedAt": 1000,
    "status": "submitted",
    "claimantUsername": "alice",
    "policyHolderName": "Alice Policyholder",
    "beneficiaryName": "Bob Beneficiary",
    "causeOfDeath": "natural causes",
    "claimAmount": 100000,
    "fraudScore": 0.1,
    "aiDecision": "approved",
}
CAROL_CLAIM = {
    "claimId": "CLM-BBBB-CAROL",
    "timestamp": 2000,
    "submittedAt": 2000,
    "status": "submitted",
    "claimantUsername": "carol",
    "policyHolderName": "Carol Policyholder",
    "beneficiaryName": "Dave Beneficiary",
    "causeOfDeath": "traffic accident",
    "claimAmount": 500000,
    "fraudScore": 0.2,
    "aiDecision": "escalated",
}


def _event(username, groups, claim_id=None):
    """Build an API Gateway event with a Cognito authorizer claim."""
    evt = {
        "requestContext": {
            "authorizer": {"claims": {"cognito:username": username, "cognito:groups": groups}}
        }
    }
    if claim_id is not None:
        evt["pathParameters"] = {"claimId": claim_id}
    return evt


def _install_fake_table(items):
    claims_handler.table = FakeTable(items)


def _body(resp):
    return json.loads(resp["body"])


# ── list_claims ───────────────────────────────────────────────────────
def test_claimant_list_sees_only_own_claims():
    _install_fake_table([ALICE_CLAIM, CAROL_CLAIM])
    resp = claims_handler.list_claims(_event("alice", "Claimants"))
    assert resp["statusCode"] == 200
    ids = {c["claimId"] for c in _body(resp)}
    assert ids == {"CLM-AAAA-ALICE"}, f"Alice should see only her own claim, got {ids}"


def test_adjuster_list_sees_all_claims():
    _install_fake_table([ALICE_CLAIM, CAROL_CLAIM])
    resp = claims_handler.list_claims(_event("adj1", "Adjusters"))
    assert resp["statusCode"] == 200
    ids = {c["claimId"] for c in _body(resp)}
    assert ids == {"CLM-AAAA-ALICE", "CLM-BBBB-CAROL"}, f"Adjuster should see all, got {ids}"


def test_businessuser_list_sees_all_claims():
    _install_fake_table([ALICE_CLAIM, CAROL_CLAIM])
    resp = claims_handler.list_claims(_event("biz1", "BusinessUsers"))
    assert resp["statusCode"] == 200
    assert len(_body(resp)) == 2


# ── get_claim ─────────────────────────────────────────────────────────
def test_claimant_cannot_read_another_claimants_claim():
    _install_fake_table([ALICE_CLAIM, CAROL_CLAIM])
    # Alice tries to read Carol's claim by ID (the reported IDOR).
    resp = claims_handler.get_claim(_event("alice", "Claimants", "CLM-BBBB-CAROL"))
    assert resp["statusCode"] == 404, "Non-owner Claimant must get 404, not the record"
    assert "Dave Beneficiary" not in resp["body"]
    assert "traffic accident" not in resp["body"]


def test_claimant_can_read_own_claim_without_ai_fields():
    _install_fake_table([ALICE_CLAIM, CAROL_CLAIM])
    resp = claims_handler.get_claim(_event("alice", "Claimants", "CLM-AAAA-ALICE"))
    assert resp["statusCode"] == 200
    item = _body(resp)
    assert item["claimId"] == "CLM-AAAA-ALICE"
    # AI-internal fields still filtered from Claimants.
    assert "fraudScore" not in item
    assert "aiDecision" not in item


def test_adjuster_can_read_any_claim_with_ai_fields():
    _install_fake_table([ALICE_CLAIM, CAROL_CLAIM])
    resp = claims_handler.get_claim(_event("adj1", "Adjusters", "CLM-BBBB-CAROL"))
    assert resp["statusCode"] == 200
    item = _body(resp)
    assert item["claimId"] == "CLM-BBBB-CAROL"
    # Adjusters retain the AI-internal fields.
    assert "fraudScore" in item


# ── documents_handler ownership tests ─────────────────────────────────
sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "backend", "lambda", "documents"),
)
documents_handler = importlib.import_module("documents_handler")


class FakeS3:
    """Minimal S3 stub: records put_object calls and returns no objects on list."""

    def __init__(self):
        self.put_calls = []

    def list_objects_v2(self, **kwargs):
        return {}  # no documents; ownership is what we're testing, not listing

    def put_object(self, **kwargs):
        self.put_calls.append(kwargs)


def _install_documents_fakes(items):
    documents_handler.table = FakeTable(items)
    fake_s3 = FakeS3()
    documents_handler.s3 = fake_s3
    return fake_s3


def test_claimant_cannot_list_another_claimants_documents():
    _install_documents_fakes([ALICE_CLAIM, CAROL_CLAIM])
    resp = documents_handler.list_documents(_event("alice", "Claimants", "CLM-BBBB-CAROL"))
    assert resp["statusCode"] == 404, "Non-owner Claimant must not list another's documents"


def test_claimant_can_list_own_documents():
    _install_documents_fakes([ALICE_CLAIM, CAROL_CLAIM])
    resp = documents_handler.list_documents(_event("alice", "Claimants", "CLM-AAAA-ALICE"))
    assert resp["statusCode"] == 200


def test_adjuster_can_list_any_documents():
    _install_documents_fakes([ALICE_CLAIM, CAROL_CLAIM])
    resp = documents_handler.list_documents(_event("adj1", "Adjusters", "CLM-BBBB-CAROL"))
    assert resp["statusCode"] == 200


def test_claimant_cannot_upload_to_another_claimants_claim():
    fake_s3 = _install_documents_fakes([ALICE_CLAIM, CAROL_CLAIM])
    evt = _event("alice", "Claimants", "CLM-BBBB-CAROL")
    evt["body"] = json.dumps({"fileName": "x.txt", "fileContent": "aGVsbG8=", "documentType": "other"})
    resp = documents_handler.upload_documents(evt)
    assert resp["statusCode"] == 404, "Non-owner Claimant must not upload to another's claim"
    assert fake_s3.put_calls == [], "No object should be written to S3 for a denied upload"


def test_claimant_can_upload_to_own_claim():
    fake_s3 = _install_documents_fakes([ALICE_CLAIM, CAROL_CLAIM])
    evt = _event("alice", "Claimants", "CLM-AAAA-ALICE")
    evt["body"] = json.dumps({"fileName": "x.txt", "fileContent": "aGVsbG8=", "documentType": "other"})
    resp = documents_handler.upload_documents(evt)
    assert resp["statusCode"] == 201
    assert len(fake_s3.put_calls) == 1


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    sys.exit(1 if failures else 0)
