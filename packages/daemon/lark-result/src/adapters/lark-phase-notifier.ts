import {
  LarkHistoryRepository,
  createLogger,
  type TaskContextRef,
} from '@local-agent/shared';
import {
  getPhaseReactionTypes,
  getReactionForPhase,
  isLarkTaskPhase,
  type LarkTaskPhase,
} from '../phase-reaction-mapper';

const logger = createLogger('lark-daemon:phase-notifier');

const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_REACTIONS_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions?user_id_type=open_id`;
const LARK_DELETE_REACTION_URL = (messageId: string, reactionId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`;
const LARK_ADD_REACTION_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions`;

interface LarkReactionOperator {
  operator_id?: string;
  operator_type?: string;
  open_id?: string;
  user_id?: string;
}

interface LarkReactionItem {
  reaction_id: string;
  reaction_type?: {
    emoji_type?: string;
  };
  operator?: LarkReactionOperator;
}

export interface TaskPhaseEventLike {
  event_id?: string;
  task_id?: string;
  session_id?: string;
  context_ref?: TaskContextRef;
  phase: string;
  task_source?: {
    source: string;
    message_id?: string;
  };
}

type LarkPhaseReactionAction = 'set' | 'clear';

type HistoryRepository = Pick<
  LarkHistoryRepository,
  'appendLarkPhaseReactionAttempt'
>;

export interface TokenProvider {
  getTenantAccessToken(): Promise<string>;
}

export class LarkTenantTokenProvider implements TokenProvider {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async getTenantAccessToken(): Promise<string> {
    const tokenRes = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Lark token request failed with HTTP status ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as { tenant_access_token?: string; code: number };
    if (tokenData.code !== 0 || typeof tokenData.tenant_access_token !== 'string') {
      throw new Error(`Lark token request failed with code ${tokenData.code}`);
    }

    return tokenData.tenant_access_token;
  }
}

export class LarkPhaseNotifier {
  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly larkHistoryRepository?: HistoryRepository,
  ) {}

  async notify(event: TaskPhaseEventLike): Promise<void> {
    if (!isLarkTaskPhase(event.phase)) {
      logger.debug({ phase: event.phase }, 'Skipping unknown phase event');
      return;
    }

    const messageId = this.resolveMessageId(event);
    if (!messageId) {
      return;
    }

    const nowIso = new Date().toISOString();
    const reaction = getReactionForPhase(event.phase);
    const action: LarkPhaseReactionAction = reaction ? 'set' : 'clear';

    try {
      const token = await this.tokenProvider.getTenantAccessToken();
      let excludedReactionIds: string[] | undefined;

      if (reaction) {
        const addRes = await fetch(LARK_ADD_REACTION_URL(messageId), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ reaction_type: { emoji_type: reaction } }),
        });
        const addData = (await addRes.json()) as { code: number; msg?: string; data?: { reaction_id?: string } };
        if (addData.code !== 0) {
          throw new Error(`add reaction failed with code ${addData.code}${addData.msg ? `: ${addData.msg}` : ''}`);
        }
        if (addData.data?.reaction_id) {
          excludedReactionIds = [addData.data.reaction_id];
        }
      }

      const cleared = await clearBotOwnedPhaseReactions({
        messageId,
        token,
        expectedReactionTypes: getPhaseReactionTypes(),
        excludedReactionIds,
      });

      await this.recordPhaseAttempt(messageId, {
        phase: event.phase,
        action,
        ok: true,
        at: nowIso,
        event_id: event.event_id,
      });

      logger.info(
        {
          event_id: event.event_id,
          task_id: event.task_id,
          phase: event.phase,
          messageId,
          removed_reaction_count: cleared,
          applied_reaction: reaction,
        },
        'Applied lark phase reaction update',
      );
    } catch (err) {
      await this.recordPhaseAttempt(messageId, {
        phase: event.phase,
        action,
        ok: false,
        at: nowIso,
        event_id: event.event_id,
        error: stringifyError(err),
      });

      logger.warn(
        { event_id: event.event_id, task_id: event.task_id, phase: event.phase, messageId, err },
        'Failed to apply lark phase reaction update',
      );
    }
  }

  private resolveMessageId(event: TaskPhaseEventLike): string | null {
    if (event.task_source?.source === 'lark' && event.task_source.message_id) {
      return event.task_source.message_id;
    }

    if (event.context_ref?.platform === 'lark') {
      return event.context_ref.root_key;
    }

    return null;
  }

  async clearPhaseReactions(
    messageId: string,
    context: { phase?: LarkTaskPhase; eventId?: string; at?: string } = {},
  ): Promise<void> {
    const at = context.at ?? new Date().toISOString();

    try {
      const token = await this.tokenProvider.getTenantAccessToken();
      await clearBotOwnedPhaseReactions({
        messageId,
        token,
        expectedReactionTypes: getPhaseReactionTypes(),
      });

      await this.recordPhaseAttempt(messageId, {
        phase: context.phase ?? 'completed',
        action: 'clear',
        ok: true,
        at,
        event_id: context.eventId,
      });
    } catch (err) {
      await this.recordPhaseAttempt(messageId, {
        phase: context.phase ?? 'completed',
        action: 'clear',
        ok: false,
        at,
        event_id: context.eventId,
        error: stringifyError(err),
      });

      logger.warn({ messageId, err }, 'Failed to clear bot-owned phase reactions');
    }
  }

  private async recordPhaseAttempt(messageId: string, attempt: {
    phase: string;
    action: LarkPhaseReactionAction;
    ok: boolean;
    at: string;
    event_id?: string;
    error?: string;
  }): Promise<void> {
    if (!this.larkHistoryRepository) {
      return;
    }

    try {
      await this.larkHistoryRepository.appendLarkPhaseReactionAttempt(messageId, attempt);
    } catch (err) {
      logger.warn({ messageId, attempt, err }, 'Failed to persist lark phase reaction attempt metadata');
    }
  }
}

export interface ClearBotOwnedPhaseReactionsParams {
  messageId: string;
  token: string;
  expectedReactionTypes: string[];
  excludedReactionIds?: string[];
}

export async function clearBotOwnedPhaseReactions(
  params: ClearBotOwnedPhaseReactionsParams,
): Promise<number> {
  try {
    const excludedReactionIds = new Set(params.excludedReactionIds ?? []);
    const listRes = await fetch(LARK_REACTIONS_URL(params.messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${params.token}` },
    });
    const listData = (await listRes.json()) as {
      code: number;
      data?: {
        user_id?: string;
        open_id?: string;
        items?: LarkReactionItem[];
      };
      msg?: string;
    };

    if (listData.code !== 0) {
      throw new Error(`list reactions failed with code ${listData.code}${listData.msg ? `: ${listData.msg}` : ''}`);
    }

    const botOpenId = listData.data?.open_id;
    const botUserId = listData.data?.user_id;
    const items = listData.data?.items ?? [];

    let deleted = 0;
    for (const item of items) {
      if (excludedReactionIds.has(item.reaction_id)) {
        continue;
      }

      const reactionType = item.reaction_type?.emoji_type;
      if (!reactionType || !params.expectedReactionTypes.includes(reactionType)) {
        continue;
      }

      const operator = item.operator;
      const operatorMatchesBot = Boolean(
        operator &&
          (operator.operator_type === 'app' ||
            (botOpenId && (operator.open_id === botOpenId || operator.operator_id === botOpenId)) ||
            (botUserId && (operator.user_id === botUserId || operator.operator_id === botUserId))),
      );
      if (!operatorMatchesBot) {
        continue;
      }

      try {
        const deleteRes = await fetch(LARK_DELETE_REACTION_URL(params.messageId, item.reaction_id), {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${params.token}` },
        });
        const deleteData = (await deleteRes.json()) as { code: number; msg?: string };
        if (deleteData.code !== 0) {
          logger.debug(
            {
              messageId: params.messageId,
              reactionId: item.reaction_id,
              reactionType,
              code: deleteData.code,
            },
            'Failed to delete bot-owned phase reaction',
          );
          continue;
        }
        deleted += 1;
      } catch (err) {
        logger.warn(
          { messageId: params.messageId, reactionId: item.reaction_id, reactionType, err },
          'Error deleting bot-owned phase reaction',
        );
      }
    }

    return deleted;
  } catch (err) {
    logger.warn({ messageId: params.messageId, err }, 'Failed to clear bot-owned phase reactions');
    throw err;
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
