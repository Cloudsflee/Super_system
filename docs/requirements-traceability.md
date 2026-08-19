# Requirements Traceability

本表是毕设需求的入口，不是 Catalog 状态表。每一行必须映射到
[`architecture/v23-capability-matrix.md`](architecture/v23-capability-matrix.md)
中的能力行；状态只能由行为测试、UI 测试、集成 probe 和 Evidence receipt
推导。

| Graduation project requirement | V3-Clean capability/matrix area | Executable evidence |
| --- | --- | --- |
| project access and requirement definition | Project, Team/Actor, ACL, Brief revisions (`C-01`-`C-05`) | API/domain flow, ACL isolation and Brief CAS receipt |
| AI-assisted planning | Workflow, Generation, Critic, Context Pack (`C-06`-`C-12`) | DAG behavior, proposal/critic UI and golden workflow |
| controlled execution | Runner, seven-stage Execution, checkpoints (`C-19`-`C-22`) | signed Job Spec, restart/replay and runner security receipt |
| human-machine collaboration | Assist, Approval, User Input, Terminal, Bridge (`C-13`-`C-18`) | event replay, UI/manual-input and Bridge probe |
| source change inspection | Repository Connection/Target/Line and managed Git Diff (`C-07`, `C-24`) | source drift, bundle and diff Evidence tests |
| result management | CAS Assets, Trace, Digest, Quality and Outcome (`C-24`-`C-26`) | CAS hash/tamper, parser, human score and waiver receipts |
| delivery | Draft PR, merge recovery, Deployment (`C-27`) | GitHub integration, health probe and deployment Evidence |
| traceability | generic Operations, Events, cursors and Audit (`C-01`, `C-27`) | SSE/JSON replay parity and audit redaction |
| local security | API boundary, Broker isolation, parser sandbox, Gateway scope (`C-01`, `C-23`-`C-27`) | architecture, security, parser and Gateway probes |

New features must add or update a matrix row, map to the core journey, and add
executable acceptance evidence before entering the release branch. A schema-only
row remains `scaffolded`; a historical Evidence file does not prove clean-runtime
behavior.
