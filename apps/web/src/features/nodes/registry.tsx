import { BarChart3, BookOpenCheck, Crosshair, RefreshCw, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { lazy } from 'react';
import type { NodeKind, NodeWorkspace } from '../../api/types';

const GoalWorkspace = lazy(() => import('./renderers/GoalWorkspace').then((item) => ({ default: item.GoalWorkspace })));
const ResearchWorkspace = lazy(() => import('./renderers/ResearchWorkspace').then((item) => ({ default: item.ResearchWorkspace })));
const AnalysisWorkspace = lazy(() => import('./renderers/AnalysisWorkspace').then((item) => ({ default: item.AnalysisWorkspace })));
const ExecutionWorkspace = lazy(() => import('./renderers/ExecutionWorkspace').then((item) => ({ default: item.ExecutionWorkspace })));
const ReviewWorkspace = lazy(() => import('./renderers/ReviewWorkspace').then((item) => ({ default: item.ReviewWorkspace })));

export type RendererProps = { value: NodeWorkspace; onSaved: () => Promise<unknown> };
export type NodeRendererDefinition = { type: NodeKind; label: string; icon: LucideIcon; component: ComponentType<RendererProps> };

export const nodeRenderers: Record<NodeKind, NodeRendererDefinition> = {
  goal_definition: { type: 'goal_definition', label: '目标工作区', icon: Crosshair, component: GoalWorkspace },
  research: { type: 'research', label: '调研工作区', icon: BookOpenCheck, component: ResearchWorkspace },
  analysis: { type: 'analysis', label: '分析工作区', icon: BarChart3, component: AnalysisWorkspace },
  execution: { type: 'execution', label: '执行工作区', icon: TerminalSquare, component: ExecutionWorkspace },
  retrospective: { type: 'retrospective', label: '复盘工作区', icon: RefreshCw, component: ReviewWorkspace }
};

export function rendererFor(type: NodeKind) { return nodeRenderers[type] || nodeRenderers.goal_definition; }
