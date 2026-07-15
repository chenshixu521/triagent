import type { AgentEvent } from '../agents/agent-adapter.js';
import type { AgentKind, AgentRole } from '../domain/task.js';
import type { WorkflowState } from '../workflow/states.js';

/** Design tags from docs/design/work-status-v2.html */
export type ActivityTag =
  | 'system'
  | 'stage'
  | 'tool'
  | 'master'
  | 'impl'
  | 'review';

export interface ActivityLine {
  readonly at: string;
  readonly tag: ActivityTag;
  readonly text: string;
  /** Full rendered line: `HH:MM:SS  [tag] text` */
  readonly line: string;
}

export function formatClock(date: Date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function renderActivityLine(
  tag: ActivityTag,
  text: string,
  at: Date = new Date(),
): ActivityLine {
  const clock = formatClock(at);
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    at: clock,
    tag,
    text: cleaned,
    line: `${clock}  [${tag}] ${cleaned}`,
  };
}

export function roleTag(role: AgentRole): ActivityTag {
  switch (role) {
    case 'master':
      return 'master';
    case 'implementer':
      return 'impl';
    case 'reviewer':
      return 'review';
  }
}

export function roleLabelZh(role: AgentRole): string {
  switch (role) {
    case 'master':
      return '主控';
    case 'implementer':
      return '实施';
    case 'reviewer':
      return '审查';
  }
}

export function adapterLabel(kind: AgentKind): string {
  switch (kind) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'grok':
      return 'Grok';
  }
}

export function stageActivityMessage(state: WorkflowState): ActivityLine {
  switch (state) {
    case 'checking_environment':
      return renderActivityLine('stage', '正在检查环境与代理 CLI…');
    case 'planning':
      return renderActivityLine('stage', '进入规划阶段');
    case 'awaiting_plan_approval':
      return renderActivityLine('stage', '计划已生成，等待你确认');
    case 'implementing':
      return renderActivityLine('stage', '进入实施阶段');
    case 'reviewing':
      return renderActivityLine('stage', '进入审查阶段');
    case 'master_validation':
      return renderActivityLine('stage', '进入主控终检');
    case 'completed':
      return renderActivityLine('system', '任务完成 · 可退出');
    case 'failed':
      return renderActivityLine('system', '任务失败');
    case 'cancelled':
      return renderActivityLine('system', '任务已取消');
    case 'rework_requested':
      return renderActivityLine('stage', '已请求返工');
    case 'paused_after_run':
      return renderActivityLine('stage', '当前阶段已暂停');
    case 'awaiting_user':
      return renderActivityLine('stage', '等待用户处理');
    case 'interrupting':
      return renderActivityLine('stage', '正在中断…');
    case 'interrupted_needs_inspection':
      return renderActivityLine('stage', '已中断，需要检查');
    case 'cleanup_failed':
      return renderActivityLine('system', '清理失败，需要检查');
    default:
      return renderActivityLine('stage', `状态: ${state}`);
  }
}

function summarizeText(text: string, max = 140): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Heuristic: detect tool-like agent output for design [tool] lines.
 * Matches Claude/Codex/Grok tool traces without inventing structured tool APIs.
 */
export function lookLikeToolLine(text: string): string | undefined {
  const t = text.trim();
  if (t.length === 0) return undefined;

  const patterns: readonly RegExp[] = [
    /^(Read|Write|Edit|Bash|Search|Glob|Grep|ApplyPatch|Shell|TodoWrite)\b[^\n]{0,120}/i,
    /^tool[_ ]?use[:\s]+([^\n]{1,120})/i,
    /^Using tool[:\s]+([^\n]{1,120})/i,
    /^(reading|writing|editing|running)\s+[^\n]{1,120}/i,
    /^file[:\s]+[^\n]{1,120}/i,
  ];
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match !== null) {
      return summarizeText(match[0]!, 120);
    }
  }
  return undefined;
}

export function formatAgentActivity(input: {
  readonly role: AgentRole;
  readonly adapterKind: AgentKind;
  readonly event: AgentEvent;
}): ActivityLine | undefined {
  const tag = roleTag(input.role);
  const who = adapterLabel(input.adapterKind);
  const roleZh = roleLabelZh(input.role);
  const event = input.event;

  switch (event.type) {
    case 'process_started':
      return renderActivityLine(
        tag,
        `${who} 开始${roleZh === '主控' ? '规划/终检' : roleZh}`,
      );
    case 'output': {
      const tool = lookLikeToolLine(event.text);
      if (tool !== undefined) {
        return renderActivityLine(
          'tool',
          `${input.role === 'implementer' ? 'impl' : input.role === 'reviewer' ? 'review' : 'master'} ${tool}`,
        );
      }
      const text = summarizeText(event.text, 140);
      if (text.length === 0) return undefined;
      // Skip very noisy JSON blobs
      if (text.startsWith('{') && text.length > 80) {
        return renderActivityLine(tag, `${who} 输出结构化事件…`);
      }
      return renderActivityLine(tag, text);
    }
    case 'result':
      return renderActivityLine(tag, `${who} 阶段结果已返回`);
    case 'stderr': {
      const text = summarizeText(event.chunk, 120);
      if (text.length === 0) return undefined;
      return renderActivityLine('system', `${who} stderr: ${text}`);
    }
    case 'parse_error':
      return renderActivityLine('system', `${who} 事件解析失败: ${event.error}`);
    case 'process_exited':
      return renderActivityLine(
        'system',
        `${who} 进程结束 code=${String(event.exitCode)} ${event.reason}`,
      );
    case 'cleanup_failed':
      return renderActivityLine('system', `${who} 清理失败: ${event.error}`);
    case 'cleanup_succeeded':
      return renderActivityLine('system', `${who} 进程清理完成`);
    case 'message_state':
      if (event.message.state === 'failed' && event.message.error !== undefined) {
        return renderActivityLine(
          'system',
          `${who} 消息失败: ${summarizeText(event.message.error, 100)}`,
        );
      }
      return undefined;
    default:
      return undefined;
  }
}
