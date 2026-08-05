# Requirements Traceability

| Graduation project requirement | V3 capability | Executable evidence |
| --- | --- | --- |
| project access and requirement definition | Project plus immutable Brief revisions | API integration journey |
| AI-assisted planning | two-level DAG plus Context Pack | DAG unit tests and Workflow UI |
| controlled execution | Execution pinning and Broker Job Spec | Broker integration and security tests |
| human-machine collaboration | immutable Review plus separate decision | review/delivery integration test |
| source change inspection | managed Git Diff endpoint | project diff API and Execution page |
| result management | CAS Asset Versions and Evidence Links | asset API and hash tests |
| delivery | reviewed GitHub Draft PR record and separate merge gate | delivery integration test |
| traceability | SSE execution events and Audit Events | SSE and audit API |
| local security | loopback bind, internal Broker, isolated Runner | Compose security gate |

New features must add a row here, map to the core journey, and add executable acceptance evidence before entering the main branch.
