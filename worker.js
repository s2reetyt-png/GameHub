import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGIN = "https://s2reetyt-png.github.io";

function corsHeaders(origin = ALLOWED_ORIGIN) {
  const allowed =
    origin === ALLOWED_ORIGIN ||
    origin === "http://localhost:3000" ||
    origin === "http://localhost:5173" ||
    origin === "http://127.0.0.1:3000" ||
    origin === "http://127.0.0.1:5173";

  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400"
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function getOrigin(request) {
  return request.headers.get("Origin") || ALLOWED_ORIGIN;
}

function cleanName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function cleanId(id) {
  return String(id || "")
    .trim()
    .slice(0, 100);
}

function randomId(prefix = "") {
  return prefix + crypto.randomUUID();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    createdAt: user.createdAt || null,
    lastSeen: user.lastSeen || null
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = getOrigin(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    /*
     * WebSocket endpoint
     *
     * /ws
     */
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json(
          {
            ok: false,
            error: "WebSocket upgrade required."
          },
          426,
          origin
        );
      }

      const roomId = env.GAMEHUB_ROOM.idFromName("main");
      const room = env.GAMEHUB_ROOM.get(roomId);

      return room.fetch(request);
    }

    /*
     * Session endpoint.
     */
    if (url.pathname === "/api/session") {
      return json(
        {
          ok: true,
          server: "GameHub",
          online: true,
          time: Date.now()
        },
        200,
        origin
      );
    }

    /*
     * All social/account-style API calls are handled by
     * the same Durable Object so the data stays centralized.
     */
    if (url.pathname.startsWith("/api/social/")) {
      const roomId = env.GAMEHUB_ROOM.idFromName("main");
      const room = env.GAMEHUB_ROOM.get(roomId);

      const forwarded = new URL(request.url);

      forwarded.pathname = forwarded.pathname.replace(
        "/api/social",
        "/social"
      );

      return room.fetch(
        new Request(forwarded.toString(), request)
      );
    }

    /*
     * Everything else is served by Cloudflare Assets.
     */
    return env.ASSETS.fetch(request);
  }
};


export class GameHubRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.env = env;

    /*
     * Rebuild our connection information after hibernation.
     *
     * Each WebSocket has a serialized attachment containing:
     * - connectionId
     * - playerId
     * - name
     */
    this.connections = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();

      if (attachment?.connectionId) {
        this.connections.set(ws, attachment);
      }
    }

    /*
     * Ping/pong can happen without waking the Durable Object.
     */
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong")
      );
    } catch {
      // Older/local runtimes may not support this.
    }
  }

  /*
   * ---------------------------------------------------------
   * HTTP
   * ---------------------------------------------------------
   */

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/social/register") {
      return this.registerPlayer(request);
    }

    if (url.pathname === "/social/search") {
      return this.searchPlayers(request);
    }

    if (url.pathname === "/social/friends") {
      return this.getFriends(request);
    }

    if (url.pathname === "/social/requests") {
      return this.getRequests(request);
    }

    if (url.pathname === "/social/friend-request") {
      return this.friendRequest(request);
    }

    if (url.pathname === "/social/friend-accept") {
      return this.friendAccept(request);
    }

    if (url.pathname === "/social/friend-decline") {
      return this.friendDecline(request);
    }

    if (url.pathname === "/social/friend-remove") {
      return this.friendRemove(request);
    }

    if (
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.openWebSocket(request);
    }

    return json(
      {
        ok: false,
        error: "GameHub endpoint not found."
      },
      404,
      request.headers.get("Origin") || ALLOWED_ORIGIN
    );
  }

  /*
   * ---------------------------------------------------------
   * PLAYER STORAGE
   * ---------------------------------------------------------
   */

  async registerPlayer(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const body = await readJson(request);

    const name = cleanName(body?.name);
    let playerId = cleanId(body?.playerId);

    if (!name) {
      return json(
        {
          ok: false,
          error: "A player name is required."
        },
        400,
        origin
      );
    }

    if (!playerId) {
      playerId = randomId("player_");
    }

    const existing = await this.ctx.storage.get(`player:${playerId}`);

    const player = {
      id: playerId,
      name,
      createdAt: existing?.createdAt || Date.now(),
      lastSeen: Date.now()
    };

    await this.ctx.storage.put(`player:${playerId}`, player);

    /*
     * Make sure the player has a friends list and request list.
     */
    if (!(await this.ctx.storage.get(`friends:${playerId}`))) {
      await this.ctx.storage.put(`friends:${playerId}`, []);
    }

    if (!(await this.ctx.storage.get(`requests:${playerId}`))) {
      await this.ctx.storage.put(`requests:${playerId}`, []);
    }

    return json(
      {
        ok: true,
        player: normalizeUser(player)
      },
      200,
      origin
    );
  }

  async getPlayer(playerId) {
    if (!playerId) return null;

    return await this.ctx.storage.get(`player:${playerId}`);
  }

  async searchPlayers(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const url = new URL(request.url);

    const q = String(url.searchParams.get("q") || "")
      .trim()
      .toLowerCase()
      .slice(0, 40);

    const exclude = cleanId(
      url.searchParams.get("exclude") || ""
    );

    if (!q) {
      return json(
        {
          ok: true,
          players: []
        },
        200,
        origin
      );
    }

    const list = await this.ctx.storage.list({
      prefix: "player:"
    });

    const players = [];

    for (const [, value] of list) {
      if (!value) continue;

      if (exclude && value.id === exclude) {
        continue;
      }

      if (
        String(value.name || "")
          .toLowerCase()
          .includes(q)
      ) {
        players.push(normalizeUser(value));
      }

      if (players.length >= 25) {
        break;
      }
    }

    return json(
      {
        ok: true,
        players
      },
      200,
      origin
    );
  }

  /*
   * ---------------------------------------------------------
   * FRIENDS
   * ---------------------------------------------------------
   */

  async getFriends(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const url = new URL(request.url);

    const playerId = cleanId(
      url.searchParams.get("playerId")
    );

    if (!playerId) {
      return json(
        {
          ok: false,
          error: "playerId is required."
        },
        400,
        origin
      );
    }

    const friendIds =
      (await this.ctx.storage.get(`friends:${playerId}`)) || [];

    const friends = [];

    for (const friendId of friendIds) {
      const friend = await this.getPlayer(friendId);

      if (friend) {
        friends.push({
          ...normalizeUser(friend),
          online: this.isPlayerOnline(friend.id)
        });
      }
    }

    return json(
      {
        ok: true,
        friends
      },
      200,
      origin
    );
  }

  async getRequests(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const url = new URL(request.url);

    const playerId = cleanId(
      url.searchParams.get("playerId")
    );

    if (!playerId) {
      return json(
        {
          ok: false,
          error: "playerId is required."
        },
        400,
        origin
      );
    }

    const requestIds =
      (await this.ctx.storage.get(`requests:${playerId}`)) || [];

    const requests = [];

    for (const requesterId of requestIds) {
      const requester = await this.getPlayer(requesterId);

      if (requester) {
        requests.push({
          ...normalizeUser(requester),
          online: this.isPlayerOnline(requester.id)
        });
      }
    }

    return json(
      {
        ok: true,
        requests
      },
      200,
      origin
    );
  }

  async friendRequest(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const body = await readJson(request);

    const fromId = cleanId(body?.fromId);
    const toId = cleanId(body?.toId);

    if (!fromId || !toId) {
      return json(
        {
          ok: false,
          error: "Both fromId and toId are required."
        },
        400,
        origin
      );
    }

    if (fromId === toId) {
      return json(
        {
          ok: false,
          error: "You cannot add yourself."
        },
        400,
        origin
      );
    }

    const from = await this.getPlayer(fromId);
    const to = await this.getPlayer(toId);

    if (!from || !to) {
      return json(
        {
          ok: false,
          error: "Player not found."
        },
        404,
        origin
      );
    }

    const fromFriends =
      (await this.ctx.storage.get(`friends:${fromId}`)) || [];

    const toFriends =
      (await this.ctx.storage.get(`friends:${toId}`)) || [];

    if (
      fromFriends.includes(toId) ||
      toFriends.includes(fromId)
    ) {
      return json(
        {
          ok: false,
          error: "You are already friends."
        },
        409,
        origin
      );
    }

    const requests =
      (await this.ctx.storage.get(`requests:${toId}`)) || [];

    if (requests.includes(fromId)) {
      return json(
        {
          ok: false,
          error: "Friend request already sent."
        },
        409,
        origin
      );
    }

    requests.push(fromId);

    await this.ctx.storage.put(
      `requests:${toId}`,
      [...new Set(requests)]
    );

    /*
     * Immediately notify the target if they are online.
     */
    this.sendToPlayer(toId, {
      type: "friend-request",
      from: normalizeUser(from)
    });

    return json(
      {
        ok: true
      },
      200,
      origin
    );
  }

  async friendAccept(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const body = await readJson(request);

    const playerId = cleanId(body?.playerId);
    const requesterId = cleanId(body?.requesterId);

    if (!playerId || !requesterId) {
      return json(
        {
          ok: false,
          error: "playerId and requesterId are required."
        },
        400,
        origin
      );
    }

    const player = await this.getPlayer(playerId);
    const requester = await this.getPlayer(requesterId);

    if (!player || !requester) {
      return json(
        {
          ok: false,
          error: "Player not found."
        },
        404,
        origin
      );
    }

    let requests =
      (await this.ctx.storage.get(`requests:${playerId}`)) || [];

    requests = requests.filter(
      id => id !== requesterId
    );

    await this.ctx.storage.put(
      `requests:${playerId}`,
      requests
    );

    const playerFriends =
      (await this.ctx.storage.get(`friends:${playerId}`)) || [];

    const requesterFriends =
      (await this.ctx.storage.get(`friends:${requesterId}`)) || [];

    if (!playerFriends.includes(requesterId)) {
      playerFriends.push(requesterId);
    }

    if (!requesterFriends.includes(playerId)) {
      requesterFriends.push(playerId);
    }

    await this.ctx.storage.put(
      `friends:${playerId}`,
      [...new Set(playerFriends)]
    );

    await this.ctx.storage.put(
      `friends:${requesterId}`,
      [...new Set(requesterFriends)]
    );

    this.sendToPlayer(requesterId, {
      type: "friend-accepted",
      friend: normalizeUser(player)
    });

    this.sendToPlayer(playerId, {
      type: "friend-accepted",
      friend: normalizeUser(requester)
    });

    return json(
      {
        ok: true
      },
      200,
      origin
    );
  }

  async friendDecline(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const body = await readJson(request);

    const playerId = cleanId(body?.playerId);
    const requesterId = cleanId(body?.requesterId);

    if (!playerId || !requesterId) {
      return json(
        {
          ok: false,
          error: "playerId and requesterId are required."
        },
        400,
        origin
      );
    }

    let requests =
      (await this.ctx.storage.get(`requests:${playerId}`)) || [];

    requests = requests.filter(
      id => id !== requesterId
    );

    await this.ctx.storage.put(
      `requests:${playerId}`,
      requests
    );

    this.sendToPlayer(requesterId, {
      type: "friend-declined",
      playerId
    });

    return json(
      {
        ok: true
      },
      200,
      origin
    );
  }

  async friendRemove(request) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;
    const body = await readJson(request);

    const playerId = cleanId(body?.playerId);
    const friendId = cleanId(body?.friendId);

    if (!playerId || !friendId) {
      return json(
        {
          ok: false,
          error: "playerId and friendId are required."
        },
        400,
        origin
      );
    }

    let friends =
      (await this.ctx.storage.get(`friends:${playerId}`)) || [];

    friends = friends.filter(
      id => id !== friendId
    );

    await this.ctx.storage.put(
      `friends:${playerId}`,
      friends
    );

    let otherFriends =
      (await this.ctx.storage.get(`friends:${friendId}`)) || [];

    otherFriends = otherFriends.filter(
      id => id !== playerId
    );

    await this.ctx.storage.put(
      `friends:${friendId}`,
      otherFriends
    );

    this.sendToPlayer(friendId, {
      type: "friend-removed",
      playerId
    });

    return json(
      {
        ok: true
      },
      200,
      origin
    );
  }

  /*
   * ---------------------------------------------------------
   * WEBSOCKET CONNECTIONS
   * ---------------------------------------------------------
   */

  async openWebSocket(request) {
    const url = new URL(request.url);

    let playerId = cleanId(
      url.searchParams.get("playerId")
    );

    let name = cleanName(
      url.searchParams.get("name")
    );

    if (!playerId) {
      playerId = randomId("player_");
    }

    if (!name) {
      name = "Guest";
    }

    /*
     * Save/update player information.
     */
    const existing = await this.getPlayer(playerId);

    const player = {
      id: playerId,
      name,
      createdAt: existing?.createdAt || Date.now(),
      lastSeen: Date.now()
    };

    await this.ctx.storage.put(
      `player:${playerId}`,
      player
    );

    /*
     * Create WebSocket pair.
     */
    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    const connectionId = randomId("connection_");

    const attachment = {
      connectionId,
      playerId,
      name
    };

    /*
     * Hibernation-compatible WebSocket.
     */
    this.ctx.acceptWebSocket(server);

    server.serializeAttachment(attachment);

    this.connections.set(server, attachment);

    /*
     * Tell the new player who they are.
     */
    this.safeSend(server, {
      type: "connected",
      player: {
        id: playerId,
        name
      },
      connectionId
    });

    /*
     * Send current online players.
     */
    this.sendOnlineListTo(server);

    /*
     * Tell everyone else that this player joined.
     */
    this.broadcast(
      {
        type: "presence",
        action: "online",
        player: {
          id: playerId,
          name
        },
        connectionId
      },
      server
    );

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  /*
   * ---------------------------------------------------------
   * WEBSOCKET MESSAGE HANDLER
   * ---------------------------------------------------------
   */

  async webSocketMessage(ws, message) {
    const info = this.getConnectionInfo(ws);

    if (!info) {
      this.safeSend(ws, {
        type: "error",
        message: "Connection information was lost."
      });

      return;
    }

    let data;

    try {
      data =
        typeof message === "string"
          ? JSON.parse(message)
          : JSON.parse(new TextDecoder().decode(message));
    } catch {
      this.safeSend(ws, {
        type: "error",
        message: "Invalid message."
      });

      return;
    }

    if (!data || typeof data !== "object") {
      return;
    }

    /*
     * -------------------------------------------------------
     * PING
     * -------------------------------------------------------
     */

    if (data.type === "ping") {
      this.safeSend(ws, {
        type: "pong",
        time: Date.now()
      });

      return;
    }

    /*
     * -------------------------------------------------------
     * PROFILE UPDATE
     * -------------------------------------------------------
     */

    if (data.type === "set-profile") {
      const name = cleanName(data.name);

      if (!name) return;

      const player = await this.getPlayer(info.playerId);

      const updated = {
        id: info.playerId,
        name,
        createdAt: player?.createdAt || Date.now(),
        lastSeen: Date.now()
      };

      await this.ctx.storage.put(
        `player:${info.playerId}`,
        updated
      );

      info.name = name;

      ws.serializeAttachment(info);

      this.safeSend(ws, {
        type: "profile-updated",
        player: normalizeUser(updated)
      });

      this.broadcast({
        type: "profile-updated",
        player: normalizeUser(updated)
      });

      this.sendOnlineListToAll();

      return;
    }

    /*
     * -------------------------------------------------------
     * GLOBAL CHAT
     * -------------------------------------------------------
     */

    if (
      data.type === "chat" ||
      data.type === "global-chat"
    ) {
      const text = String(data.message || "")
        .trim()
        .slice(0, 1000);

      if (!text) return;

      const payload = {
        type: "chat",
        message: text,
        from: {
          id: info.playerId,
          name: info.name
        },
        time: Date.now()
      };

      this.broadcast(payload);

      return;
    }

    /*
     * -------------------------------------------------------
     * PRIVATE MESSAGE
     * -------------------------------------------------------
     */

    if (
      data.type === "message" ||
      data.type === "private-message"
    ) {
      const text = String(data.message || "")
        .trim()
        .slice(0, 4000);

      const targetPlayerId = cleanId(
        data.targetPlayerId ||
        data.to ||
        data.target
      );

      if (!text || !targetPlayerId) return;

      const targetWs =
        this.findSocketByPlayerId(targetPlayerId);

      if (!targetWs) {
        this.safeSend(ws, {
          type: "message-failed",
          reason: "offline",
          targetPlayerId
        });

        return;
      }

      const messagePayload = {
        type: "message",
        message: text,
        from: {
          id: info.playerId,
          name: info.name
        },
        to: targetPlayerId,
        time: Date.now()
      };

      this.safeSend(targetWs, messagePayload);

      /*
       * Echo the message back to the sender so the sender's
       * UI can immediately display it.
       */
      this.safeSend(ws, {
        ...messagePayload,
        own: true
      });

      return;
    }

    /*
     * -------------------------------------------------------
     * CALL REQUEST
     *
     * The frontend can use a stable playerId.
     *
     * The server finds the current live WebSocket automatically.
     * -------------------------------------------------------
     */

    if (
      data.type === "call-request" ||
      data.type === "call-invite"
    ) {
      const targetPlayerId = cleanId(
        data.targetPlayerId ||
        data.target
      );

      if (!targetPlayerId) return;

      const targetWs =
        this.findSocketByPlayerId(targetPlayerId);

      if (!targetWs) {
        this.safeSend(ws, {
          type: "call-failed",
          reason: "offline",
          targetPlayerId
        });

        return;
      }

      this.safeSend(targetWs, {
        type: "incoming-call",
        from: {
          id: info.playerId,
          name: info.name
        },
        callerPlayerId: info.playerId,
        targetPlayerId,
        callId: data.callId || randomId("call_"),
        mode: data.mode === "video" ? "video" : "audio"
      });

      this.safeSend(ws, {
        type: "call-request-sent",
        targetPlayerId
      });

      return;
    }

    /*
     * -------------------------------------------------------
     * WEBRTC OFFER
     * -------------------------------------------------------
     *
     * IMPORTANT:
     * The frontend sends targetPlayerId.
     * It does NOT need to know the temporary WebSocket
     * connection ID.
     */

    if (data.type === "call-offer") {
      await this.relayCallMessage(
        ws,
        info,
        data,
        "call-offer"
      );

      return;
    }

    /*
     * -------------------------------------------------------
     * WEBRTC ANSWER
     * -------------------------------------------------------
     */

    if (data.type === "call-answer") {
      await this.relayCallMessage(
        ws,
        info,
        data,
        "call-answer"
      );

      return;
    }

    /*
     * -------------------------------------------------------
     * WEBRTC CANDIDATE
     * -------------------------------------------------------
     */

    if (
      data.type === "ice-candidate" ||
      data.type === "candidate"
    ) {
      await this.relayCallMessage(
        ws,
        info,
        data,
        "ice-candidate"
      );

      return;
    }

    /*
     * -------------------------------------------------------
     * CALL ACCEPTED
     * -------------------------------------------------------
     */

    if (data.type === "call-accepted") {
      await this.relayCallMessage(
        ws,
        info,
        data,
        "call-accepted"
      );

      return;
    }

    /*
     * -------------------------------------------------------
     * CALL DECLINED
     * -------------------------------------------------------
     */

    if (data.type === "call-declined") {
      await this.relayCallMessage(
        ws,
        info,
        data,
        "call-declined"
      );

      return;
    }

    /*
     * -------------------------------------------------------
     * CALL ENDED
     * -------------------------------------------------------
     */

    if (
      data.type === "call-end" ||
      data.type === "call-ended"
    ) {
      await this.relayCallMessage(
        ws,
        info,
        data,
        "call-ended"
      );

      return;
    }

    /*
     * -------------------------------------------------------
     * REQUEST CURRENT ONLINE LIST
     * -------------------------------------------------------
     */

    if (
      data.type === "get-online" ||
      data.type === "get-presence"
    ) {
      this.sendOnlineListTo(ws);
      return;
    }

    /*
     * -------------------------------------------------------
     * SERVER / GAME EVENT
     * -------------------------------------------------------
     */

    if (data.type === "server-event") {
      const payload = {
        type: "server-event",
        event: String(data.event || "").slice(0, 100),
        data: data.data || {},
        from: {
          id: info.playerId,
          name: info.name
        },
        time: Date.now()
      };

      this.broadcast(payload);

      return;
    }
  }

  /*
   * ---------------------------------------------------------
   * CALL RELAY
   * ---------------------------------------------------------
   */

  async relayCallMessage(ws, info, data, type) {
    const targetPlayerId = cleanId(
      data.targetPlayerId ||
      data.targetPlayer ||
      data.target
    );

    if (!targetPlayerId) {
      this.safeSend(ws, {
        type: "call-failed",
        reason: "missing-target"
      });

      return;
    }

    if (targetPlayerId === info.playerId) {
      this.safeSend(ws, {
        type: "call-failed",
        reason: "self"
      });

      return;
    }

    const targetWs =
      this.findSocketByPlayerId(targetPlayerId);

    if (!targetWs) {
      this.safeSend(ws, {
        type: "call-failed",
        reason: "offline",
        targetPlayerId
      });

      return;
    }

    /*
     * Never forward internal connection IDs to the client.
     *
     * The receiver only needs to know who sent the signal.
     */
    const payload = {
      ...data,
      type,
      fromPlayerId: info.playerId,
      from: {
        id: info.playerId,
        name: info.name
      },
      targetPlayerId,
      time: Date.now()
    };

    delete payload.target;

    this.safeSend(targetWs, payload);
  }

  /*
   * ---------------------------------------------------------
   * CONNECTION LOOKUPS
   * ---------------------------------------------------------
   */

  getConnectionInfo(ws) {
    let info = this.connections.get(ws);

    if (info) {
      return info;
    }

    try {
      info = ws.deserializeAttachment();

      if (info?.connectionId) {
        this.connections.set(ws, info);
        return info;
      }
    } catch {
      // Ignore malformed attachment.
    }

    return null;
  }

  findSocketByPlayerId(playerId) {
    const wanted = cleanId(playerId);

    if (!wanted) return null;

    for (const [ws, info] of this.connections.entries()) {
      if (
        info?.playerId === wanted &&
        ws.readyState === WebSocket.OPEN
      ) {
        return ws;
      }
    }

    /*
     * If this object woke from hibernation, rebuild the map.
     */
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment();

      if (
        info?.playerId === wanted &&
        ws.readyState === WebSocket.OPEN
      ) {
        this.connections.set(ws, info);
        return ws;
      }
    }

    return null;
  }

  isPlayerOnline(playerId) {
    return !!this.findSocketByPlayerId(playerId);
  }

  /*
   * ---------------------------------------------------------
   * ONLINE PLAYER LIST
   * ---------------------------------------------------------
   */

  getOnlinePlayers() {
    const players = [];

    /*
     * First rebuild any connections that aren't currently
     * represented in the in-memory Map.
     */
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment();

      if (!info?.playerId) continue;

      this.connections.set(ws, info);

      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      players.push({
        id: info.playerId,
        playerId: info.playerId,
        name: info.name,
        connectionId: info.connectionId,
        online: true
      });
    }

    return players;
  }

  sendOnlineListTo(ws) {
    this.safeSend(ws, {
      type: "online",
      players: this.getOnlinePlayers()
    });
  }

  sendOnlineListToAll() {
    const players = this.getOnlinePlayers();

    this.broadcast({
      type: "online",
      players
    });
  }

  /*
   * ---------------------------------------------------------
   * SEND / BROADCAST
   * ---------------------------------------------------------
   */

  safeSend(ws, payload) {
    try {
      if (
        ws &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(JSON.stringify(payload));
        return true;
      }
    } catch {
      // Connection disappeared.
    }

    return false;
  }

  broadcast(payload, exceptWs = null) {
    const serialized = JSON.stringify(payload);

    for (const ws of this.ctx.getWebSockets()) {
      if (
        ws === exceptWs ||
        ws.readyState !== WebSocket.OPEN
      ) {
        continue;
      }

      try {
        ws.send(serialized);
      } catch {
        // Ignore dead connection.
      }
    }
  }

  sendToPlayer(playerId, payload) {
    const ws = this.findSocketByPlayerId(playerId);

    if (!ws) {
      return false;
    }

    return this.safeSend(ws, payload);
  }

  /*
   * ---------------------------------------------------------
   * WEBSOCKET CLOSE
   * ---------------------------------------------------------
   */

  async webSocketClose(ws, code, reason, wasClean) {
    const info = this.getConnectionInfo(ws);

    this.connections.delete(ws);

    if (!info) {
      return;
    }

    /*
     * Only announce offline if that player doesn't have
     * another active connection.
     */
    const stillOnline =
      !!this.findSocketByPlayerId(info.playerId);

    if (!stillOnline) {
      const player = await this.getPlayer(info.playerId);

      if (player) {
        player.lastSeen = Date.now();

        await this.ctx.storage.put(
          `player:${info.playerId}`,
          player
        );
      }

      this.broadcast({
        type: "presence",
        action: "offline",
        player: {
          id: info.playerId,
          name: info.name
        }
      });
    }

    this.sendOnlineListToAll();
  }

  webSocketError(ws, error) {
    this.connections.delete(ws);
  }
}
