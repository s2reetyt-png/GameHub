export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -----------------------------
    // HEALTH CHECK
    // -----------------------------
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "GameHub Backend",
        time: new Date().toISOString()
      });
    }

    // -----------------------------
    // CREATE ANONYMOUS SESSION
    // -----------------------------
    if (url.pathname === "/api/session" && request.method === "POST") {
      const id = crypto.randomUUID();

      return json({
        ok: true,
        player: {
          id,
          name: "Player-" + id.slice(0, 5)
        }
      });
    }

    // -----------------------------
    // WEBSOCKET
    // -----------------------------
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({
          ok: false,
          error: "WebSocket connection required"
        }, 400);
      }

      const room = url.searchParams.get("room") || "main";
      const name = url.searchParams.get("name") || "Player";

      const id = env.GAMEHUB_ROOM.idFromName(room);
      const stub = env.GAMEHUB_ROOM.get(id);

      const newUrl = new URL(request.url);
      newUrl.searchParams.set("playerName", name);

      return stub.fetch(new Request(newUrl, request));
    }

    // -----------------------------
    // DUCKDUCKGO SEARCH
    // -----------------------------
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q");

      if (!query) {
        return json({
          ok: false,
          error: "Missing search query"
        }, 400);
      }

      return Response.redirect(
        "https://duckduckgo.com/?q=" + encodeURIComponent(query),
        302
      );
    }

    // -----------------------------
    // STATIC WEBSITE
    // -----------------------------
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("GameHub backend is running.", {
      status: 200,
      headers: {
        "content-type": "text/plain"
      }
    });
  }
};


// ============================================================
// GAMEHUB ROOM
// ============================================================

export class GameHubRoom {

  constructor(state) {
    this.state = state;
    this.clients = new Map();
  }

  async fetch(request) {

    const upgrade = request.headers.get("Upgrade");

    if (upgrade !== "websocket") {
      return new Response("GameHub Room Online", {
        status: 200
      });
    }

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    const url = new URL(request.url);

    const playerName =
      url.searchParams.get("playerName") || "Player";

    const playerId =
      crypto.randomUUID();

    server.accept();

    this.clients.set(playerId, {
      socket: server,
      name: playerName
    });

    // Tell the new player they joined
    this.send(server, {
      type: "connected",
      id: playerId,
      name: playerName
    });

    // Tell everyone about the new player
    this.broadcast({
      type: "presence",
      action: "join",
      id: playerId,
      name: playerName
    }, playerId);

    // Send current online list
    this.send(server, {
      type: "online",
      players: this.getPlayers()
    });

    server.addEventListener("message", event => {
      this.handleMessage(
        playerId,
        playerName,
        event.data
      );
    });

    server.addEventListener("close", () => {
      this.clients.delete(playerId);

      this.broadcast({
        type: "presence",
        action: "leave",
        id: playerId,
        name: playerName
      });
    });

    server.addEventListener("error", () => {
      this.clients.delete(playerId);

      this.broadcast({
        type: "presence",
        action: "leave",
        id: playerId,
        name: playerName
      });
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  // ==========================================================
  // MESSAGE HANDLER
  // ==========================================================

  async handleMessage(senderId, senderName, raw) {

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // -----------------------------
    // CHAT
    // -----------------------------
    if (data.type === "chat") {

      const message = {
        type: "chat",
        id: crypto.randomUUID(),
        senderId,
        sender: senderName,
        text: String(data.text || "").slice(0, 2000),
        time: Date.now()
      };

      if (!message.text.trim()) return;

      this.broadcast(message);
      return;
    }


    // -----------------------------
    // TYPING
    // -----------------------------
    if (data.type === "typing") {

      this.broadcast({
        type: "typing",
        senderId,
        sender: senderName,
        active: Boolean(data.active)
      }, senderId);

      return;
    }


    // -----------------------------
    // WEBRTC SIGNALING
    // -----------------------------
    if (
      data.type === "call-offer" ||
      data.type === "call-answer" ||
      data.type === "ice-candidate" ||
      data.type === "call-end"
    ) {

      const target = this.clients.get(data.target);

      if (!target) {
        this.send(
          this.clients.get(senderId)?.socket,
          {
            type: "call-error",
            error: "Player is no longer online."
          }
        );

        return;
      }

      this.send(target.socket, {
        ...data,
        sender: senderId,
        senderName
      });

      return;
    }


    // -----------------------------
    // PING
    // -----------------------------
    if (data.type === "ping") {

      this.send(
        this.clients.get(senderId)?.socket,
        {
          type: "pong",
          time: Date.now()
        }
      );

      return;
    }
  }


  // ==========================================================
  // SEND
  // ==========================================================

  send(socket, data) {

    if (!socket) return;

    try {
      socket.send(JSON.stringify(data));
    } catch {
      // Socket already closed.
    }
  }


  // ==========================================================
  // BROADCAST
  // ==========================================================

  broadcast(data, exceptId = null) {

    for (const [id, client] of this.clients) {

      if (id === exceptId) continue;

      this.send(client.socket, data);
    }
  }


  // ==========================================================
  // PLAYER LIST
  // ==========================================================

  getPlayers() {

    return [...this.clients.entries()].map(
      ([id, client]) => ({
        id,
        name: client.name
      })
    );
  }
};


// ============================================================
// JSON HELPER
// ============================================================

function json(data, status = 200) {

  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}
