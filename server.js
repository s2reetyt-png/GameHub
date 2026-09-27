const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: true,
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// DATABASE
// ==========================================

const db = new Database("gamehub.db");

db.pragma("journal_mode = WAL");

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// ==========================================
// SERVE GAMEHUB
// ==========================================

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "launch.html")
    );
});

// ==========================================
// USERNAME FILTER
// ==========================================

const blockedWords = [
    "fuck",
    "shit",
    "bitch",
    "asshole",
    "nigger",
    "faggot"
];

function cleanUsername(username) {
    return String(username || "")
        .trim()
        .replace(/\s+/g, "_");
}

function validUsername(username) {

    if (!username) {
        return false;
    }

    if (username.length < 3 || username.length > 20) {
        return false;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return false;
    }

    const lower = username.toLowerCase();

    for (const word of blockedWords) {
        if (lower.includes(word)) {
            return false;
        }
    }

    return true;
}

// ==========================================
// ONLINE USERS
// ==========================================

const onlineUsers = new Map();

// ==========================================
// REGISTER
// ==========================================

app.post("/api/register", (req, res) => {

    let username = cleanUsername(req.body.username);

    if (!validUsername(username)) {
        return res.status(400).json({
            success: false,
            error: "Invalid username."
        });
    }

    try {

        const existing = db
            .prepare("SELECT id FROM users WHERE username = ?")
            .get(username);

        if (!existing) {

            db.prepare(`
                INSERT INTO users (username)
                VALUES (?)
            `).run(username);

        }

        res.json({
            success: true,
            username
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: "Could not create account."
        });
    }
});

// ==========================================
// SEARCH USERS
// ==========================================

app.get("/api/users", (req, res) => {

    const search = String(req.query.search || "").trim();

    try {

        const users = db.prepare(`
            SELECT username
            FROM users
            WHERE username LIKE ?
            ORDER BY username
            LIMIT 50
        `).all(`%${search}%`);

        res.json(users);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Could not load users."
        });
    }
});

// ==========================================
// MESSAGE HISTORY
// ==========================================

app.get("/api/messages", (req, res) => {

    const user1 = String(req.query.user1 || "");
    const user2 = String(req.query.user2 || "");

    if (!user1 || !user2) {
        return res.json([]);
    }

    try {

        const messages = db.prepare(`
            SELECT
                sender,
                receiver,
                message,
                created_at
            FROM messages
            WHERE
                (sender = ? AND receiver = ?)
                OR
                (sender = ? AND receiver = ?)
            ORDER BY id ASC
            LIMIT 500
        `).all(
            user1,
            user2,
            user2,
            user1
        );

        res.json(messages);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Could not load messages."
        });
    }
});

// ==========================================
// SOCKET.IO
// ==========================================

io.on("connection", (socket) => {

    console.log("User connected:", socket.id);

    // --------------------------------------
    // LOGIN
    // --------------------------------------

    socket.on("login", (username) => {

        username = cleanUsername(username);

        if (!validUsername(username)) {
            return;
        }

        socket.username = username;

onlineUsers.set(username, socket.id);

socket.join(`user:${username}`);

io.emit("user-online", {
    username
});

// Send live player count to everybody
io.emit("player-count", onlineUsers.size);

io.emit("online-users",
    Array.from(onlineUsers.keys())
);

    // --------------------------------------
    // SEND MESSAGE
    // --------------------------------------

    socket.on("send-message", (data) => {

        if (!socket.username) {
            return;
        }

        const receiver = cleanUsername(data?.receiver);
        const message = String(data?.message || "").trim();

        if (!receiver || !message) {
            return;
        }

        if (message.length > 2000) {
            return;
        }

        try {

            db.prepare(`
                INSERT INTO messages
                (sender, receiver, message)
                VALUES (?, ?, ?)
            `).run(
                socket.username,
                receiver,
                message
            );

        } catch (error) {

            console.error(error);
            return;
        }

        const messageData = {
            sender: socket.username,
            receiver,
            message,
            created_at: new Date().toISOString()
        };

        io.to(`user:${socket.username}`)
            .emit("new-message", messageData);

        io.to(`user:${receiver}`)
            .emit("new-message", messageData);
    });

    // --------------------------------------
    // CALL USER
    // --------------------------------------

    socket.on("call-user", (data) => {

        if (!socket.username) {
            return;
        }

        const receiver = cleanUsername(data?.receiver);
        const targetSocket = onlineUsers.get(receiver);

        if (!targetSocket) {
            socket.emit("call-failed", {
                reason: "User is offline."
            });

            return;
        }

        io.to(targetSocket).emit("incoming-call", {
            caller: socket.username
        });
    });

    // --------------------------------------
    // ACCEPT CALL
    // --------------------------------------

    socket.on("call-accepted", (data) => {

        const caller = cleanUsername(data?.caller);
        const targetSocket = onlineUsers.get(caller);

        if (!targetSocket) {
            return;
        }

        io.to(targetSocket).emit("call-accepted", {
            username: socket.username
        });
    });

    // --------------------------------------
    // DECLINE CALL
    // --------------------------------------

    socket.on("call-declined", (data) => {

        const caller = cleanUsername(data?.caller);
        const targetSocket = onlineUsers.get(caller);

        if (!targetSocket) {
            return;
        }

        io.to(targetSocket).emit("call-declined", {
            username: socket.username
        });
    });

    // --------------------------------------
    // WEBRTC OFFER
    // --------------------------------------

    socket.on("webrtc-offer", (data) => {

        const target = onlineUsers.get(
            cleanUsername(data?.target)
        );

        if (!target) {
            return;
        }

        io.to(target).emit("webrtc-offer", {
            from: socket.username,
            offer: data.offer
        });
    });

    // --------------------------------------
    // WEBRTC ANSWER
    // --------------------------------------

    socket.on("webrtc-answer", (data) => {

        const target = onlineUsers.get(
            cleanUsername(data?.target)
        );

        if (!target) {
            return;
        }

        io.to(target).emit("webrtc-answer", {
            from: socket.username,
            answer: data.answer
        });
    });

    // --------------------------------------
    // ICE CANDIDATES
    // --------------------------------------

    socket.on("webrtc-ice", (data) => {

        const target = onlineUsers.get(
            cleanUsername(data?.target)
        );

        if (!target) {
            return;
        }

        io.to(target).emit("webrtc-ice", {
            from: socket.username,
            candidate: data.candidate
        });
    });

    // --------------------------------------
    // END CALL
    // --------------------------------------

    socket.on("end-call", (data) => {

        const target = onlineUsers.get(
            cleanUsername(data?.target)
        );

        if (!target) {
            return;
        }

        io.to(target).emit("call-ended", {
            username: socket.username
        });
    });

    // --------------------------------------
    // DISCONNECT
    // --------------------------------------

    socket.on("disconnect", () => {

        onlineUsers.delete(socket.username);

io.emit("user-offline", {
    username: socket.username
});

// Update everybody's live player count
io.emit("player-count", onlineUsers.size);

io.emit("online-users",
    Array.from(onlineUsers.keys())
);
}

        console.log("Disconnected:", socket.id);
    });
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 3002;

server.listen(PORT, "0.0.0.0", () => {

    console.log(`
========================================
             GAMEHUB
========================================

GameHub server is running!

Local:
http://localhost:${PORT}

Ready for players.
========================================
`);
});
