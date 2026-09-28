import { getServiceState, WecomApiError } from './wecom-api.ts';
import type { WecomApiConfig } from './wecom-api.ts';
import { errorCode } from './http-client.ts';

const stateHints = [
  '未处理；当前状态允许API回复，需核对48小时窗口及发送时状态是否变化',
  '智能助手接待；当前状态允许API回复，需核对48小时窗口及发送时状态是否变化',
  '人工排队中；当前状态不允许普通API回复',
  '人工接待中；当前状态不允许普通API回复',
  '已结束或未开始；请客户重新发送消息后再测试',
];

// Return only fixed text and validated codes, never upstream bodies or customer identifiers.
// This is a snapshot taken AFTER the failure, not proof of the state at send time.
export async function diagnoseSendFailure(cfg: WecomApiConfig, error: unknown, openKfId: string, user: string): Promise<string | undefined> {
  if (!(error instanceof WecomApiError) || error.errcode !== 95018) return undefined;
  try {
    const state = await getServiceState({ ...cfg, upstreamTimeoutMs: Math.min(cfg.upstreamTimeoutMs ?? 30000, 3000) }, openKfId, user);
    return `WECOM_95018 service_state=${state} ${stateHints[state]}（失败后查询）`;
  } catch (queryError) {
    return `WECOM_95018 service_state=UNKNOWN query_error=${errorCode(queryError)} 会话状态查询失败，尚不能确定原因`;
  }
}
