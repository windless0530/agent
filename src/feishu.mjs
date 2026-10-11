import lark from '@larksuiteoapi/node-sdk';
import { log, truncate } from './util.mjs';

export function larkDomain(name) {
  return name === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
}

/**
 * 封装发卡片 / 更新卡片 / 回文本消息
 */
export function createMessenger(cfg) {
  const client = new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: larkDomain(cfg.domain),
    loggerLevel: lark.LoggerLevel.warn,
  });
  return {
    client,

    /** 发送交互卡片到指定群（bindings 路由目标），返回 message_id */
    async sendCardTo(chatId, card) {
      const resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
      if (resp.code !== 0) {
        throw new Error(`发送卡片失败 code=${resp.code} msg=${resp.msg}`);
      }
      return resp.data?.message_id;
    },

    /** 更新已发送卡片内容 */
    async updateCard(messageId, card) {
      const resp = await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      if (resp.code !== 0) {
        throw new Error(`更新卡片失败 code=${resp.code} msg=${resp.msg}`);
      }
    },

    /** 回复指定消息（引用形式）一张卡片，返回 message_id；用于消息驱动指令的回执 */
    async replyCard(messageId, card) {
      const resp = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card), msg_type: 'interactive' },
      });
      if (resp.code !== 0) {
        throw new Error(`回复卡片失败 code=${resp.code} msg=${resp.msg}`);
      }
      return resp.data?.message_id;
    },

    /** 在指定会话回复纯文本（用于「绑定」引导） */
    async replyText(chatId, text) {
      const resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      if (resp.code !== 0) {
        throw new Error(`回复消息失败 code=${resp.code} msg=${resp.msg}`);
      }
    },
  };
}

/**
 * 建立 WebSocket 长连接接收卡片回调与消息事件。
 * 需要 App ID / Secret，且飞书后台「事件与回调」订阅方式选择了「使用长连接接收」。
 */
export async function startEventStream(cfg, { onCardAction, onMessage }) {
  const dispatcher = new lark.EventDispatcher({}).register({
    'card.action.trigger': async (data) => {
      // 入站回调落地日志：事件是否到达 daemon 的唯一判据（WS 僵尸/丢事件时此行不会出现）
      log(
        'card-cb',
        `收到卡片回调 value=${truncate(JSON.stringify(data?.action?.value ?? null), 160)}` +
          ` operator=${data?.operator?.open_id || '?'}`,
      );
      try {
        await onCardAction(data);
      } catch (e) {
        log('error', '处理卡片回调失败:', e.message);
      }
      // 返回 undefined：卡片由 daemon 显式 patch 更新
    },
    'im.message.receive_v1': async (data) => {
      try {
        await onMessage(data);
      } catch (e) {
        log('error', '处理消息事件失败:', e.message);
      }
    },
  });

  const ws = new lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: larkDomain(cfg.domain),
    loggerLevel: lark.LoggerLevel.warn,
    // 看门狗：半开连接收不到任何入站帧也不报 socket 错误，SDK 默认会一直假活
    // （卡片回调全丢、出站 REST 正常）。ping 后 pingTimeout 秒无入站帧即断开重连。
    wsConfig: { pingTimeout: cfg.wsPingTimeoutSec },
    // 卡在 DNS/代理/NAT 的握手可能无限悬挂，15s 未完成即放弃重试
    handshakeTimeoutMs: 15000,
    onReady: () => log('ws', '长连接已建立'),
    onError: (e) => log('ws', '长连接错误:', e?.message || e),
    onReconnecting: () => log('ws', '长连接断开，正在重连…'),
    onReconnected: () => log('ws', '长连接已恢复'),
  });

  await ws.start({ eventDispatcher: dispatcher });
  return ws;
}
