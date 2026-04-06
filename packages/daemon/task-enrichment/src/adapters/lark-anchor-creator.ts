const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_MESSAGE_URL = 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id';

export interface LarkAnchorResult {
  rootMessageId: string;
  text: string;
  createdAtMs: number;
}

export class LarkAnchorCreator {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly recipientId: string,
  ) {}

  async createRootMessage(params: { sessionId: string; taskType: string; userText: string }): Promise<LarkAnchorResult> {
    const token = await this.getTenantAccessToken();
    const text = [
      `Bridged Telegram session: ${params.sessionId}`,
      `task_type: ${params.taskType}`,
      'Telegram topic created for cross-channel parity.',
      `First user message: ${params.userText}`,
    ].join('\n');

    const res = await fetch(LARK_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: this.recipientId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });

    const data = await res.json() as { code: number; data?: { message_id?: string } };
    if (data.code !== 0 || !data.data?.message_id) {
      throw new Error(`Lark anchor send failed with code ${data.code}`);
    }

    return {
      rootMessageId: data.data.message_id,
      text,
      createdAtMs: Date.now(),
    };
  }

  private async getTenantAccessToken(): Promise<string> {
    const res = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = await res.json() as { code: number; tenant_access_token?: string };

    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error('Failed to get Lark tenant access token');
    }

    return data.tenant_access_token;
  }
}
