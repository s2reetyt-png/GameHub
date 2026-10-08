const ALLOWED_ORIGIN = "https://s2reetyt-png.github.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -----------------------------
    // CORS
    // -----------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // -----------------------------
    // HEALTH
    // -----------------------------

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "GameHub Backend",
        version: "friends-and-calls",
        time: new Date().toISOString()
      });
    }

    // -----------------------------
    // CREATE GUEST SESSION
    // -----------------------------

    if (
      url.pathname === "/api/session" &&
      request.method === "POST"
    ) {
      const id = crypto.randomUUID();

      const guestNumber =
        Math.floor(1000 + Math.random() * 9000);

      const name = "Guest-" + guestNumber;

      return json({
        ok: true,
        player: {
          id,
          name
        }
      });
    }

    // -----------------------------
    // SOCIAL API
    // -----------------------------

    if (url.pathname.startsWith("/api/social/")) {
      const id =
        env.GAMEHUB_ROOM.idFromName("main");

      const stub =
        env.GAMEHUB_ROOM.get(id);

      const socialUrl =
        new URL(request.url);

      socialUrl.pathname =
        socialUrl.pathname.replace(
          "/api/social",
          "/social"
        );

      return stub.fetch(
        new Request(
          socialUrl,
          request
        )
      );
    }

    // -----------------------------
    // WEBSOCKET
    // -----------------------------

    if (url.pathname === "/ws") {
      if (
        request.headers.get("Upgrade") !==
        "websocket"
      ) {
        return json(
          {
            ok: false,
            error:
              "WebSocket connection required"
          },
          400
        );
      }

      const room =
        url.searchParams.get("room") ||
        "main";

      let name =
        url.searchParams.get("name");

      let playerId =
        url.searchParams.get("playerId");

      // Create a guest if no identity exists.
      if (
        !name ||
        !name.trim()
      ) {
        name =
          "Guest-" +
          Math.floor(
            1000 +
            Math.random() * 9000
          );
      }

      if (
        !playerId ||
        !playerId.trim()
      ) {
        playerId =
          crypto.randomUUID();
      }

      name =
        name
          .trim()
          .slice(0, 24);

      playerId =
        playerId
          .trim()
          .slice(0, 100);

      const id =
        env.GAMEHUB_ROOM.idFromName(room);

      const stub =
        env.GAMEHUB_ROOM.get(id);

      const newUrl =
        new URL(request.url);

      newUrl.searchParams.set(
        "playerName",
        name
      );

      newUrl.searchParams.set(
        "playerId",
        playerId
      );

      return stub.fetch(
        new Request(
          newUrl,
          request
        )
      );
    }

    // -----------------------------
    // SEARCH API
    // -----------------------------

    if (url.pathname === "/api/search") {
      const query =
        url.searchParams.get("q");

      if (!query) {
        return json(
          {
            ok: false,
            error:
              "Missing search query"
          },
          400
        );
      }

      return Response.redirect(
        "https://duckduckgo.com/?q=" +
        encodeURIComponent(query),
        302
      );
    }

    // -----------------------------
    // STATIC FILES
    // -----------------------------

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "GameHub backend is running.",
      {
        status: 200,
        headers: {
          "content-type":
            "text/plain"
        }
      }
    );
  }
};

export class GameHubRoom {
  constructor(state) {
    this.state = state;

    // Active WebSocket connections.
    //
    // connectionId -> {
    //   socket,
    //   playerId,
    //   name
    // }
    this.clients = new Map();
  }

  // =========================================================
  // MAIN REQUEST HANDLER
  // =========================================================

  async fetch(request) {
    const url =
      new URL(request.url);

    // -----------------------------
    // SOCIAL HTTP API
    // -----------------------------

    if (
      url.pathname.startsWith("/social/")
    ) {
      return this.handleSocial(
        request,
        url
      );
    }

    // -----------------------------
    // WEBSOCKET
    // -----------------------------

    const upgrade =
      request.headers.get("Upgrade");

    if (
      upgrade !== "websocket"
    ) {
      return new Response(
        "GameHub Room Online",
        {
          status: 200
        }
      );
    }

    return this.handleWebSocket(
      request,
      url
    );
  }

  // =========================================================
  // WEBSOCKET CONNECTION
  // =========================================================

  async handleWebSocket(
    request,
    url
  ) {
    const pair =
      new WebSocketPair();

    const client =
      pair[0];

    const server =
      pair[1];

    const playerName =
      url.searchParams.get(
        "playerName"
      ) ||
      "Guest-" +
        Math.floor(
          1000 +
          Math.random() * 9000
        );

    const playerId =
      url.searchParams.get(
        "playerId"
      ) ||
      crypto.randomUUID();

    const connectionId =
      crypto.randomUUID();

    server.accept();

    this.clients.set(
      connectionId,
      {
        socket: server,
        playerId,
        name: playerName
      }
    );

    // Persist the player.
    await this.savePlayer(
      playerId,
      playerName,
      true
    );

    // Tell the new client who they are.
    this.send(
      server,
      {
        type: "connected",
        id: connectionId,
        playerId,
        name: playerName
      }
    );

    // Tell everyone else.
    this.broadcast(
      {
        type: "presence",
        action: "join",
        id: connectionId,
        playerId,
        name: playerName
      },
      connectionId
    );

    // Give this client the current online list.
    this.send(
      server,
      {
        type: "online",
        players:
          this.getPlayers()
      }
    );

    // Send pending friend requests.
    const requests =
      await this.getRequests(
        playerId
      );

    this.send(
      server,
      {
        type:
          "friend-requests",
        requests
      }
    );

    server.addEventListener(
      "message",
      event => {
        this.handleMessage(
          connectionId,
          playerId,
          playerName,
          event.data
        );
      }
    );

    server.addEventListener(
      "close",
      () => {
        this.removePlayer(
          connectionId
        );
      }
    );

    server.addEventListener(
      "error",
      () => {
        this.removePlayer(
          connectionId
        );
      }
    );

    return new Response(
      null,
      {
        status: 101,
        webSocket: client
      }
    );
  }

  // =========================================================
  // REMOVE CONNECTION
  // =========================================================

  async removePlayer(
    connectionId
  ) {
    const client =
      this.clients.get(
        connectionId
      );

    if (!client) {
      return;
    }

    this.clients.delete(
      connectionId
    );

    // Only mark offline if they have
    // no other active connections.
    const stillOnline =
      this.getConnectionsForPlayer(
        client.playerId
      ).length > 0;

    if (!stillOnline) {
      await this.savePlayer(
        client.playerId,
        client.name,
        false
      );
    }

    this.broadcast({
      type: "presence",
      action:
        stillOnline
          ? "update"
          : "leave",
      id:
        connectionId,
      playerId:
        client.playerId,
      name:
        client.name
    });
  }

  // =========================================================
  // WEBSOCKET MESSAGE HANDLER
  // =========================================================

  async handleMessage(
    connectionId,
    playerId,
    playerName,
    raw
  ) {
    let data;

    try {
      data =
        JSON.parse(raw);
    } catch {
      return;
    }

    // -----------------------------
    // CHAT
    // -----------------------------

    if (
      data.type === "chat"
    ) {
      const message = {
        type: "chat",

        id:
          crypto.randomUUID(),

        senderId:
          playerId,

        sender:
          playerName,

        text:
          String(
            data.text || ""
          ).slice(
            0,
            2000
          ),

        time:
          Date.now()
      };

      if (
        !message.text.trim()
      ) {
        return;
      }

      this.broadcast(
        message
      );

      return;
    }

    // -----------------------------
    // TYPING
    // -----------------------------

    if (
      data.type === "typing"
    ) {
      this.broadcast(
        {
          type: "typing",

          senderId:
            playerId,

          sender:
            playerName,

          active:
            Boolean(
              data.active
            )
        },
        connectionId
      );

      return;
    }

    // -----------------------------
    // FRIEND REQUEST
    // -----------------------------

    if (
      data.type ===
      "friend-request"
    ) {
      await this.createFriendRequest(
        playerId,
        playerName,
        String(
          data.targetPlayerId || ""
        )
      );

      return;
    }

    // -----------------------------
    // FRIEND ACCEPT
    // -----------------------------

    if (
      data.type ===
      "friend-accept"
    ) {
      await this.acceptFriendRequest(
        playerId,
        String(
          data.targetPlayerId || ""
        )
      );

      return;
    }

    // -----------------------------
    // FRIEND DECLINE
    // -----------------------------

    if (
      data.type ===
      "friend-decline"
    ) {
      await this.declineFriendRequest(
        playerId,
        String(
          data.targetPlayerId || ""
        )
      );

      return;
    }

    // -----------------------------
    // FRIEND REMOVE
    // -----------------------------

    if (
      data.type ===
      "friend-remove"
    ) {
      await this.removeFriend(
        playerId,
        String(
          data.targetPlayerId || ""
        )
      );

      return;
    }

    // -----------------------------
    // CALL SIGNALING
    // -----------------------------

    if (
      data.type ===
        "call-offer" ||
      data.type ===
        "call-answer" ||
      data.type ===
        "ice-candidate" ||
      data.type ===
        "call-end"
    ) {
      const target =
        this.clients.get(
          data.target
        );

      if (!target) {
        this.send(
          this.clients.get(
            connectionId
          )?.socket,
          {
            type:
              "call-error",
            error:
              "That player is no longer online."
          }
        );

        return;
      }

      this.send(
        target.socket,
        {
          ...data,

          sender:
            connectionId,

          senderPlayerId:
            playerId,

          senderName:
            playerName
        }
      );

      return;
    }

    // -----------------------------
    // PING
    // -----------------------------

    if (
      data.type === "ping"
    ) {
      this.send(
        this.clients.get(
          connectionId
        )?.socket,
        {
          type: "pong",
          time:
            Date.now()
        }
      );

      return;
    }
  }

  // =========================================================
  // SOCIAL API
  // =========================================================

  async handleSocial(
    request,
    url
  ) {
    const path =
      url.pathname;

    // -----------------------------
    // REGISTER / UPDATE PLAYER
    // -----------------------------

    if (
      path ===
        "/social/register" &&
      request.method ===
        "POST"
    ) {
      const body =
        await readJson(
          request
        );

      const playerId =
        String(
          body.playerId || ""
        ).trim();

      const name =
        String(
          body.name || ""
        )
          .trim()
          .slice(0, 24);

      if (
        !playerId ||
        !name
      ) {
        return json(
          {
            ok: false,
            error:
              "Player ID and name are required."
          },
          400
        );
      }

      await this.savePlayer(
        playerId,
        name,
        this.isPlayerOnline(
          playerId
        )
      );

      return json({
        ok: true,
        player: {
          id: playerId,
          name
        }
      });
    }

    // -----------------------------
    // SEARCH PLAYERS
    // -----------------------------

    if (
      path ===
        "/social/search" &&
      request.method ===
        "GET"
    ) {
      const query =
        String(
          url.searchParams.get(
            "q"
          ) || ""
        )
          .trim()
          .toLowerCase();

      const currentId =
        String(
          url.searchParams.get(
            "playerId"
          ) || ""
        );

      if (
        query.length < 1
      ) {
        return json({
          ok: true,
          players: []
        });
      }

      const entries =
        await this.state.storage.list(
          {
            prefix: "player:"
          }
        );

      const players = [];

      for (
        const [
          key,
          player
        ] of entries
      ) {
        if (
          !player ||
          player.id === currentId
        ) {
          continue;
        }

        const lower =
          String(
            player.name || ""
          ).toLowerCase();

        if (
          lower.includes(query)
        ) {
          players.push({
            id:
              player.id,
            name:
              player.name,
            online:
              Boolean(
                player.online
              )
          });
        }

        if (
          players.length >= 20
        ) {
          break;
        }
      }

      return json({
        ok: true,
        players
      });
    }

    // -----------------------------
    // GET FRIENDS
    // -----------------------------

    if (
      path ===
        "/social/friends" &&
      request.method ===
        "GET"
    ) {
      const playerId =
        String(
          url.searchParams.get(
            "playerId"
          ) || ""
        );

      const friends =
        await this.getFriends(
          playerId
        );

      return json({
        ok: true,
        friends
      });
    }

    // -----------------------------
    // GET REQUESTS
    // -----------------------------

    if (
      path ===
        "/social/requests" &&
      request.method ===
        "GET"
    ) {
      const playerId =
        String(
          url.searchParams.get(
            "playerId"
          ) || ""
        );

      const requests =
        await this.getRequests(
          playerId
        );

      return json({
        ok: true,
        requests
      });
    }

    // -----------------------------
    // SEND FRIEND REQUEST
    // -----------------------------

    if (
      path ===
        "/social/friend-request" &&
      request.method ===
        "POST"
    ) {
      const body =
        await readJson(
          request
        );

      const result =
        await this.createFriendRequest(
          String(
            body.fromId || ""
          ),
          String(
            body.fromName || ""
          ),
          String(
            body.toId || ""
          )
        );

      return json(
        result,
        result.ok ? 200 : 400
      );
    }

    // -----------------------------
    // ACCEPT FRIEND REQUEST
    // -----------------------------

    if (
      path ===
        "/social/friend-accept" &&
      request.method ===
        "POST"
    ) {
      const body =
        await readJson(
          request
        );

      const result =
        await this.acceptFriendRequest(
          String(
            body.playerId || ""
          ),
          String(
            body.fromId || ""
          )
        );

      return json(
        result,
        result.ok ? 200 : 400
      );
    }

    // -----------------------------
    // DECLINE REQUEST
    // -----------------------------

    if (
      path ===
        "/social/friend-decline" &&
      request.method ===
        "POST"
    ) {
      const body =
        await readJson(
          request
        );

      const result =
        await this.declineFriendRequest(
          String(
            body.playerId || ""
          ),
          String(
            body.fromId || ""
          )
        );

      return json(
        result,
        result.ok ? 200 : 400
      );
    }

    // -----------------------------
    // REMOVE FRIEND
    // -----------------------------

    if (
      path ===
        "/social/friend-remove" &&
      request.method ===
        "POST"
    ) {
      const body =
        await readJson(
          request
        );

      const result =
        await this.removeFriend(
          String(
            body.playerId || ""
          ),
          String(
            body.friendId || ""
          )
        );

      return json(
        result,
        result.ok ? 200 : 400
      );
    }

    return json(
      {
        ok: false,
        error:
          "Unknown social endpoint."
      },
      404
    );
  }

  // =========================================================
  // SAVE PLAYER
  // =========================================================

  async savePlayer(
    playerId,
    name,
    online
  ) {
    if (!playerId) {
      return;
    }

    const existing =
      await this.state.storage.get(
        "player:" +
          playerId
      );

    await this.state.storage.put(
      "player:" +
        playerId,
      {
        id:
          playerId,

        name:
          name ||
          existing?.name ||
          "Guest",

        online:
          Boolean(
            online
          ),

        lastSeen:
          Date.now()
      }
    );
  }

  // =========================================================
  // GET PLAYER
  // =========================================================

  async getPlayer(
    playerId
  ) {
    if (!playerId) {
      return null;
    }

    return (
      await this.state.storage.get(
        "player:" +
          playerId
      )
    ) || null;
  }

  // =========================================================
  // GET FRIENDS
  // =========================================================

  async getFriends(
    playerId
  ) {
    if (!playerId) {
      return [];
    }

    const ids =
      (
        await this.state.storage.get(
          "friends:" +
            playerId
        )
      ) || [];

    const result = [];

    for (
      const friendId of ids
    ) {
      const friend =
        await this.getPlayer(
          friendId
        );

      if (!friend) {
        continue;
      }

      result.push({
        id:
          friend.id,

        name:
          friend.name,

        online:
          this.isPlayerOnline(
            friend.id
          ),

        lastSeen:
          friend.lastSeen ||
          null
      });
    }

    return result;
  }

  // =========================================================
  // GET FRIEND REQUESTS
  // =========================================================

  async getRequests(
    playerId
  ) {
    if (!playerId) {
      return [];
    }

    return (
      await this.state.storage.get(
        "requests:" +
          playerId
      )
    ) || [];
  }

  // =========================================================
  // CREATE FRIEND REQUEST
  // =========================================================

  async createFriendRequest(
    fromId,
    fromName,
    toId
  ) {
    if (
      !fromId ||
      !toId
    ) {
      return {
        ok: false,
        error:
          "Missing player information."
      };
    }

    if (
      fromId === toId
    ) {
      return {
        ok: false,
        error:
          "You cannot add yourself."
      };
    }

    const from =
      await this.getPlayer(
        fromId
      );

    const to =
      await this.getPlayer(
        toId
      );

    if (!to) {
      return {
        ok: false,
        error:
          "Player not found."
      };
    }

    const existingFriends =
      await this.getFriendIds(
        fromId
      );

    if (
      existingFriends.includes(
        toId
      )
    ) {
      return {
        ok: false,
        error:
          "You are already friends."
      };
    }

    const requests =
      await this.getRequests(
        toId
      );

    const alreadyRequested =
      requests.some(
        request =>
          request.fromId ===
          fromId
      );

    if (
      alreadyRequested
    ) {
      return {
        ok: false,
        error:
          "Friend request already sent."
      };
    }

    const request = {
      id:
        crypto.randomUUID(),

      fromId,

      fromName:
        from?.name ||
        fromName ||
        "Guest",

      createdAt:
        Date.now()
    };

    requests.push(
      request
    );

    await this.state.storage.put(
      "requests:" +
        toId,
      requests
    );

    // Notify recipient instantly.
    this.sendToPlayer(
      toId,
      {
        type:
          "friend-request",
        request
      }
    );

    return {
      ok: true,
      request
    };
  }

  // =========================================================
  // ACCEPT FRIEND REQUEST
  // =========================================================

  async acceptFriendRequest(
    playerId,
    fromId
  ) {
    if (
      !playerId ||
      !fromId
    ) {
      return {
        ok: false,
        error:
          "Missing player information."
      };
    }

    const requests =
      await this.getRequests(
        playerId
      );

    const request =
      requests.find(
        item =>
          item.fromId ===
          fromId
      );

    if (!request) {
      return {
        ok: false,
        error:
          "Friend request not found."
      };
    }

    const player =
      await this.getPlayer(
        playerId
      );

    const friend =
      await this.getPlayer(
        fromId
      );

    if (!friend) {
      return {
        ok: false,
        error:
          "That player no longer exists."
      };
    }

    // Remove request.
    const remaining =
      requests.filter(
        item =>
          item.fromId !==
          fromId
      );

    await this.state.storage.put(
      "requests:" +
        playerId,
      remaining
    );

    // Add both directions.
    await this.addFriendId(
      playerId,
      fromId
    );

    await this.addFriendId(
      fromId,
      playerId
    );

    // Tell both players.
    this.sendToPlayer(
      playerId,
      {
        type:
          "friend-accepted",

        friend: {
          id:
            friend.id,

          name:
            friend.name,

          online:
            this.isPlayerOnline(
              friend.id
            )
        }
      }
    );

    this.sendToPlayer(
      fromId,
      {
        type:
          "friend-accepted",

        friend: {
          id:
            player?.id,

          name:
            player?.name ||
            "Guest",

          online:
            this.isPlayerOnline(
              playerId
            )
        }
      }
    );

    return {
      ok: true
    };
  }

  // =========================================================
  // DECLINE FRIEND REQUEST
  // =========================================================

  async declineFriendRequest(
    playerId,
    fromId
  ) {
    if (
      !playerId ||
      !fromId
    ) {
      return {
        ok: false,
        error:
          "Missing player information."
      };
    }

    const requests =
      await this.getRequests(
        playerId
      );

    const remaining =
      requests.filter(
        item =>
          item.fromId !==
          fromId
      );

    await this.state.storage.put(
      "requests:" +
        playerId,
      remaining
    );

    this.sendToPlayer(
      fromId,
      {
        type:
          "friend-declined",
        playerId
      }
    );

    return {
      ok: true
    };
  }

  // =========================================================
  // REMOVE FRIEND
  // =========================================================

  async removeFriend(
    playerId,
    friendId
  ) {
    if (
      !playerId ||
      !friendId
    ) {
      return {
        ok: false,
        error:
          "Missing player information."
      };
    }

    await this.removeFriendId(
      playerId,
      friendId
    );

    await this.removeFriendId(
      friendId,
      playerId
    );

    this.sendToPlayer(
      friendId,
      {
        type:
          "friend-removed",
        playerId
      }
    );

    return {
      ok: true
    };
  }

  // =========================================================
  // FRIEND ID STORAGE
  // =========================================================

  async getFriendIds(
    playerId
  ) {
    return (
      await this.state.storage.get(
        "friends:" +
          playerId
      )
    ) || [];
  }

  async addFriendId(
    playerId,
    friendId
  ) {
    const friends =
      await this.getFriendIds(
        playerId
      );

    if (
      !friends.includes(
        friendId
      )
    ) {
      friends.push(
        friendId
      );
    }

    await this.state.storage.put(
      "friends:" +
        playerId,
      friends
    );
  }

  async removeFriendId(
    playerId,
    friendId
  ) {
    const friends =
      await this.getFriendIds(
        playerId
      );

    const remaining =
      friends.filter(
        id =>
          id !==
          friendId
      );

    await this.state.storage.put(
      "friends:" +
        playerId,
      remaining
    );
  }

  // =========================================================
  // ONLINE CHECK
  // =========================================================

  isPlayerOnline(
    playerId
  ) {
    return (
      this.getConnectionsForPlayer(
        playerId
      ).length > 0
    );
  }

  // =========================================================
  // GET CONNECTIONS FOR PLAYER
  // =========================================================

  getConnectionsForPlayer(
    playerId
  ) {
    const results = [];

    for (
      const [
        connectionId,
        client
      ] of this.clients
    ) {
      if (
        client.playerId ===
        playerId
      ) {
        results.push({
          connectionId,
          socket:
            client.socket,
          playerId:
            client.playerId,
          name:
            client.name
        });
      }
    }

    return results;
  }

  // =========================================================
  // SEND TO PLAYER
  // =========================================================

  sendToPlayer(
    playerId,
    data
  ) {
    const connections =
      this.getConnectionsForPlayer(
        playerId
      );

    for (
      const connection of
        connections
    ) {
      this.send(
        connection.socket,
        data
      );
    }
  }

  // =========================================================
  // SEND
  // =========================================================

  send(
    socket,
    data
  ) {
    if (!socket) {
      return;
    }

    try {
      socket.send(
        JSON.stringify(
          data
        )
      );
    } catch {
      // Socket closed.
    }
  }

  // =========================================================
  // BROADCAST
  // =========================================================

  broadcast(
    data,
    exceptId = null
  ) {
    for (
      const [
        id,
        client
      ] of this.clients
    ) {
      if (
        id === exceptId
      ) {
        continue;
      }

      this.send(
        client.socket,
        data
      );
    }
  }

  // =========================================================
  // ONLINE PLAYERS
  // =========================================================

  getPlayers() {
    const unique =
      new Map();

    for (
      const [
        connectionId,
        client
      ] of this.clients
    ) {
      if (
        !unique.has(
          client.playerId
        )
      ) {
        unique.set(
          client.playerId,
          {
            id:
              connectionId,

            playerId:
              client.playerId,

            name:
              client.name,

            online:
              true
          }
        );
      }
    }

    return [
      ...unique.values()
    ];
  }
}

// =========================================================
// HELPERS
// =========================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":
      ALLOWED_ORIGIN,

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Max-Age":
      "86400"
  };
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store",

        ...corsHeaders()
      }
    }
  );
}

async function readJson(
  request
) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
