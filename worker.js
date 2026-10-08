import { DurableObject } from "cloudflare:workers";

const CORS_ORIGIN = "https://s2reetyt-png.github.io";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Cache-Control": "no-store",
    ...extra
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(extra)
    }
  });
}

function normalizeName(name) {
  if (typeof name !== "string") return "Guest";
  const clean = name.trim().replace(/\s+/g, " ");
  return clean.slice(0, 32) || "Guest";
}

function normalizeId(id) {
  if (typeof id !== "string") return "";
  return id.trim().slice(0, 100);
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function makeGuestId() {
  return `guest-${crypto.randomUUID()}`;
}

function makeConnectionId() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

function cleanPlayer(player) {
  if (!player) return null;

  return {
    playerId: player.playerId,
    name: player.name,
    connectionId: player.connectionId || null,
    online: !!player.online,
    lastSeen: player.lastSeen || null
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * WebSocket endpoint
     */
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket connection.", {
          status: 426,
          headers: corsHeaders()
        });
      }

      const roomId = env.GAMEHUB_ROOM.idFromName("main");
      const room = env.GAMEHUB_ROOM.get(roomId);

      return room.fetch(request);
    }

    /*
     * API endpoint
     */
    if (url.pathname.startsWith("/api/")) {
      const roomId = env.GAMEHUB_ROOM.idFromName("main");
      const room = env.GAMEHUB_ROOM.get(roomId);

      return room.fetch(request);
    }

    /*
     * Everything else is served by GitHub Pages / Cloudflare Assets.
     */
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("GameHub", {
      status: 200,
      headers: corsHeaders({
        "Content-Type": "text/plain; charset=utf-8"
      })
    });
  }
};


/*
 * ============================================================
 * GAMEHUB ROOM
 * ============================================================
 */

export class GameHubRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  /*
   * ------------------------------------------------------------
   * HTTP
   * ------------------------------------------------------------
   */

  async fetch(request) {
    const url = new URL(request.url);

    /*
     * OPTIONS / CORS
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    /*
     * WebSocket connection
     */
    if (
      url.pathname === "/ws" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.handleWebSocket(request);
    }

    /*
     * API
     */
    if (url.pathname.startsWith("/api/")) {
      return this.handleApi(request, url);
    }

    return json({
      ok: true,
      service: "GameHub",
      room: "main"
    });
  }


  /*
   * ------------------------------------------------------------
   * WEBSOCKET CONNECTION
   * ------------------------------------------------------------
   */

  async handleWebSocket(request) {
    const url = new URL(request.url);

    let playerId =
      normalizeId(url.searchParams.get("playerId")) ||
      makeGuestId();

    let name =
      normalizeName(url.searchParams.get("name"));

    const connectionId = makeConnectionId();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    /*
     * IMPORTANT:
     *
     * We use Cloudflare's Hibernation WebSocket API.
     * The identity is stored on the WebSocket itself so the
     * connection can be restored after the Durable Object
     * is recreated.
     */
    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({
      connectionId,
      playerId,
      name,
      connectedAt: now()
    });

    /*
     * Tell this client who it is.
     */
    this.send(server, {
      type: "connected",
      connectionId,
      playerId,
      name
    });

    /*
     * Immediately send the complete current online list.
     */
    this.send(server, {
      type: "online",
      players: this.getOnlinePlayers()
    });

    /*
     * Register/update persistent player record.
     */
    await this.savePlayer({
      playerId,
      name,
      online: true,
      lastSeen: now()
    });

    /*
     * Tell EVERYONE about the new connection.
     */
    await this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  /*
   * ------------------------------------------------------------
   * WEBSOCKET MESSAGE
   * ------------------------------------------------------------
   */

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();

    if (!attachment) {
      return;
    }

    let data;

    if (typeof message === "string") {
      data = safeParse(message);
    } else {
      try {
        data = safeParse(new TextDecoder().decode(message));
      } catch {
        data = null;
      }
    }

    if (!data || typeof data !== "object") {
      return;
    }

    /*
     * ----------------------------------------------------------
     * HELLO / IDENTITY UPDATE
     * ----------------------------------------------------------
     */

    if (data.type === "hello") {
      const playerId =
        normalizeId(data.playerId) ||
        attachment.playerId;

      const name =
        normalizeName(data.name || attachment.name);

      const updated = {
        ...attachment,
        playerId,
        name
      };

      ws.serializeAttachment(updated);

      await this.savePlayer({
        playerId,
        name,
        online: true,
        lastSeen: now()
      });

      this.send(ws, {
        type: "identity",
        connectionId: updated.connectionId,
        playerId,
        name
      });

      await this.broadcastPresence();

      return;
    }


    /*
     * ----------------------------------------------------------
     * PING
     * ----------------------------------------------------------
     */

    if (data.type === "ping") {
      this.send(ws, {
        type: "pong",
        time: now()
      });

      return;
    }


    /*
     * ----------------------------------------------------------
     * CHAT
     * ----------------------------------------------------------
     *
     * If targetPlayerId exists, this becomes a private message.
     */

    if (data.type === "chat") {
      const text = String(data.message || "").trim();

      if (!text) return;

      const targetPlayerId =
        normalizeId(data.targetPlayerId);

      const messageObject = {
        type: "chat",
        id: crypto.randomUUID(),
        fromPlayerId: attachment.playerId,
        fromName: attachment.name,
        targetPlayerId: targetPlayerId || null,
        message: text.slice(0, 2000),
        timestamp: now()
      };

      /*
       * Private message
       */
      if (targetPlayerId) {
        this.sendToPlayer(targetPlayerId, messageObject);

        /*
         * Always send a copy back to sender so their own
         * message appears immediately.
         */
        this.send(ws, messageObject);

        return;
      }

      /*
       * Global chat if no target was specified.
       */
      this.broadcast(messageObject);

      return;
    }


    /*
     * ----------------------------------------------------------
     * REQUEST CALL TARGET
     * ----------------------------------------------------------
     *
     * Frontend gives us a stable playerId.
     * Server finds the actual CURRENT WebSocket connection.
     *
     * This fixes the old call-target problem.
     */

    if (data.type === "request-call-target") {
      const targetPlayerId =
        normalizeId(data.targetPlayerId);

      if (!targetPlayerId) {
        this.send(ws, {
          type: "call-error",
          message: "No call target was provided."
        });

        return;
      }

      const target = this.findOnlineConnection(targetPlayerId);

      if (!target) {
        this.send(ws, {
          type: "call-error",
          targetPlayerId,
          message: "That player is not currently online."
        });

        return;
      }

      this.send(ws, {
        type: "call-target",
        targetPlayerId,
        targetConnectionId: target.connectionId,
        targetName: target.name
      });

      return;
    }


    /*
     * ----------------------------------------------------------
     * WEBRTC SIGNALING
     * ----------------------------------------------------------
     */

    if (
      data.type === "call-offer" ||
      data.type === "call-answer" ||
      data.type === "ice-candidate" ||
      data.type === "call-end"
    ) {
      const targetConnectionId =
        normalizeId(data.targetConnectionId);

      if (!targetConnectionId) {
        this.send(ws, {
          type: "call-error",
          message: "No target connection was provided."
        });

        return;
      }

      const target = this.findConnection(targetConnectionId);

      if (!target) {
        this.send(ws, {
          type: "call-error",
          message: "The other player is no longer connected."
        });

        return;
      }

      this.send(target.ws, {
        ...data,
        senderConnectionId: attachment.connectionId,
        senderPlayerId: attachment.playerId,
        senderName: attachment.name
      });

      return;
    }


    /*
     * ----------------------------------------------------------
     * REQUEST ONLINE LIST
     * ----------------------------------------------------------
     */

    if (data.type === "get-online") {
      this.send(ws, {
        type: "online",
        players: this.getOnlinePlayers()
      });

      return;
    }


    /*
     * ----------------------------------------------------------
     * BROADCAST ANNOUNCEMENT
     * ----------------------------------------------------------
     */

    if (data.type === "announcement") {
      this.broadcast({
        type: "announcement",
        message: String(data.message || "").slice(0, 1000),
        timestamp: now()
      });

      return;
    }
  }


  /*
   * ------------------------------------------------------------
   * WEBSOCKET CLOSE
   * ------------------------------------------------------------
   */

  async webSocketClose(ws, code, reason, wasClean) {
    const attachment = ws.deserializeAttachment();

    if (attachment) {
      /*
       * Only mark the player offline if they have no other
       * active connections.
       */
      const otherConnection =
        this.findOnlineConnection(
          attachment.playerId,
          attachment.connectionId
        );

      if (!otherConnection) {
        await this.savePlayer({
          playerId: attachment.playerId,
          name: attachment.name,
          online: false,
          lastSeen: now()
        });
      }
    }

    /*
     * Tell everyone immediately.
     */
    await this.broadcastPresence();
  }


  /*
   * ------------------------------------------------------------
   * WEBSOCKET ERROR
   * ------------------------------------------------------------
   */

  async webSocketError(ws, error) {
    console.error("GameHub WebSocket error:", error);

    await this.broadcastPresence();
  }


  /*
   * ============================================================
   * ONLINE / PRESENCE
   * ============================================================
   */


  getConnections() {
    return this.ctx.getWebSockets();
  }


  getOnlinePlayers() {
    const connections = this.getConnections();

    const result = [];
    const seenConnections = new Set();

    for (const ws of connections) {
      try {
        if (ws.readyState !== WebSocket.OPEN) {
          continue;
        }

        const data = ws.deserializeAttachment();

        if (!data) continue;
        if (!data.connectionId) continue;

        if (seenConnections.has(data.connectionId)) {
          continue;
        }

        seenConnections.add(data.connectionId);

        result.push({
          connectionId: data.connectionId,
          playerId: data.playerId,
          name: data.name,
          online: true,
          connectedAt: data.connectedAt
        });
      } catch {
        /*
         * Ignore stale/broken sockets.
         */
      }
    }

    return result;
  }


  async broadcastPresence() {
    const players = this.getOnlinePlayers();

    this.broadcast({
      type: "online",
      players,
      count: players.length,
      timestamp: now()
    });
  }


  findConnection(connectionId) {
    if (!connectionId) return null;

    for (const ws of this.getConnections()) {
      try {
        if (ws.readyState !== WebSocket.OPEN) continue;

        const data = ws.deserializeAttachment();

        if (
          data &&
          data.connectionId === connectionId
        ) {
          return {
            ws,
            ...data
          };
        }
      } catch {
        // Ignore stale socket.
      }
    }

    return null;
  }


  findOnlineConnection(playerId, exceptConnectionId = null) {
    if (!playerId) return null;

    for (const ws of this.getConnections()) {
      try {
        if (ws.readyState !== WebSocket.OPEN) continue;

        const data = ws.deserializeAttachment();

        if (!data) continue;

        if (
          data.playerId === playerId &&
          data.connectionId !== exceptConnectionId
        ) {
          return {
            ws,
            ...data
          };
        }
      } catch {
        // Ignore stale socket.
      }
    }

    return null;
  }


  /*
   * ============================================================
   * SEND / BROADCAST
   * ============================================================
   */


  send(ws, data) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    } catch (error) {
      console.error("GameHub send error:", error);
    }
  }


  broadcast(data, exceptWs = null) {
    const message = JSON.stringify(data);

    for (const ws of this.getConnections()) {
      try {
        if (ws === exceptWs) continue;
        if (ws.readyState !== WebSocket.OPEN) continue;

        ws.send(message);
      } catch {
        // Ignore stale sockets.
      }
    }
  }


  sendToPlayer(playerId, data) {
    if (!playerId) return false;

    let sent = false;

    for (const ws of this.getConnections()) {
      try {
        if (ws.readyState !== WebSocket.OPEN) continue;

        const attachment = ws.deserializeAttachment();

        if (
          attachment &&
          attachment.playerId === playerId
        ) {
          ws.send(JSON.stringify(data));
          sent = true;
        }
      } catch {
        // Ignore stale sockets.
      }
    }

    return sent;
  }


  /*
   * ============================================================
   * API ROUTES
   * ============================================================
   */

  async handleApi(request, url) {

    /*
     * ----------------------------------------------------------
     * SESSION
     * ----------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname === "/api/session"
    ) {
      return json({
        ok: true,
        playerId: makeGuestId(),
        name: `Guest-${Math.floor(
          1000 + Math.random() * 9000
        )}`
      });
    }


    /*
     * ----------------------------------------------------------
     * REGISTER / UPDATE PLAYER
     * ----------------------------------------------------------
     */

    if (
      request.method === "POST" &&
      url.pathname === "/api/social/register"
    ) {
      const body = await readJson(request);

      const playerId =
        normalizeId(body.playerId) ||
        makeGuestId();

      const name =
        normalizeName(body.name);

      const existing =
        await this.ctx.storage.get(`player:${playerId}`);

      const player = {
        id: playerId,
        name,
        online: this.isPlayerOnline(playerId),
        lastSeen: existing?.lastSeen || now(),
        createdAt: existing?.createdAt || now()
      };

      await this.ctx.storage.put(
        `player:${playerId}`,
        player
      );

      return json({
        ok: true,
        player
      });
    }


    /*
     * ----------------------------------------------------------
     * SEARCH PEOPLE
     * ----------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname === "/api/social/search"
    ) {
      const query =
        (url.searchParams.get("q") || "")
          .trim()
          .toLowerCase();

      const currentPlayerId =
        normalizeId(
          url.searchParams.get("playerId")
        );

      const matches = [];

      const records =
        await this.ctx.storage.list({
          prefix: "player:",
          limit: 1000
        });

      for (const [, player] of records) {
        if (!player) continue;

        if (
          currentPlayerId &&
          player.id === currentPlayerId
        ) {
          continue;
        }

        if (!query) {
          matches.push({
            ...player,
            online: this.isPlayerOnline(player.id)
          });

          continue;
        }

        const name =
          String(player.name || "").toLowerCase();

        const id =
          String(player.id || "").toLowerCase();

        if (
          name.includes(query) ||
          id.includes(query)
        ) {
          matches.push({
            ...player,
            online: this.isPlayerOnline(player.id)
          });
        }
      }

      return json({
        ok: true,
        results: matches.slice(0, 50)
      });
    }


    /*
     * ----------------------------------------------------------
     * FRIEND LIST
     * ----------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname === "/api/social/friends"
    ) {
      const playerId =
        normalizeId(
          url.searchParams.get("playerId")
        );

      if (!playerId) {
        return json({
          ok: false,
          error: "Missing playerId"
        }, 400);
      }

      const friendIds =
        await this.ctx.storage.get(
          `friends:${playerId}`
        ) || [];

      const friends = [];

      for (const id of friendIds) {
        const friend =
          await this.ctx.storage.get(
            `player:${id}`
          );

        if (!friend) continue;

        friends.push({
          ...friend,
          online: this.isPlayerOnline(id)
        });
      }

      return json({
        ok: true,
        friends
      });
    }


    /*
     * ----------------------------------------------------------
     * FRIEND REQUESTS
     * ----------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname === "/api/social/requests"
    ) {
      const playerId =
        normalizeId(
          url.searchParams.get("playerId")
        );

      if (!playerId) {
        return json({
          ok: false,
          error: "Missing playerId"
        }, 400);
      }

      const requests =
        await this.ctx.storage.get(
          `requests:${playerId}`
        ) || [];

      return json({
        ok: true,
        requests
      });
    }


    /*
     * ----------------------------------------------------------
     * SEND FRIEND REQUEST
     * ----------------------------------------------------------
     */

    if (
      request.method === "POST" &&
      url.pathname === "/api/social/friend-request"
    ) {
      const body = await readJson(request);

      const fromId =
        normalizeId(body.fromPlayerId);

      const targetId =
        normalizeId(body.targetPlayerId);

      if (!fromId || !targetId) {
        return json({
          ok: false,
          error: "Missing player IDs"
        }, 400);
      }

      if (fromId === targetId) {
        return json({
          ok: false,
          error: "You cannot add yourself."
        }, 400);
      }

      const fromPlayer =
        await this.ctx.storage.get(
          `player:${fromId}`
        );

      const targetPlayer =
        await this.ctx.storage.get(
          `player:${targetId}`
        );

      if (!targetPlayer) {
        return json({
          ok: false,
          error: "Player not found."
        }, 404);
      }

      const friends =
        await this.ctx.storage.get(
          `friends:${fromId}`
        ) || [];

      if (friends.includes(targetId)) {
        return json({
          ok: false,
          error: "Already friends."
        }, 409);
      }

      const requests =
        await this.ctx.storage.get(
          `requests:${targetId}`
        ) || [];

      if (
        requests.some(
          request =>
            request.fromId === fromId
        )
      ) {
        return json({
          ok: false,
          error: "Friend request already sent."
        }, 409);
      }

      requests.push({
        id: crypto.randomUUID(),
        fromId,
        fromName:
          fromPlayer?.name || "Unknown",
        createdAt: now()
      });

      await this.ctx.storage.put(
        `requests:${targetId}`,
        requests
      );

      /*
       * Notify target immediately if online.
       */
      this.sendToPlayer(targetId, {
        type: "friend-request",
        fromId,
        fromName: fromPlayer?.name || "Unknown"
      });

      return json({
        ok: true
      });
    }


    /*
     * ----------------------------------------------------------
     * ACCEPT FRIEND
     * ----------------------------------------------------------
     */

    if (
      request.method === "POST" &&
      url.pathname === "/api/social/friend-accept"
    ) {
      const body = await readJson(request);

      const playerId =
        normalizeId(body.playerId);

      const requestId =
        normalizeId(body.requestId);

      if (!playerId || !requestId) {
        return json({
          ok: false,
          error: "Missing data."
        }, 400);
      }

      const requests =
        await this.ctx.storage.get(
          `requests:${playerId}`
        ) || [];

      const friendRequest =
        requests.find(
          item => item.id === requestId
        );

      if (!friendRequest) {
        return json({
          ok: false,
          error: "Friend request not found."
        }, 404);
      }

      const friendId =
        friendRequest.fromId;

      const remaining =
        requests.filter(
          item => item.id !== requestId
        );

      await this.ctx.storage.put(
        `requests:${playerId}`,
        remaining
      );

      const myFriends =
        await this.ctx.storage.get(
          `friends:${playerId}`
        ) || [];

      const theirFriends =
        await this.ctx.storage.get(
          `friends:${friendId}`
        ) || [];

      if (!myFriends.includes(friendId)) {
        myFriends.push(friendId);
      }

      if (!theirFriends.includes(playerId)) {
        theirFriends.push(playerId);
      }

      await this.ctx.storage.put(
        `friends:${playerId}`,
        myFriends
      );

      await this.ctx.storage.put(
        `friends:${friendId}`,
        theirFriends
      );

      this.sendToPlayer(friendId, {
        type: "friend-accepted",
        playerId
      });

      return json({
        ok: true
      });
    }


    /*
     * ----------------------------------------------------------
     * DECLINE FRIEND
     * ----------------------------------------------------------
     */

    if (
      request.method === "POST" &&
      url.pathname === "/api/social/friend-decline"
    ) {
      const body = await readJson(request);

      const playerId =
        normalizeId(body.playerId);

      const requestId =
        normalizeId(body.requestId);

      const requests =
        await this.ctx.storage.get(
          `requests:${playerId}`
        ) || [];

      const remaining =
        requests.filter(
          item => item.id !== requestId
        );

      await this.ctx.storage.put(
        `requests:${playerId}`,
        remaining
      );

      return json({
        ok: true
      });
    }


    /*
     * ----------------------------------------------------------
     * REMOVE FRIEND
     * ----------------------------------------------------------
     */

    if (
      request.method === "POST" &&
      url.pathname === "/api/social/friend-remove"
    ) {
      const body = await readJson(request);

      const playerId =
        normalizeId(body.playerId);

      const friendId =
        normalizeId(body.friendId);

      if (!playerId || !friendId) {
        return json({
          ok: false,
          error: "Missing data."
        }, 400);
      }

      const myFriends =
        await this.ctx.storage.get(
          `friends:${playerId}`
        ) || [];

      const theirFriends =
        await this.ctx.storage.get(
          `friends:${friendId}`
        ) || [];

      await this.ctx.storage.put(
        `friends:${playerId}`,
        myFriends.filter(
          id => id !== friendId
        )
      );

      await this.ctx.storage.put(
        `friends:${friendId}`,
        theirFriends.filter(
          id => id !== playerId
        )
      );

      return json({
        ok: true
      });
    }


    /*
     * ----------------------------------------------------------
     * CURRENT ONLINE USERS
     * ----------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname === "/api/social/online"
    ) {
      return json({
        ok: true,
        players: this.getOnlinePlayers()
      });
    }


    return json({
      ok: false,
      error: "API route not found."
    }, 404);
  }


  /*
   * ============================================================
   * STORAGE
   * ============================================================
   */

  async savePlayer(player) {
    if (!player?.playerId) return;

    const key =
      `player:${player.playerId}`;

    const existing =
      await this.ctx.storage.get(key);

    await this.ctx.storage.put(
      key,
      {
        id: player.playerId,
        name:
          player.name ||
          existing?.name ||
          "Guest",
        online:
          !!player.online,
        lastSeen:
          player.lastSeen ||
          existing?.lastSeen ||
          now(),
        createdAt:
          existing?.createdAt ||
          now()
      }
    );
  }


  isPlayerOnline(playerId) {
    if (!playerId) return false;

    for (const ws of this.getConnections()) {
      try {
        if (ws.readyState !== WebSocket.OPEN) {
          continue;
        }

        const attachment =
          ws.deserializeAttachment();

        if (
          attachment &&
          attachment.playerId === playerId
        ) {
          return true;
        }
      } catch {
        // Ignore stale socket.
      }
    }

    return false;
  }
}
