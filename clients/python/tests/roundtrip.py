"""Run by the Node fixture orchestrator against the actual compiled server."""
import json
import os
import ssl
import sys
from pathlib import Path

from hunch_state import StateClient, StateClientError

fixture = json.loads(Path(sys.argv[1]).read_text())
scope = fixture["scope"]
client = StateClient(fixture["url"], os.environ["HUNCH_PYTHON_TEST_TOKEN"])
guest = StateClient(fixture["url"], os.environ["HUNCH_PYTHON_TEST_GUEST"])
request = fixture["write"]
output = {"health": client.health(), "capabilities": client.capabilities(scope)}
output["write"] = client.write(request)
record_id = output["write"]["record_id"]
assert output["write"]["outcome"] == "created"
assert client.write(request)["outcome"] == "replayed"
output["read"] = client.read({"scope": scope, "subject": request["record"]["subject"]})
assert output["read"]["records"][record_id]["content"] == request["record"]["content"]
output["records"] = client.records({"scope": scope, "ids": [record_id]})
assert output["records"]["records"][record_id]["content"] == request["record"]["content"]
output["subscribe"] = client.subscribe({"scope": scope, "after_seq": 0})
assert output["subscribe"]["events"][0]["record_id"] == record_id
assert output["subscribe"]["resync"] is False
assert client.subscribe({"scope": scope, "after_seq": output["subscribe"]["head_seq"]})["events"] == []
assert guest.records({"scope": scope, "ids": [record_id]})["missing"] == [record_id]
assert record_id not in guest.read({"scope": scope, "subject": request["record"]["subject"]}).get("records", {})
assert guest.subscribe({"scope": scope, "after_seq": 0})["events"] == []
for work, code in [
    (lambda: client.read({"scope": {"kind": "organization", "id": "outside"}}), "outside-grants"),
    (lambda: client.write({**request, "record": {**request["record"], "transform_version": "different"}}), "idempotency"),
    (lambda: StateClient(fixture["url"], "wrong").capabilities(), "unauthorized"),
]:
    try:
        work()
        raise AssertionError("refusal expected")
    except StateClientError as error:
        assert error.code == code, str(error)
        assert error.status >= 400
output["capture"] = client.capture(fixture["capture"])
assert output["capture"]["outcome"] == "created"
output["batch"] = client.capture_batch(fixture["batch"])
assert output["batch"]["results"][0]["status"] == "saved"
if "https_url" in fixture:
    from hunch_state.proof import create_proof_signer
    context = ssl.create_default_context(cafile=fixture["ca_file"])
    for key in [fixture["private_pem"], fixture["private_jwk"]]:
        bound = StateClient(fixture["https_url"], os.environ["HUNCH_PYTHON_TEST_BOUND"],
                            ssl_context=context, proof=create_proof_signer(key))
        assert bound.capabilities()["principal"]["id"] == "bound"
        assert bound.read({"scope": scope})["schema"] == "nuryel.state.read/1"
    try:
        create_proof_signer(json.dumps({**json.loads(fixture["private_jwk"]), "x": "wrong"}))
        raise AssertionError("mismatched key accepted")
    except ValueError:
        pass
print(json.dumps(output, ensure_ascii=False))
