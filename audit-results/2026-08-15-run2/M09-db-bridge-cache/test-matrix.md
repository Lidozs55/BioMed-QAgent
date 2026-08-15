# M09 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Python 3.13 / uv 0.9.16

| Case | 结果 | 证据 |
| --- | --- | --- |
| M09-T01 | PASS | `db-bridge.test.ts`、Python `test_bridge.py` |
| M09-T02 | PASS | Python `test_bridge.py` |
| M09-T03 | PASS | `db-bridge.test.ts`（restart after crash） |
| M09-T04 | PASS | Python `test_database_store.py`（含 forbidden-import）、`test_declarative.py` |
| M09-T05 | PASS | Python `test_cache_store.py` |
| M09-T06 | PASS | Python `test_cache_store.py`（.tmp/.bak 恢复） |
| M09-T07 | PASS | `declarative-db.test.ts`、Python `test_declarative.py` |
| M09-T08 | PASS | Python `test_cache_store.py` |
| M09-T09 | PASS | PRE-02：self-test OK、pytest 79、ruff 通过 |
