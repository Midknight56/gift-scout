"""Load private replay fixtures into the Worker D1 database."""
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
TARGET_BYTES = 24_000


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def batches(statements: list[str]):
    batch: list[str] = []
    size = 0
    for statement in statements:
        if batch and size + len(statement) > TARGET_BYTES:
            yield "\n".join(batch) + "\n"
            batch, size = [], 0
        batch.append(statement)
        size += len(statement)
    if batch:
        yield "\n".join(batch) + "\n"


def validate_answers(answers: dict[str, object]) -> None:
    for key, answer in answers.items():
        if parse_qs(urlsplit(key).query).get("feature.explainability") != ["true"]:
            continue
        results = answer.get("results") if isinstance(answer, dict) else None
        entities = results.get("entities") if isinstance(results, dict) else None
        if not isinstance(entities, list):
            continue
        for entity in entities:
            query = entity.get("query") if isinstance(entity, dict) else None
            explainability = query.get("explainability") if isinstance(query, dict) else None
            if not isinstance(explainability, dict) or "signal.interests.entities" not in explainability:
                raise ValueError(f"Qloo answer for key {key!r} requested explainability but lost signal.interests.entities")


def self_test() -> None:
    good_key = "https://qloo.test/v2/insights?feature.explainability=true"
    bad_key = "https://qloo.test/v2/insights?feature.explainability=true&filter.type=urn%3Aentity%3Abrand"
    validate_answers({good_key: {"results": {"entities": [{"query": {"explainability": {"signal.interests.entities": []}}}]}}})
    try:
        validate_answers({bad_key: {"results": {"entities": [{"query": {"affinity": 0.8}}]}}})
    except ValueError as error:
        assert bad_key in str(error)
    else:
        raise AssertionError("missing explainability split was accepted")
    print("seed_replay self-test passed")


def execute(statements: list[str], mode: str) -> None:
    with tempfile.TemporaryDirectory(prefix="gift-scout-seed-") as folder:
        for index, sql in enumerate(batches(statements)):
            path = Path(folder) / f"batch-{index:04}.sql"
            path.write_text(sql, encoding="utf-8")
            subprocess.run(
                ["npx.cmd" if os.name == "nt" else "npx", "wrangler", "d1", "execute", "gift-scout", mode, "--file", str(path)],
                cwd=ROOT,
                check=True,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", action="store_true", help="seed the local D1 database instead of remote")
    parser.add_argument("--self-test", action="store_true", help="test explainability validation without loading fixtures")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    mode = "--local" if args.local else "--remote"

    answers = json.loads((ROOT / "private" / "qloo-answers.json").read_text(encoding="utf-8"))
    validate_answers(answers)
    runs = json.loads((ROOT / "private" / "recorded-runs.json").read_text(encoding="utf-8"))
    sample_sql = [
        "INSERT INTO qloo_samples (key, body) VALUES ("
        + sql_text(key) + ", " + sql_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
        + ") ON CONFLICT(key) DO UPDATE SET body = excluded.body;"
        for key, body in answers.items()
    ]
    run_sql = []
    for run in runs:
        said = run["states"][-1]["said"]
        if not said:
            raise ValueError("Recorded run has no example message")
        run_sql.append(
            "INSERT INTO recorded_runs (example, run) VALUES ("
            + sql_text(said[0]) + ", " + sql_text(json.dumps(run, ensure_ascii=False, separators=(",", ":")))
            + ") ON CONFLICT(example) DO UPDATE SET run = excluded.run;"
        )

    execute(sample_sql, mode)
    execute(run_sql, mode)
    print(f"qloo_samples: {len(sample_sql)} rows")
    print(f"recorded_runs: {len(run_sql)} rows")


if __name__ == "__main__":
    main()
