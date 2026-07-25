import { createJourneyRuntime } from './v175-user-journey-runtime.mjs';
import { completeSetup } from './v175-user-journey-setup.mjs';
import { createAndActivateProject } from './v175-user-journey-project.mjs';
import { governWorkflowAndContract } from './v175-user-journey-governance.mjs';
import { saveAllNodeWorkspaces } from './v175-user-journey-workspaces.mjs';
import { exerciseAssistLifecycle } from './v175-user-journey-assist.mjs';
import { runDeliveryAndInspect } from './v175-user-journey-delivery.mjs';
import { verifyBrowserAndServiceRecovery } from './v175-user-journey-recovery.mjs';

const runtime = await createJourneyRuntime();
let failure = null,
  fixture,
  nodes,
  assist,
  delivery;
try {
  await runtime.start();
  await runtime.step('空环境完成 Setup 与运行探针', () => completeSetup(runtime));
  fixture = await runtime.step('创建并激活五节点项目', () => createAndActivateProject(runtime));
  await runtime.step('工作流与 Contract 提案治理', () => governWorkflowAndContract(runtime, fixture));
  assist = await runtime.step('Assist 附件、Turn、Plan、停止、重试与 Steer', () =>
    exerciseAssistLifecycle(runtime, fixture)
  );
  nodes = await runtime.step('五类节点工作区保存与执行', () => saveAllNodeWorkspaces(runtime, fixture));
  delivery = await runtime.step('NodeRun、Git、资产、审计与设置', () => runDeliveryAndInspect(runtime, fixture, nodes));
  await runtime.step('新浏览器与服务重启双重恢复', () =>
    verifyBrowserAndServiceRecovery(runtime, fixture, nodes, assist, delivery)
  );
} catch (error) {
  failure = error;
} finally {
  failure = await runtime.finish(failure);
}
if (failure) throw failure;
