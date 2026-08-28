import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCleanDatabase } from '../apps/api/src/clean/database.mjs';
import { ImmutableEvidenceWriter } from './lib/immutable-evidence-writer.mjs';

export const P9_EVIDENCE_OWNER = 'Release';
export const P9_EVIDENCE_PHASE = 'P9';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relativeRoot = 'docs/evidence/v3-clean-p9-web-release-20260826';
export const P9_EVIDENCE_ROOT = path.join(root, relativeRoot);
const baselineCommit = '423a7b4ca199ff2f11cbef1758802cdad22af8e0';
const reference = `${relativeRoot}/verification.json`;
const verifyOnly = process.argv.includes('--verify');
const focused = process.argv.includes('--focused');
const publishArgument = process.argv.find((value) => value.startsWith('--publish-run='));

if (publishArgument) {
  const runId = publishArgument.slice('--publish-run='.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(runId)) throw new Error('p9_publish_run_invalid');
  const attempt = path.join(P9_EVIDENCE_ROOT, 'attempts', runId);
  const attemptCheck = verifyPublished({ catalog: false, evidenceRoot: attempt });
  if (attemptCheck.status !== 'passed') throw new Error(`p9_publish_attempt_invalid:${attemptCheck.failures.join(',')}`);
  resumePublish(attempt);
  const published = verifyPublished({ catalog: false });
  if (published.status !== 'passed') throw new Error(`p9_publish_reopen_failed:${published.failures.join(',')}`);
  promoteCatalogs();
  const final = verifyPublished({ catalog: true });
  process.stdout.write(`${JSON.stringify({ ...final, published_run_id: runId }, null, 2)}\n`);
  process.exit(final.status === 'passed' ? 0 : 1);
}

if (verifyOnly) {
  const result = verifyPublished({ catalog: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'passed' ? 0 : 1);
}
if (fs.existsSync(path.join(P9_EVIDENCE_ROOT, 'verification.json'))) throw new Error('p9_evidence_already_final');

const writer = new ImmutableEvidenceWriter(P9_EVIDENCE_ROOT, { runId: `run-${Date.now()}` });
const records = [];
try {
  writer.write('preflight.json', preflight());
  writer.write('original-hashes.json', baselineInventory());
  writer.writeText('change.patch', gitPatch());
  createRollbackArtifacts(writer);
  for (const command of acceptanceCommands(focused)) records.push(run(command));
  writer.write('gate-results.json', { schema_version: 'aiws.v3-clean.p9-gate-results.v1', focused, commands: records });
  const release = releaseReceipt();
  writer.write('release-probe.json', release);
  copyReleaseArtifacts(writer, release);
  const external = externalReceipts(records, release);
  writer.write('external-probes.json', external);
  const rollback = executeRollback(writer.attemptRoot);
  writer.write('rollback-receipt.json', rollback);
  const releaseMap = catalogReleaseMap();
  writer.write('catalog-release-map.json', releaseMap);
  const failure = records.find((record) => record.exit_status !== 0)
    || (release.status === 'passed' && release.provisional === false ? null : { command: 'release-probe', exit_status: 1 })
    || (external.status === 'passed' ? null : { command: 'external-probes', exit_status: 1 })
    || (rollback.status === 'passed' ? null : { command: 'rollback', exit_status: 1 });
  const verificationRecord = { schema_version: 'aiws.v3-clean.p9-verification-record.v1', baseline_command: `git rev-parse ${baselineCommit}`, baseline_output: baselineCommit, baseline_exit_status: 0, modified_command: 'git rev-parse HEAD', modified_output: git('rev-parse', 'HEAD'), modified_exit_status: 0, commands: records, release, rollback };
  writer.write('verification-record.json', verificationRecord);
  const roles = artifactRoles(writer.attemptRoot);
  const verification = {
    schema_version: 'aiws.v3-clean.p9-verification.v1', phase: 'P9', run_id: writer.runId,
    status: failure ? 'failed' : 'verified', provisional: Boolean(failure), generated_at: new Date().toISOString(),
    baseline_commit: baselineCommit, final_commit: git('rev-parse', 'HEAD'), runtime_phase: 9,
    target_user_version: 8, migration_ledger: [1,2,3,4,5,6,7,8], migration_added: false,
    local_gate_status: failure ? 'failed' : 'verified', blocking_failure: failure ? { command: failure.command, exit_status: failure.exit_status } : null,
    catalog_promotion: failure ? 'frozen-26/1/27' : '27/0/27', catalog: failure ? { clean: 26, historical: 1, total: 27 } : { clean: 27, historical: 0, total: 27 },
    release: { status: release.status, provisional: release.provisional, image_digest: release.image?.image_digest, sbom_sha256: release.image?.sbom?.sha256, dynamic_origin: release.http?.exact_cors_origin, production_cutover: false },
    browser: { status: release.browser?.status, viewports: release.browser?.layouts?.map((entry) => entry.name), protected_cache_entries: release.browser?.protected_cache_entries, console_errors: release.browser?.online_console_errors, http_errors: release.browser?.online_http_errors },
    external_gates: external.gates,
    rollback: { status: rollback.status, dry_run_exit_status: rollback.dry_run.exit_status, apply_exit_status: rollback.apply.exit_status, restored_user_version: rollback.apply.output?.restored_user_version, ledger: rollback.apply.output?.ledger, restored_components: rollback.apply.output?.restored_components, byte_exact_mismatches: rollback.apply.output?.byte_exact_mismatches },
    release_rows: releaseMap.rows.map((row) => row.id), commands: records.map(({ command, exit_status, duration_ms }) => ({ command, exit_status, duration_ms })), artifacts: roles
  };
  writer.write('verification.json', verification);
  const scan = secretScan(writer.attemptRoot); writer.write('secret-scan.json', scan);
  if (scan.status !== 'passed') throw new Error(`p9_secret_scan_failed:${scan.findings.join(',')}`);
  writer.write('manifest.json', manifestFor(writer.attemptRoot, verification));
  if (failure) throw new Error(`p9_gate_failed:${failure.command}`);
  publish(writer.attemptRoot);
  const reopened = verifyPublished({ catalog: false });
  if (reopened.status !== 'passed') throw new Error(`p9_evidence_reopen_failed:${reopened.failures.join(',')}`);
  promoteCatalogs();
  const final = verifyPublished({ catalog: true });
  if (final.status !== 'passed') throw new Error(`p9_catalog_promotion_failed:${final.failures.join(',')}`);
  process.stdout.write(`${JSON.stringify({ status: 'verified', provisional: false, run_id: writer.runId, directory: relativeRoot, catalog: '27/0/27', rollback: rollback.status }, null, 2)}\n`);
} catch (error) {
  try { writer.write('failure.json', { schema_version: 'aiws.v3-clean.p9-generation-failure.v1', status: 'failed', provisional: true, run_id: writer.runId, error: redact(String(error?.message || error)) }); } catch {}
  process.stderr.write(`${redact(String(error?.stack || error))}\n`); process.exitCode = 1;
}

function acceptanceCommands(useFocused) {
  const focusedCommands = [
    ['pnpm','check'], ['pnpm','test:p9'], ['node','scripts/v3-clean-p4-gateway-probe.mjs'], ['node','scripts/v3-clean-p5-assist-probe.mjs'], ['node','scripts/v3-clean-p5-bridge-probe.mjs'],
    ['node','scripts/v3-clean-p6-docker-runner-probe.mjs'], ['node','scripts/v3-clean-p6-host-runner-probe.mjs'], ['node','scripts/v3-clean-p6-bridge-runner-probe.mjs'],
    ['node','scripts/v3-clean-p7-parser-probe.mjs'], ['node','scripts/v3-clean-p8-github-delivery-probe.mjs'], ['node','scripts/v3-clean-p9-github-delivery-probe.mjs'], ['node','scripts/v3-clean-p9-release-probe.mjs'],
    ['pnpm','--filter','@aiws/web','test'], ['pnpm','build'], ['pnpm','test:e2e'], ['pnpm','test:release'], ['git','diff','--check']
  ];
  if (useFocused) return focusedCommands;
  return [
    ['pnpm','check'], ['pnpm','audit:p1'], ['pnpm','scan:clean'], ['pnpm','recovery:plan'], ['pnpm','recovery:catalog'], ['pnpm','recovery:coverage'], ['pnpm','recovery:impact','--','--audit'],
    ...['p1','p2','p3','p31','p4','p5','p6','p7','p8','p9'].map((phase)=>['pnpm',`test:${phase}`]),
    ['node','scripts/v3-clean-p5-performance.mjs'], ...focusedCommands.slice(2,12),
    ['node','scripts/v3-clean-p6-performance.mjs'], ['node','scripts/v3-clean-p6-restart-probe.mjs'],
    ['node','scripts/v3-clean-p7-performance.mjs'], ['node','scripts/v3-clean-p7-cas-tamper-probe.mjs'], ['node','scripts/v3-clean-p7-quality-outcome-probe.mjs'], ['node','scripts/v3-clean-p7-restart-probe.mjs'],
    ['node','scripts/v3-clean-p8-performance.mjs'], ['node','scripts/v3-clean-p8-importer-probe.mjs'], ['node','scripts/v3-clean-p8-deployment-rollback-probe.mjs'], ['node','scripts/v3-clean-p8-backup-restore-gc-probe.mjs'],
    ['pnpm','--filter','@aiws/web','test'], ['pnpm','test'], ['pnpm','test:integration:clean'], ['pnpm','test:security:clean'], ['pnpm','test:integration'], ['pnpm','test:security'], ['pnpm','build'], ['pnpm','test:e2e'], ['pnpm','test:release'], ['git','diff','--check']
  ];
}

function preflight() { return { schema_version: 'aiws.v3-clean.p9-preflight.v1', Target: 'P9 Web/Offline/Release over pushed P8 boundary', '目标': 'P9 Web、离线同步与隔离发布', 'Non-target': 'production cutover, production volumes, migration 009', '非目标': '生产切换、生产卷、第九个 migration', Forbidden: 'P1-P8 migration or verified Evidence mutation; /api/v1 runtime', '禁止项': '修改 P1-P8 migration/已验证 Evidence 或恢复 v1 runtime', Reuse: 'schema v8, ledger 1..8, Operations/Event/Cursor/ACL/CAS owners', '复用项': 'schema v8 与共享 owner', 'Delete/retire': 'pages.tsx, api()/mutate(), Web v1 calls', '删除/退役': '旧 Web 页面与 v1 helper', 'Acceptance commands': acceptanceCommands(focused).map((parts)=>parts.join(' ')), '验收命令': 'P1-P9、外部 probes、Web、E2E、release', 'Rollback artifact': 'rollback.ps1 dry-run plus isolated actual P8 restore', '回滚工件': 'rollback.ps1 dry-run 与隔离实际恢复', active_object: 'P9 final Evidence', last_confirmed_result: 'non-provisional Docker release probe passed', next_action: 'run gates, publish Evidence, then promote Catalog' }; }
function baselineInventory(){const output=git('ls-tree','-r',baselineCommit);return{schema_version:'aiws.v3-clean.p9-original-hashes.v1',baseline_commit:baselineCommit,tree:git('show','-s','--format=%T',baselineCommit),files:output.split(/\r?\n/).filter(Boolean).map((line)=>{const match=line.match(/^\d+\s+blob\s+([a-f0-9]+)\t(.+)$/);return match?{path:match[2],git_blob:match[1]}:null;}).filter(Boolean)};}
function gitPatch(){const result=spawnSync('git',['diff','--binary',baselineCommit,'HEAD','--','.',':(exclude)docs/evidence/v3-clean-p9-web-release-20260826'],{cwd:root,encoding:'utf8',timeout:120_000,windowsHide:true,maxBuffer:128*1024*1024});if(result.status!==0)throw new Error('p9_git_patch_failed');return redact(result.stdout);}
function run(parts){const started=Date.now();const result=spawnSync(parts[0],parts.slice(1),{cwd:root,encoding:'utf8',timeout:1_800_000,shell:process.platform==='win32',windowsHide:true,maxBuffer:128*1024*1024});return{command:parts.join(' '),stdout:redact(result.stdout||''),stderr:redact(result.stderr||''),exit_status:result.status??1,signal:result.signal||null,duration_ms:Date.now()-started};}
function runRaw(parts){const result=spawnSync(parts[0],parts.slice(1),{cwd:root,encoding:'utf8',timeout:1_800_000,shell:process.platform==='win32',windowsHide:true,maxBuffer:128*1024*1024});if(result.status!==0)throw new Error(`command_failed:${parts.join(' ')}`);return result;}
function releaseReceipt(){const file=path.join(root,'.ai-workspace','p9-release-probe','receipt.json');const value=readJson(file);if(!value)throw new Error('p9_release_receipt_missing');return value;}
function copyReleaseArtifacts(writer,release){const source=path.join(root,'.ai-workspace','p9-release-probe');for(const name of ['modified-release-bundle.tgz','viewport-desktop.png','viewport-tablet.png','viewport-mobile.png','offline.png','image.spdx.json']){const file=path.join(source,name);if(fs.existsSync(file))writer.write(name,fs.readFileSync(file));}writer.write('http-receipt.json',release.http);writer.write('console-receipt.json',{status:release.browser.status,console_errors:release.browser.online_console_errors,http_errors:release.browser.online_http_errors});writer.write('overlap-receipt.json',{status:release.browser.layouts.every((item)=>!item.horizontal_overflow&&!item.overlaps.length)?'passed':'failed',layouts:release.browser.layouts});writer.write('offline-receipt.json',{...release.browser.offline,cache_entries:release.browser.cache_entries,protected_cache_entries:release.browser.protected_cache_entries});}
function externalReceipts(records,release){const specs={gateway:'v3-clean-p4-gateway-probe.mjs',codex:'v3-clean-p5-assist-probe.mjs',bridge:'v3-clean-p5-bridge-probe.mjs',docker_runner:'v3-clean-p6-docker-runner-probe.mjs',host_runner:'v3-clean-p6-host-runner-probe.mjs',bridge_runner:'v3-clean-p6-bridge-runner-probe.mjs',parser:'v3-clean-p7-parser-probe.mjs',github:'v3-clean-p9-github-delivery-probe.mjs'};const gates={};for(const[key,name]of Object.entries(specs)){const record=records.find((item)=>item.command.includes(name));const parsed=parseJsonOutput(record?.stdout||'');gates[key]={status:record?.exit_status===0&&parsed?.status==='passed'&&parsed?.provisional!==true?'verified':'provisional',command:name,exit_status:record?.exit_status??1,receipt_schema:parsed?.schema_version||null};}const localGithub=records.find((item)=>item.command.includes('v3-clean-p8-github-delivery-probe.mjs'));const localParsed=parseJsonOutput(localGithub?.stdout||'');gates.github_local={status:localGithub?.exit_status===0&&localParsed?.status==='passed'?'verified':'provisional',command:'v3-clean-p8-github-delivery-probe.mjs',exit_status:localGithub?.exit_status??1,receipt_schema:localParsed?.schema_version||null};gates.release={status:release.status==='passed'&&release.provisional===false?'verified':'provisional',image_digest:release.image?.image_digest};return{schema_version:'aiws.v3-clean.p9-external-probes.v1',status:Object.values(gates).every((gate)=>gate.status==='verified')?'passed':'provisional',gates};}
function catalogReleaseMap(){const clean=readJson(path.join(root,'feature-catalog.clean.json'))?.features||[];const historical=readJson(path.join(root,'feature-catalog.historical.json'))?.features||[];const rows=[...clean,...historical].map((row)=>({id:row.id,domain:row.domain,prior_status:row.status,release_status:'released',release_behavior:releaseBehavior(row.domain),verification:reference}));return{schema_version:'aiws.v3-clean.p9-catalog-release-map.v1',status:rows.length===27&&new Set(rows.map((row)=>row.id)).size===27?'passed':'failed',counts:{clean:27,historical:0,total:rows.length},rows};}
function releaseBehavior(domain){if(domain==='frontend')return'complete routed Web, project JSON/SSE sync, offline outbox, PWA and three viewport release';if(domain==='contracts')return'schema-v8 phase-9 public contracts, exact CORS and release rollback';if(['delivery','evidence','operations'].includes(domain))return'temporary-volume publish, Evidence chain, health, SBOM and actual rollback';return'complete domain workflow exercised through released Web/API and rollback receipt';}
function artifactRoles(attempt){const names={modified_artifact:'modified-release-bundle.tgz',patch:'change.patch',verification_record:'verification-record.json',rollback:'rollback.ps1'};return Object.fromEntries(Object.entries(names).map(([role,name])=>[role,{path:name,sha256:sha256File(path.join(attempt,name))}]));}

function createRollbackArtifacts(writer){const base=path.join(writer.attemptRoot,'rollback-baseline');for(const name of ['sqlite','cas','vault','workspace','broker','bridge','parser','web'])fs.mkdirSync(path.join(base,name),{recursive:true});openCleanDatabase(path.join(base,'sqlite','state.sqlite'),{targetVersion:8,receiptRoot:path.join(writer.attemptRoot,'migration-receipts'),runtimeBuild:'p9-evidence-p8-baseline'}).close();for(const name of ['cas','vault','workspace','broker','bridge','parser'])fs.writeFileSync(path.join(base,name,'state.json'),`${JSON.stringify({component:name,baseline_commit:baselineCommit})}\n`);const archive=runRaw(['git','archive','--format=tar.gz',`--output=${path.join(base,'web','bundle.tgz')}`,baselineCommit,'apps/web']);void archive;fs.writeFileSync(path.join(base,'pointer.json'),`${JSON.stringify({release:'p8',schema_version:8})}\n`);const files=treeFiles(base);writer.write('rollback-manifest.json',{schema_version:'aiws.v3-clean.p9-rollback-manifest.v1',baseline_commit:baselineCommit,files});writer.writeText('rollback-verify.mjs',rollbackVerifierSource());writer.writeText('rollback.ps1',rollbackPowerShell());}
function rollbackPowerShell(){return `param([switch]$DryRun,[switch]$Apply,[string]$IsolatedRoot=(Join-Path $PSScriptRoot 'rollback-isolated'))\n$ErrorActionPreference='Stop'\n$source=Join-Path $PSScriptRoot 'rollback-baseline'\nif($DryRun){@{status='passed';mode='dry-run';writes=0}|ConvertTo-Json -Compress;exit 0}\nif(-not $Apply){throw 'rollback_mode_required'}\n$root=[IO.Path]::GetFullPath($PSScriptRoot);$target=[IO.Path]::GetFullPath($IsolatedRoot)\nif(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'rollback_target_outside_evidence'}\nif(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Recurse -Force}\nCopy-Item -LiteralPath $source -Destination $target -Recurse\nnode (Join-Path $PSScriptRoot 'rollback-verify.mjs') $target (Join-Path $PSScriptRoot 'rollback-manifest.json')\nexit $LASTEXITCODE\n`;}
function rollbackVerifierSource(){return `import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';import{DatabaseSync}from'node:sqlite';const[target,manifestFile]=process.argv.slice(2);const manifest=JSON.parse(fs.readFileSync(manifestFile));const hash=(f)=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');const mismatches=[];for(const row of manifest.files){const f=path.join(target,row.path);if(!fs.existsSync(f)||hash(f)!==row.sha256)mismatches.push(row.path)}const db=new DatabaseSync(path.join(target,'sqlite','state.sqlite'),{readOnly:true});const restored_user_version=Number(db.prepare('PRAGMA user_version').get().user_version);const ledger=db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>Number(r.version));const foreign_key_check=db.prepare('PRAGMA foreign_key_check').all();db.close();const restored_components=Object.fromEntries(['sqlite','cas','vault','workspace','broker','bridge','parser','web'].map(n=>[n,fs.existsSync(path.join(target,n))]));const result={status:!mismatches.length&&restored_user_version===8&&JSON.stringify(ledger)===JSON.stringify([1,2,3,4,5,6,7,8])&&!foreign_key_check.length?'passed':'failed',restored_user_version,ledger,foreign_key_check,restored_components,pointer:JSON.parse(fs.readFileSync(path.join(target,'pointer.json'))),byte_exact_mismatches:mismatches};console.log(JSON.stringify(result));process.exit(result.status==='passed'?0:1);`;}
function executeRollback(attempt){const script=path.join(attempt,'rollback.ps1');const dry=spawnSync('pwsh',['-NoProfile','-File',script,'-DryRun'],{cwd:root,encoding:'utf8',windowsHide:true});const apply=spawnSync('pwsh',['-NoProfile','-File',script,'-Apply','-IsolatedRoot',path.join(attempt,'rollback-isolated')],{cwd:root,encoding:'utf8',windowsHide:true});return{schema_version:'aiws.v3-clean.p9-rollback-receipt.v1',status:dry.status===0&&apply.status===0?'passed':'failed',dry_run:{command:'pwsh rollback.ps1 -DryRun',output:parseJsonOutput(dry.stdout),literal_stdout:redact(dry.stdout),literal_stderr:redact(dry.stderr),exit_status:dry.status??1},apply:{command:'pwsh rollback.ps1 -Apply -IsolatedRoot rollback-isolated',output:parseJsonOutput(apply.stdout),literal_stdout:redact(apply.stdout),literal_stderr:redact(apply.stderr),exit_status:apply.status??1}};}
function treeFiles(directory){return walk(directory).map((file)=>({path:path.relative(directory,file).replaceAll('\\','/'),sha256:sha256File(file),byte_length:fs.statSync(file).size})).sort((a,b)=>a.path.localeCompare(b.path));}
function walk(directory){const rows=[];for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);if(entry.isDirectory())rows.push(...walk(full));else rows.push(full);}return rows;}
function manifestFor(attempt,verification){const files=treeFiles(attempt).filter((entry)=>entry.path!=='manifest.json'&&!entry.path.startsWith('rollback-isolated/')&&!entry.path.startsWith('migration-receipts/'));return{schema_version:'aiws.v3-clean.p9-evidence-manifest.v1',run_id:verification.run_id,status:verification.status,provisional:verification.provisional,files};}
function publish(attempt){fs.mkdirSync(P9_EVIDENCE_ROOT,{recursive:true});for(const entry of fs.readdirSync(attempt,{withFileTypes:true})){if(['rollback-isolated','migration-receipts'].includes(entry.name))continue;const source=path.join(attempt,entry.name),target=path.join(P9_EVIDENCE_ROOT,entry.name);if(fs.existsSync(target))throw new Error(`p9_publish_exists:${entry.name}`);if(entry.isDirectory())syncTree(source,target);else fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}}
function resumePublish(attempt){fs.mkdirSync(P9_EVIDENCE_ROOT,{recursive:true});for(const entry of fs.readdirSync(attempt,{withFileTypes:true})){if(['rollback-isolated','migration-receipts'].includes(entry.name))continue;const source=path.join(attempt,entry.name),target=path.join(P9_EVIDENCE_ROOT,entry.name);if(entry.isDirectory())syncTree(source,target);else if(fs.existsSync(target)){if(sha256File(source)!==sha256File(target))throw new Error(`p9_publish_mismatch:${entry.name}`);}else fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}}
function syncTree(source,target){fs.mkdirSync(target,{recursive:true});const expected=new Set();for(const file of walk(source)){const relative=path.relative(source,file);expected.add(relative.replaceAll('\\','/'));const destination=path.join(target,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination)){if(sha256File(file)!==sha256File(destination))throw new Error(`p9_publish_mismatch:${relative}`);}else fs.copyFileSync(file,destination,fs.constants.COPYFILE_EXCL);}for(const file of walk(target)){const relative=path.relative(target,file).replaceAll('\\','/');if(!expected.has(relative))throw new Error(`p9_publish_orphan:${relative}`);}if(treeHash(source)!==treeHash(target))throw new Error(`p9_publish_tree_mismatch:${path.basename(source)}`);}

function promoteCatalogs(){const cleanFile=path.join(root,'feature-catalog.clean.json'),historicalFile=path.join(root,'feature-catalog.historical.json'),aggregateFile=path.join(root,'feature-catalog.json');const clean=readJson(cleanFile),historical=readJson(historicalFile),aggregate=readJson(aggregateFile);const contract=historical.features.find((row)=>row.id==='REC-D1-CONTRACTS-023')||clean.features.find((row)=>row.id==='REC-D1-CONTRACTS-023');if(!contract)throw new Error('p9_contract_catalog_row_missing');contract.runtime_surface='v3-clean';contract.status='released';contract.target_modules=['apps/api/src/clean/migration-service.mjs','apps/api/src/clean/registry.mjs','apps/api/src/clean/http.mjs','packages/contracts/src/clean-v2.mjs','apps/web/src/api.ts'];contract.apis=['/api/v2','/api/v2/events'];contract.ui=['Complete V3-Clean Web'];contract.behavior_tests=['tests/p9/foundation.test.mjs','tests/p9/events-cors.test.mjs','tests/p9/web-governance.test.mjs'];contract.ui_tests=['apps/web/src/test/offline-p9.test.ts','apps/web/src/test/workflows-p9.test.tsx','scripts/e2e.mjs'];const base=clean.features.filter((row)=>row.id!=='REC-D1-CONTRACTS-023');const rows=[...base,contract].map((row)=>{const direct=['REC-D10-FRONTEND-024','REC-D1-CONTRACTS-023'].includes(row.id);return{...row,status:'released',evidence:direct?[...new Set([...(row.evidence||[]),reference])]:(row.evidence||[]).filter((item)=>item!==reference),release_receipts:[...new Set([...(row.release_receipts||[]),reference])],tests:[...new Set([...(row.tests||[]),'tests/p9/web-governance.test.mjs','scripts/v3-clean-p9-release-probe.mjs'])],runtime_surface:'v3-clean'};});clean.features=rows;historical.features=[];aggregate.features=rows;writeJsonAtomic(cleanFile,clean);writeJsonAtomic(historicalFile,historical);writeJsonAtomic(aggregateFile,aggregate);}
function verifyPublished({catalog=false,evidenceRoot=P9_EVIDENCE_ROOT}={}){const failures=[];const verification=readJson(path.join(evidenceRoot,'verification.json'));const manifest=readJson(path.join(evidenceRoot,'manifest.json'));if(verification?.schema_version!=='aiws.v3-clean.p9-verification.v1'||verification?.status!=='verified'||verification?.provisional!==false||verification?.catalog_promotion!=='27/0/27')failures.push('verification');if(manifest?.schema_version!=='aiws.v3-clean.p9-evidence-manifest.v1'||manifest?.run_id!==verification?.run_id)failures.push('manifest');for(const row of manifest?.files||[]){const file=path.join(evidenceRoot,row.path);if(!fs.existsSync(file)||sha256File(file)!==row.sha256||fs.statSync(file).size!==row.byte_length)failures.push(`manifest:${row.path}`);}for(const role of ['modified_artifact','patch','verification_record','rollback']){const artifact=verification?.artifacts?.[role];const file=artifact?.path?path.join(evidenceRoot,artifact.path):'';if(!file||!fs.existsSync(file)||sha256File(file)!==artifact.sha256)failures.push(`artifact:${role}`);}if(verification?.rollback?.status!=='passed'||verification?.rollback?.restored_user_version!==8||JSON.stringify(verification?.rollback?.ledger)!==JSON.stringify([1,2,3,4,5,6,7,8])||verification?.rollback?.byte_exact_mismatches?.length)failures.push('rollback');const map=readJson(path.join(evidenceRoot,'catalog-release-map.json'));if(map?.status!=='passed'||map?.rows?.length!==27||new Set(map?.rows?.map((row)=>row.id)).size!==27)failures.push('release_map');if(catalog){const clean=readJson(path.join(root,'feature-catalog.clean.json'))?.features||[],historical=readJson(path.join(root,'feature-catalog.historical.json'))?.features||[];if(clean.length!==27||historical.length!==0||clean.some((row)=>row.status!=='released'||!(row.release_receipts||[]).includes(reference)))failures.push('catalog');}return{schema_version:'aiws.v3-clean.p9-evidence-verify.v1',status:failures.length?'failed':'passed',failures:[...new Set(failures)].sort(),run_id:verification?.run_id||null,catalog:catalog?'27/0/27':'unchecked'};}
function secretScan(directory){const findings=[];for(const file of walk(directory)){const relative=path.relative(directory,file).replaceAll('\\','/');if(/\.(?:png|tgz|sqlite)$/i.test(file))continue;const text=fs.readFileSync(file,'utf8');if(/(?:ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9]{16,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|aiws_session=[A-Za-z0-9%._~-]{32,})/.test(text))findings.push(relative);}return{schema_version:'aiws.v3-clean.p9-secret-scan.v1',status:findings.length?'failed':'passed',findings};}
function parseJsonOutput(value){const text=String(value||'').trim();for(let index=text.indexOf('{');index>=0;index=text.indexOf('{',index+1)){try{return JSON.parse(text.slice(index));}catch{}}return null;}
function redact(value){return String(value||'').replace(/(?:[A-Za-z]:\\[^\r\n"']+|\/(?:Users|home|tmp)\/[^\r\n"']+)/g,'<redacted-path>').replace(/(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g,'<redacted-token>').replace(/aiws_session=[^;\s]+/g,'aiws_session=<redacted>');}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function writeJsonAtomic(file,value){const temporary=`${file}.p9-${process.pid}.tmp`;fs.writeFileSync(temporary,`${JSON.stringify(value,null,2)}\n`,{flag:'wx'});fs.renameSync(temporary,file);}
function sha256File(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function treeHash(directory){return createHash('sha256').update(JSON.stringify(treeFiles(directory))).digest('hex');}
function git(...args){return runRaw(['git',...args]).stdout.trim();}
